import postgres from "postgres";
import { withTenant, getDbUrl } from "@casefile/db";

/**
 * BIGDATA-4 progress (plan section 16, E): what a run has done and has left, read from the matter's
 * database only (the queue, the workers' heartbeats, the decisions), so it works while the run goes
 * (from any machine that can reach the database) and after it.
 *
 * A top-level object is one object triage decided to ingest: a file, or a mailbox (done when its last
 * part and its summary are written). Bytes: a file's size when it is done; a mailbox's size in
 * proportion to its parts done. The rate is over the last 5 minutes (the database clock), or since the
 * queue was built when less than that has passed; the time left is the bytes left at that rate, an
 * estimate.
 */

export interface RunStatus {
  runId: string;
  source: string;
  state: "triaging" | "running" | "stopped" | "finished" | "finished-with-failures";
  startedAt: Date;
  finishedAt: Date | null;
  elapsedSeconds: number;
  top: { total: number; done: number; failed: number; left: number };
  bytes: { total: number; done: number; left: number };
  messages: { read: number; partsDone: number; partsTotal: number };
  rate: { windowSeconds: number; bytesPerSecond: number; itemsPerSecond: number; messagesPerSecond: number };
  /** An estimate: the bytes left at the recent rate; 0 when finished, null when there is no rate yet. */
  etaSeconds: number | null;
  failed: Array<{ id: string; path: string; kind: string; part: number; attempts: number; error: string }>;
  workers: Array<{ name: string; host: string | null; pid: number | null; state: string; activity: string | null; lastSeenSeconds: number; alive: boolean; itemsDone: number; rssMb: number | null }>;
  outcomes: { indexed: number; needs_ocr: number; stored_unparsed: number; unprocessable: number; kept: number; skipped: Record<string, number>; near_duplicates: number; failures_listed: number };
}

const RATE_WINDOW_SECONDS = 300;
/** A worker whose last heartbeat is older than this is taken as gone (its heartbeat beats every second). */
const ALIVE_SECONDS = 30;

interface ItemRow {
  id: string;
  top_seq: number;
  part_no: number;
  kind: string;
  state: string;
  path: string;
  byte_size: number;
  spec: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  finished_ago: number | null;
}

export async function getRunStatus(options: { runId: string; tenantId?: string | undefined; dbUrl?: string | undefined }): Promise<RunStatus> {
  const tenantId = options.tenantId || process.env.MATTER_TENANT_ID;
  if (!tenantId) throw new Error("Tenant ID is required: set MATTER_TENANT_ID in the matter environment.");
  const db = postgres(options.dbUrl || getDbUrl(), { max: 1 });
  try {
    return await withTenant(tenantId, async (tx) => {
      const runs = await tx<{ source: string; started_at: Date; triaged_at: Date | null; queued_at: Date | null; finished_at: Date | null; elapsed: number; queued_ago: number | null }[]>`
        SELECT source, started_at, triaged_at, queued_at, finished_at,
               EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::float8 AS elapsed,
               EXTRACT(EPOCH FROM (NOW() - queued_at))::float8 AS queued_ago
        FROM ingest_runs WHERE id = ${options.runId} AND tenant_id = ${tenantId}`;
      const run = runs[0];
      if (!run) throw new Error(`Run ${options.runId} not found in this matter`);
      const items = await tx<ItemRow[]>`
        SELECT id, top_seq, part_no, kind, state, path, byte_size::float8 AS byte_size, spec, attempts, last_error, result,
               EXTRACT(EPOCH FROM (NOW() - finished_at))::float8 AS finished_ago
        FROM ingest_work WHERE tenant_id = ${tenantId} AND run_id = ${options.runId} ORDER BY top_seq, part_no`;
      const workers = await tx<{ name: string; host: string | null; pid: number | null; state: string; activity: string | null; seen: number; stopped: boolean; items_done: number; rss_mb: number | null }[]>`
        SELECT name, host, pid, state, activity, EXTRACT(EPOCH FROM (NOW() - heartbeat_at))::float8 AS seen, stopped_at IS NOT NULL AS stopped, items_done, rss_mb
        FROM ingest_workers WHERE tenant_id = ${tenantId} AND run_id = ${options.runId} ORDER BY started_at, name`;
      const skips = await tx<{ k: string; n: number }[]>`
        SELECT decision || ':' || coalesce(rule, '') AS k, count(*)::int AS n FROM ingest_decisions
        WHERE tenant_id = ${tenantId} AND run_id = ${options.runId} AND decision <> 'ingest' GROUP BY 1 ORDER BY 1`;
      const extra = (await tx<{ kept: number; near: number; failures: number }[]>`
        SELECT (SELECT count(*)::int FROM ingest_nodes n JOIN ingest_work w ON w.id = n.work_id
                 WHERE n.tenant_id = ${tenantId} AND n.run_id = ${options.runId} AND n.decision = 'ingest'
                   AND (w.state = 'done' OR n.entry_index < w.progress)) AS kept,
               (SELECT count(*)::int FROM document_fingerprints WHERE tenant_id = ${tenantId} AND run_id = ${options.runId} AND near_duplicate_of IS NOT NULL) AS near,
               (SELECT count(*)::int FROM ingest_nodes WHERE tenant_id = ${tenantId} AND run_id = ${options.runId} AND decision = 'error') AS failures`)[0]!;

      // Top-level objects, bytes, messages.
      const byTop = new Map<number, ItemRow[]>();
      for (const i of items) (byTop.get(i.top_seq) ?? byTop.set(i.top_seq, []).get(i.top_seq)!).push(i);
      let total = 0, done = 0, failed = 0, bytesTotal = 0, bytesDone = 0, messages = 0, partsDone = 0, partsTotal = 0;
      let recentBytes = 0, recentItems = 0, recentMessages = 0;
      const outcomes = { indexed: 0, needs_ocr: 0, stored_unparsed: 0, unprocessable: 0 };
      const recent = (ago: number | null) => ago !== null && ago <= RATE_WINDOW_SECONDS;
      for (const group of byTop.values()) {
        const head = group.find((g) => g.part_no === 0)!;
        const parts = group.filter((g) => g.kind === "mailbox-part");
        const finish = group.find((g) => g.kind === "mailbox-finish");
        total++;
        bytesTotal += head.byte_size;
        const status = String((finish?.state === "done" ? finish.result?.status : head.result?.status) ?? "");
        const isDone = head.kind === "file" ? head.state === "done" : head.state === "done" && (finish ? finish.state === "done" : status !== "processing");
        const isFailed = head.state === "failed" || finish?.state === "failed";
        if (isFailed) failed++;
        else if (isDone) {
          done++;
          if (status in outcomes) outcomes[status as keyof typeof outcomes]++;
        }
        if (parts.length > 0) {
          partsTotal += parts.length;
          const per = head.byte_size / parts.length;
          for (const p of parts) {
            const read = Number(p.result?.messages_read ?? 0);
            messages += read;
            if (p.state === "done") {
              partsDone++;
              bytesDone += per;
              if (recent(p.finished_ago)) {
                recentBytes += per;
                recentMessages += read;
              }
            }
          }
          if (isDone && recent(finish?.finished_ago ?? head.finished_ago)) recentItems++;
        } else if (isDone) {
          bytesDone += head.byte_size;
          if (recent(head.finished_ago)) {
            recentBytes += head.byte_size;
            recentItems++;
          }
        }
      }
      const finished = run.finished_at !== null;
      const since = Math.max(1, Math.min(RATE_WINDOW_SECONDS, run.queued_ago ?? run.elapsed));
      const rate = {
        windowSeconds: Math.round(since),
        bytesPerSecond: recentBytes / since,
        itemsPerSecond: recentItems / since,
        messagesPerSecond: recentMessages / since,
      };
      const left = Math.max(0, bytesTotal - bytesDone);
      const alive = workers.map((w) => !w.stopped && w.seen <= ALIVE_SECONDS);
      const failedItems = items.filter((i) => i.state === "failed").map((i) => ({ id: i.id, path: i.path, kind: i.kind, part: i.part_no, attempts: i.attempts, error: i.last_error ?? "" }));
      const state: RunStatus["state"] = !run.triaged_at || !run.queued_at
        ? "triaging"
        : finished
        ? failedItems.length > 0 ? "finished-with-failures" : "finished"
        : alive.some(Boolean) ? "running" : "stopped";
      return {
        runId: options.runId,
        source: run.source,
        state,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        elapsedSeconds: run.elapsed,
        top: { total, done, failed, left: Math.max(0, total - done - failed) },
        bytes: { total: bytesTotal, done: Math.round(bytesDone), left: Math.round(left) },
        messages: { read: messages, partsDone, partsTotal },
        rate,
        etaSeconds: finished ? 0 : rate.bytesPerSecond > 0 ? left / rate.bytesPerSecond : null,
        failed: failedItems,
        workers: workers.map((w, i) => ({ name: w.name, host: w.host, pid: w.pid, state: w.state, activity: w.activity, lastSeenSeconds: Math.round(w.seen), alive: alive[i]!, itemsDone: w.items_done, rssMb: w.rss_mb })),
        outcomes: { ...outcomes, kept: extra.kept, skipped: Object.fromEntries(skips.map((s) => [s.k, s.n])), near_duplicates: extra.near, failures_listed: extra.failures + failedItems.length },
      };
    });
  } finally {
    await db.end();
  }
}

const mb = (n: number) => `${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "-");
function duration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s % 60} s` : `${s % 60} s`;
}

export function formatRunStatus(s: RunStatus): string {
  const lines = [
    "================================================================================",
    `RUN ${s.runId}: ${s.state}`,
    `  Source:            ${s.source}`,
    `  Started:           ${s.startedAt.toISOString()}${s.finishedAt ? `   finished ${s.finishedAt.toISOString()}` : ""}   (${duration(s.elapsedSeconds)})`,
    `  Files:             ${s.top.done} of ${s.top.total} done, ${s.top.left} left, ${s.top.failed} failed`,
    `  Bytes:             ${mb(s.bytes.done)} of ${mb(s.bytes.total)} done (${pct(s.bytes.done, s.bytes.total)}), ${mb(s.bytes.left)} left`,
    `  Messages read:     ${s.messages.read.toLocaleString("en-US")}${s.messages.partsTotal ? ` (mailbox parts ${s.messages.partsDone} of ${s.messages.partsTotal} done)` : ""}`,
    `  Rate (last ${duration(s.rate.windowSeconds)}): ${(s.rate.bytesPerSecond / 1e6).toFixed(2)} MB/s, ${s.rate.itemsPerSecond.toFixed(2)} files/s, ${s.rate.messagesPerSecond.toFixed(2)} messages/s`,
    `  Time left:         ${s.etaSeconds === null ? "not known yet (nothing finished recently)" : `${duration(s.etaSeconds)} (an estimate, at the recent rate)`}`,
    `  Kept/skipped:      indexed ${s.outcomes.indexed}, needs_ocr ${s.outcomes.needs_ocr}, stored_unparsed ${s.outcomes.stored_unparsed}, unprocessable ${s.outcomes.unprocessable} (top-level); ${s.outcomes.kept} sources kept in all; ${s.outcomes.near_duplicates} near-duplicates grouped`,
    ...Object.entries(s.outcomes.skipped).map(([k, n]) => `      ${String(n).padStart(7)}  ${k.replace(":", " (")}${k.includes(":") ? ")" : ""}`),
    `  Failed items (${s.failed.length}):${s.failed.length ? "" : " none"}`,
    ...s.failed.map((f) => `      ${f.path}${f.kind === "mailbox-part" ? ` (part ${f.part})` : ""} — ${f.error} (${f.attempts} attempts)`),
    `  Workers (${s.workers.length}, ${s.workers.filter((w) => w.alive).length} alive):`,
    ...s.workers.map((w) => `      ${w.name} ${w.host ? `on ${w.host} ` : ""}pid ${w.pid ?? "?"} [${w.alive ? w.state : w.state === "stopped" ? "stopped" : "gone"}] ${w.activity ?? ""} (seen ${w.lastSeenSeconds} s ago; ${w.itemsDone} items${w.rssMb ? `; ${w.rssMb} MB` : ""})`),
    "================================================================================",
  ];
  return lines.join("\n");
}
