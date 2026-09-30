import type postgres from "postgres";
import { withTenant, type Tx } from "@casefile/db";
import type { RecordContext } from "./triage.js";

/**
 * BIGDATA-4: a run is finished when every item of its queue is done or failed and every document it
 * wrote has been through the near-duplicate pass. Whichever worker sees that first writes the run's
 * counters (ingest_runs.counters.ingest and .mailboxes, as BIGDATA-3 and 3B did) and finished_at,
 * once (an advisory lock and a re-check). `pnpm ingest:retry` opens a run again.
 */

type TopResult = { status?: string; mailbox?: Record<string, unknown> } | null;

/** The run's outcome counters, from its triage decisions and its items' results. */
export async function runCounters(tx: Tx, rec: RecordContext, runId: string): Promise<Record<string, unknown>> {
  const t = rec.resolvedTenantId;
  const triage = (await tx<{ objects: number; skipped: number }[]>`
    SELECT count(*)::int AS objects, count(*) FILTER (WHERE decision <> 'ingest')::int AS skipped
    FROM ingest_decisions WHERE tenant_id = ${t} AND run_id = ${runId} AND stage = 'triage'`)[0]!;
  const items = await tx<{ top_seq: number; part_no: number; kind: string; state: string; path: string; result: TopResult }[]>`
    SELECT top_seq, part_no, kind, state, path, result FROM ingest_work
    WHERE tenant_id = ${t} AND run_id = ${runId} AND (part_no = 0 OR kind = 'mailbox-finish')
    ORDER BY top_seq, part_no`;
  const heads = new Map<number, (typeof items)[number]>();
  const finishes = new Map<number, (typeof items)[number]>();
  for (const i of items) (i.kind === "mailbox-finish" ? finishes : heads).set(i.top_seq, i);
  const c = { indexed: 0, needs_ocr: 0, stored_unparsed: 0, skipped: triage.skipped, failed: 0 };
  const mailboxes: Array<Record<string, unknown>> = [];
  for (const [seq, h] of [...heads].sort((a, b) => a[0] - b[0])) {
    let status = h.state === "failed" ? "failed" : String(h.result?.status ?? "");
    let mailbox = h.result?.mailbox;
    if (h.kind === "mailbox" && status === "processing") {
      const f = finishes.get(seq);
      status = f?.state === "done" ? String(f.result?.status ?? "indexed") : f?.state === "failed" ? "failed" : "processing";
      mailbox = f?.result?.mailbox;
    }
    if (status === "indexed") c.indexed++;
    else if (status === "needs_ocr") c.needs_ocr++;
    else if (status === "stored_unparsed") c.stored_unparsed++;
    else if (status === "skipped") c.skipped++;
    else if (status === "failed" || status === "unprocessable") c.failed++;
    if (mailbox && typeof mailbox === "object") {
      const m = mailbox as { errors?: unknown[]; seconds?: number };
      mailboxes.push({ path: h.path, ...mailbox, errors: Array.isArray(m.errors) ? m.errors.slice(0, 20) : [], seconds: Math.round(Number(m.seconds ?? 0) * 10) / 10 });
    }
  }
  const near = (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM document_fingerprints WHERE tenant_id = ${t} AND run_id = ${runId} AND near_duplicate_of IS NOT NULL`)[0]!.n;
  const workers = await tx<{ stats: { nearDuplicateMs?: number } | null }[]>`SELECT stats FROM ingest_workers WHERE tenant_id = ${t} AND run_id = ${runId}`;
  const run = (await tx<{ counters: { triage?: { ms?: number } } | null }[]>`SELECT counters FROM ingest_runs WHERE id = ${runId} AND tenant_id = ${t}`)[0];
  return {
    ingest: {
      top_level_objects: triage.objects,
      admitted: c.indexed + c.needs_ocr + c.stored_unparsed,
      indexed: c.indexed,
      needs_ocr: c.needs_ocr,
      stored_unparsed: c.stored_unparsed,
      skipped: c.skipped,
      failed: c.failed,
      near_duplicates: near,
      near_duplicate_ms: Math.round(workers.reduce((s, w) => s + Number(w.stats?.nearDuplicateMs ?? 0), 0)),
      triage_ms: Math.round(Number(run?.counters?.triage?.ms ?? 0)),
      workers: workers.length,
    },
    ...(mailboxes.length ? { mailboxes } : {}),
  };
}

/** Finishes the run if nothing is left to do. True when the run is finished (by this call or before). */
export async function finalizeRunIfComplete(db: postgres.Sql, rec: RecordContext, runId: string): Promise<boolean> {
  const t = rec.resolvedTenantId;
  const s = (await withTenant(t, (tx) => tx<{ queued: boolean; finished: boolean; open: boolean }[]>`
    SELECT r.queued_at IS NOT NULL AS queued, r.finished_at IS NOT NULL AS finished,
           EXISTS (SELECT 1 FROM ingest_work w WHERE w.tenant_id = r.tenant_id AND w.run_id = r.id AND w.state IN ('pending', 'discovered', 'sequenced')) AS open
    FROM ingest_runs r WHERE r.id = ${runId} AND r.tenant_id = ${t}`, db))[0];
  if (!s || !s.queued || s.open) return false;
  if (s.finished) return true;
  // Every item is done or failed: the run is finished once its last documents are grouped.
  const unindexed = (await withTenant(t, (tx) => tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ingest_signatures s WHERE s.tenant_id = ${t} AND s.run_id = ${runId}
      AND NOT EXISTS (SELECT 1 FROM document_fingerprints f WHERE f.tenant_id = s.tenant_id AND f.content_document_id = s.content_document_id)`, db))[0]!.n;
  if (unindexed > 0) return false;
  await withTenant(t, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`casefile-finish:${runId}`}, 0))`;
    const again = await tx<{ finished: boolean }[]>`SELECT finished_at IS NOT NULL AS finished FROM ingest_runs WHERE id = ${runId} AND tenant_id = ${t} FOR UPDATE`;
    if (again[0]?.finished) return;
    const counters = await runCounters(tx, rec, runId);
    await tx`UPDATE ingest_runs SET finished_at = NOW(), counters = counters || ${tx.json(JSON.parse(JSON.stringify(counters)))} WHERE id = ${runId} AND tenant_id = ${t}`;
  }, db);
  return true;
}
