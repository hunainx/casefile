import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import postgres from "postgres";
import { withTenant, getDbUrl, type Tx } from "@casefile/db";
import { auditChainStats, auditChainTakenAt } from "@casefile/audit";
import { computeSha256, downloadBucketObject, sha256OfBucketObject, sha256OfFile } from "@casefile/storage";
import { parseArgs, loadEnv } from "./args.js";
import { recordToFilters } from "./triage-rules.js";
import { assertBucketBoundToMatter, resolveRecordContext, type RecordContext } from "./triage.js";
import {
  DEFAULT_MAX_PARSE_BYTES,
  discardPending,
  flushPending,
  openRunState,
  processSingleItem,
  recordNotIngested,
  type IngestFileResult,
  type IngestItemContext,
  type RunState,
} from "./ingest.js";
import { discoverNode, loadDecisions, publishNodes } from "./discover.js";
import { preorder, type PlanNode } from "./plan.js";
import {
  claimItem,
  enqueueRun,
  failExhaustedItem,
  leaseSecondsFromEnv,
  LeaseLostError,
  markDone,
  PermanentItemError,
  readItem,
  recordAttemptError,
  registerWorker,
  releaseItem,
  renewLease,
  viewOf,
  withFence,
  type WorkItem,
  type WorkItemView,
} from "./queue.js";
import { advanceSequencer, rewindAfterFailure } from "./sequencer.js";
import { advanceNearDuplicates, newPassCursor } from "./near-duplicate-pass.js";
import { MailboxFiles, discoverMailboxPart, headOf, writeMailboxFinish, writeMailboxHead, writeMailboxPart } from "./mailbox-ingest.js";
import { DEFAULT_MBOX_PART_BYTES, DEFAULT_PST_PART_MESSAGES, type RunInfo, type RunOptions, type WorkEnv, type WorkerActivity } from "./work-env.js";
import { finalizeRunIfComplete } from "./run-finish.js";
import { deferAuditRows, flushAuditRows } from "./audit-buffer.js";

/**
 * BIGDATA-4 worker (plan section 16): one process (or, in tests and `--workers 1`, one loop in the
 * CLI's process) that works a run's queue until the run is finished.
 *
 *   claim the earliest item it can  ->  discover what it holds  ->  wait until the sequencer has
 *   decided it (running the sequencer itself meanwhile)  ->  wait until every earlier copy it names is
 *   written  ->  write it behind the fence  ->  run the near-duplicate pass  ->  next item
 *
 * While it waits it gives its item back if an earlier item is waiting for a worker (a stopped
 * worker's item, or the parts of a mailbox just split), so the workers of a run can never all be
 * waiting for an item nobody works on. A heartbeat renews its lease and says what it is doing
 * (ingest_workers). The run is finished by whichever worker sees that nothing is left.
 *
 *   pnpm ingest:worker --run <run id> [--name <name>] [--stats-file <path>]
 */

export interface WorkerHooks {
  /** When an item's discovery is done, before its nodes are recorded (tests slow an item's discovery down here). */
  afterDiscover?: ((item: WorkItemView) => Promise<void> | void) | undefined;
  /** Once the item is decided, before it waits for earlier copies and writes (tests hold items here). */
  beforeWrite?: ((item: WorkItemView) => Promise<void> | void) | undefined;
  /** Inside the item's write transaction (tests throw here to fail an item). */
  duringWrite?: ((item: WorkItemView) => Promise<void> | void) | undefined;
}

export interface WorkerOptions {
  runId: string;
  tenantId?: string | undefined;
  dbUrl?: string | undefined;
  name?: string | undefined;
  leaseSeconds?: number | undefined;
  heartbeatMs?: number | undefined;
  pollMs?: number | undefined;
  hooks?: WorkerHooks | undefined;
  /** Results of top-level objects by their place in reading order (shared by in-process workers; none kept without it). */
  results?: Map<number, IngestFileResult> | undefined;
  onMailboxProgress?: ((path: string, messagesRead: number) => void) | undefined;
}

export interface WorkerReport {
  workerId: string;
  name: string;
  itemsDone: number;
  attemptsFailed: number;
  leasesLost: number;
  released: number;
  /** Plan answer 10: the audit rows this process chained, the time it waited for the chain head, the time its write transactions held it. */
  chain: { rows: number; waitMs: number; holdMs: number; transactions: number };
  nearDuplicateMs: number;
  /** Where this worker's time went (ms): claiming, reading and discovering, recording nodes, waiting for the sequencer, waiting for earlier copies, writing, the near-duplicate pass, idle. */
  phases: Record<string, number>;
  peakRssMb: number;
  seconds: number;
}

/** Thrown to go back to claiming: the worker gave its item back for an earlier one. */
class ItemReleased extends Error {
  constructor() {
    super("item given back for an earlier one");
    this.name = "ItemReleased";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadRunInfo(db: postgres.Sql, tenantId: string, runId: string): Promise<{ info: RunInfo; investigationId: string; startedBy: string | null; queued: boolean }> {
  const rows = await withTenant(tenantId, (tx) => tx<{ investigation_id: string; source_kind: "folder" | "bucket"; source: string; filters: unknown; options: unknown; started_by: string | null; queued_at: Date | null; triaged_at: Date | null }[]>`
    SELECT investigation_id, source_kind, source, filters, options, started_by, queued_at, triaged_at FROM ingest_runs WHERE id = ${runId} AND tenant_id = ${tenantId}`, db);
  const r = rows[0];
  if (!r) throw new Error(`Run ${runId} not found in this matter`);
  if (!r.triaged_at) throw new Error(`Run ${runId} was stopped before its triage finished: it has no queue. Start the ingest again (a new run); this run's decisions stay listed.`);
  const o = (r.options && typeof r.options === "object" ? r.options : {}) as Partial<RunOptions>;
  const options: RunOptions = {
    max_parse_bytes: Number(o.max_parse_bytes ?? DEFAULT_MAX_PARSE_BYTES),
    ...(o.zip ? { zip: o.zip } : {}),
    pst_part_messages: Number(o.pst_part_messages ?? DEFAULT_PST_PART_MESSAGES),
    mbox_part_bytes: Number(o.mbox_part_bytes ?? DEFAULT_MBOX_PART_BYTES),
  };
  const bucket = r.source_kind === "bucket" ? (/^gs:\/\/([^/]+)/.exec(r.source)?.[1] ?? null) : null;
  if (bucket) assertBucketBoundToMatter(bucket);
  const filters = recordToFilters(r.filters && typeof r.filters === "object" ? (r.filters as Record<string, string | string[]>) : {});
  const info: RunInfo = {
    runId, sourceKind: r.source_kind, bucket, filters, options,
    bucketSources: bucket ?? (process.env.GCS_BUCKET_SOURCES || "sources"),
    bucketArtifacts: process.env.GCS_BUCKET_ARTIFACTS || "artifacts",
  };
  return { info, investigationId: r.investigation_id, startedBy: r.started_by, queued: r.queued_at !== null };
}

export async function runWorker(opts: WorkerOptions): Promise<WorkerReport> {
  const started = performance.now();
  const tenantId = opts.tenantId || process.env.MATTER_TENANT_ID;
  if (!tenantId) throw new Error("Tenant ID is required: set MATTER_TENANT_ID in the matter environment.");
  const name = opts.name ?? `worker-${process.pid}`;
  const leaseSeconds = opts.leaseSeconds ?? leaseSecondsFromEnv();
  const heartbeatMs = opts.heartbeatMs ?? Number(process.env.INGEST_HEARTBEAT_MS ?? 5000);
  const pollMs = opts.pollMs ?? 50;
  const hooks = opts.hooks ?? {};
  // Only an in-process caller (the one-process ingest's summary) collects results; a worker process keeps none,
  // so its memory does not grow with the run (it did: a result a top-level object, measured at 10 GB).
  const results = opts.results;
  const db = postgres(opts.dbUrl || getDbUrl(), { max: 4 });
  const report: WorkerReport = {
    workerId: "", name, itemsDone: 0, attemptsFailed: 0, leasesLost: 0, released: 0,
    chain: { rows: 0, waitMs: 0, holdMs: 0, transactions: 0 }, nearDuplicateMs: 0, phases: {}, peakRssMb: 0, seconds: 0,
  };
  const timed = async <T,>(phase: string, work: Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await work;
    } finally {
      report.phases[phase] = (report.phases[phase] ?? 0) + (performance.now() - t);
    }
  };
  const chainAtStart = { rows: auditChainStats.rows, waitMs: auditChainStats.waitMs };
  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 200);
  const files = new MailboxFiles();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let rec: RecordContext | null = null;
  try {
    const loaded = await loadRunInfo(db, tenantId, opts.runId);
    const run = loaded.info;
    rec = await resolveRecordContext(db, tenantId, loaded.investigationId, loaded.startedBy ?? undefined);
    const r: RecordContext = rec;
    if (!loaded.queued) await enqueueRun(db, r, opts.runId);
    const workerId = await registerWorker(db, r, opts.runId, name);
    report.workerId = workerId;
    const state: RunState = await openRunState(db, r, opts.runId, run.filters, 0);
    let current: WorkItem | null = null;
    let activity: { state: WorkerActivity; text: string } = { state: "idle", text: "starting" };
    const beat = async () => {
      try {
        if (current) await renewLease(db, r, current, leaseSeconds);
        await withTenant(tenantId, (tx) => tx`
          UPDATE ingest_workers SET heartbeat_at = NOW(), state = ${activity.state}, activity = ${activity.text}, current_work_id = ${current?.id ?? null},
                 items_done = ${report.itemsDone}, rss_mb = ${Math.round(process.memoryUsage().rss / 1e6)}
          WHERE id = ${workerId}`, db);
      } catch {
        // The next beat tries again; the lease runs out only if they all fail.
      }
    };
    heartbeat = setInterval(() => void beat(), heartbeatMs);
    let lastBeat = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const setActivity = (s: WorkerActivity, text: string) => {
      if (activity.state === s && activity.text === text) return;
      activity = { state: s, text };
      // What the worker does is shown within a second (at most one beat a second), not only at the next heartbeat.
      if (heartbeatMs > 60_000 || trailing) return;
      const wait = Math.max(0, 1000 - (performance.now() - lastBeat));
      trailing = setTimeout(() => {
        trailing = null;
        lastBeat = performance.now();
        void beat();
      }, wait);
    };

    const earlierClaimable = async (item: WorkItem) => (await withTenant(tenantId, (tx) => tx`
      SELECT 1 FROM ingest_work WHERE tenant_id = ${tenantId} AND run_id = ${opts.runId} AND state IN ('pending', 'discovered', 'sequenced')
        AND kind <> 'mailbox-finish' AND (leased_by IS NULL OR lease_expires_at < NOW()) AND (top_seq, part_no) < (${item.top_seq}, ${item.part_no}) LIMIT 1`, db)).length > 0;

    const fenced: WorkEnv["fenced"] = async (item, fn) => {
      let txRef: Tx | null = null;
      const out = await withFence(db, r, item, async (tx, row) => {
        txRef = tx;
        deferAuditRows(tx);
        const res = await fn(tx, row);
        await flushAuditRows(tx);
        return res;
      });
      const taken = txRef ? auditChainTakenAt(txRef) : undefined;
      if (taken !== undefined) {
        report.chain.holdMs += performance.now() - taken;
        report.chain.transactions++;
      }
      return out;
    };

    const waitForHolders: WorkEnv["waitForHolders"] = async (item, nodes, version) => {
      const all = preorder(nodes);
      const own = new Set(all.map((n) => n.decision?.sourceId).filter((x): x is string => Boolean(x)));
      const ids = [...new Set(all.filter((n) => n.decision?.decision === "skip-duplicate" && n.decision.duplicateOfSourceId && !own.has(n.decision.duplicateOfSourceId)).map((n) => n.decision!.duplicateOfSourceId!))];
      if (ids.length === 0) return true;
      for (;;) {
        const found = await withTenant(tenantId, (tx) => tx<{ id: string }[]>`SELECT id FROM sources WHERE tenant_id = ${tenantId} AND id = ANY(${ids})`, db);
        if (found.length === ids.length) return true;
        const cur = await readItem(db, r, item.id);
        if (!cur || cur.lease_token !== item.lease_token) throw new LeaseLostError(item.id);
        if (cur.decide_version !== version) return false;
        if (await earlierClaimable(item)) {
          await releaseItem(db, r, item);
          throw new ItemReleased();
        }
        setActivity("waiting", `${item.path}: waiting for ${ids.length - found.length} earlier cop${ids.length - found.length === 1 ? "y" : "ies"} to be written`);
        await advanceSequencer(db, r, opts.runId);
        await sleep(pollMs);
      }
    };

    const env: WorkEnv = { db, rec: r, run, state, workerName: name, fenced, waitForHolders, setActivity, onMailboxProgress: opts.onMailboxProgress };

    /** Waits until the sequencer has decided the item (running it meanwhile). */
    const waitSequenced = async (item: WorkItem): Promise<WorkItem> => {
      for (;;) {
        await advanceSequencer(db, r, opts.runId);
        const cur = await readItem(db, r, item.id);
        if (!cur || cur.lease_token !== item.lease_token) throw new LeaseLostError(item.id);
        if (cur.state === "sequenced" || cur.state === "done") return cur;
        if (await earlierClaimable(item)) {
          await releaseItem(db, r, item);
          throw new ItemReleased();
        }
        setActivity("waiting", `${item.path}: waiting for the items before it to be read and decided`);
        await sleep(pollMs);
      }
    };

    /** The context the ingest writes a top-level object with (read now, as ingestDirectory / ingestBucket always did). */
    const topContext = async (item: WorkItem, forMailbox: boolean): Promise<IngestItemContext> => {
      const max = run.options.max_parse_bytes;
      let fileBytes: Buffer = Buffer.alloc(0);
      let sha256: string;
      let byteSize: number;
      let tooLargeToParse: IngestItemContext["tooLargeToParse"];
      if (run.sourceKind === "folder") {
        try {
          byteSize = statSync(item.path).size;
          if (forMailbox) sha256 = item.sha256 ?? (await sha256OfFile(item.path));
          else if (byteSize > max) {
            sha256 = await sha256OfFile(item.path);
            tooLargeToParse = { limitBytes: max, localPath: item.path };
          } else {
            fileBytes = readFileSync(item.path);
            sha256 = computeSha256(fileBytes);
          }
        } catch (err: unknown) {
          throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      } else {
        try {
          byteSize = item.byte_size;
          if (forMailbox) sha256 = item.sha256 ?? (await sha256OfBucketObject(run.bucket!, item.object_key!));
          else if (byteSize > max) {
            sha256 = item.sha256 ?? (await sha256OfBucketObject(run.bucket!, item.object_key!));
            tooLargeToParse = { limitBytes: max };
          } else {
            fileBytes = await downloadBucketObject(run.bucket!, item.object_key!);
            byteSize = fileBytes.length;
            sha256 = computeSha256(fileBytes);
          }
        } catch (err: unknown) {
          throw new Error(`Failed to download object from bucket gs://${run.bucket}/${item.object_key}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }
      if (item.sha256 && item.sha256 !== sha256) {
        throw new PermanentItemError(`${item.path} changed after triage (SHA-256 ${item.sha256} then, ${sha256} now): it is not ingested; start a new run`);
      }
      return {
        resolvedTenantId: tenantId, workspaceId: r.workspaceId, investigationId: r.investigationId, actorId: r.actorId,
        fileName: item.file_name, sourcePath: item.path, fileBytes, byteSize, sha256, isBucketSource: run.sourceKind === "bucket",
        bucketSources: run.bucketSources, bucketArtifacts: run.bucketArtifacts, zipOptions: run.options.zip, tooLargeToParse,
        run: state, triageDecisionId: item.decision_id ?? undefined, order: { topSeq: item.top_seq, partNo: item.part_no, entryIndex: 0 },
      };
    };

    /** A written item's rows exist already (it was done before): nothing is written a second time. */
    const alreadyWritten = async (tx: Tx, item: WorkItem, root: PlanNode): Promise<boolean> => {
      const d = root.decision!;
      if (d.decision === "ingest") return (await tx`SELECT 1 FROM sources WHERE id = ${d.sourceId} AND tenant_id = ${tenantId}`).length > 0;
      if (d.decision === "skip-duplicate") return (await tx`SELECT 1 FROM ingest_decisions WHERE tenant_id = ${tenantId} AND run_id = ${item.run_id} AND stage = 'ingest' AND path = ${root.path} LIMIT 1`).length > 0;
      if (d.decision === "link") return (await tx`SELECT 1 FROM source_instances WHERE tenant_id = ${tenantId} AND source_id = ${d.sourceId} AND investigation_id = ${r.investigationId} LIMIT 1`).length > 0;
      return false;
    };

    const workFile = async (item: WorkItem): Promise<void> => {
      setActivity("discovering", item.path);
      const ctx = await timed("discover", topContext(item, false));
      const root = await timed("discover", discoverNode(ctx, null, 0, { n: 0 }, run.filters));
      await hooks.afterDiscover?.(viewOf(item));
      await timed("record nodes", publishNodes(db, r, item, [root]));
      let first = true;
      for (;;) {
        const cur = await timed("wait for the sequencer", waitSequenced(item));
        await loadDecisions(db, r, item, [root]);
        if (first) {
          setActivity("writing", item.path);
          await hooks.beforeWrite?.(viewOf(cur));
          first = false;
        }
        if (!(await timed("wait for earlier copies", waitForHolders(item, [root], cur.decide_version)))) continue;
        if (root.decision!.decision === "void") throw new PermanentItemError(root.local && "throws" in root.local ? root.local.throws : `${item.path} cannot be written`);
        setActivity("writing", item.path);
        const res = await timed("write", fenced(item, async (tx, row) => {
          if (row.decide_version !== cur.decide_version) return null;
          await hooks.duringWrite?.(viewOf(cur));
          if (await alreadyWritten(tx, item, root)) {
            await markDone(tx, item, { status: "written before", source_id: root.decision!.sourceId });
            return "written-before" as const;
          }
          const out = await processSingleItem(tx, { ...ctx, plan: root });
          await flushPending(tx, state);
          await markDone(tx, item, { status: out.status, reason: out.reason ?? null, source_id: out.sourceId ?? null, children: out.childResults?.length ?? 0 });
          return out;
        }));
        if (res === null) {
          discardPending(state);
          continue;
        }
        if (res !== "written-before") results?.set(item.top_seq, res);
        return;
      }
    };

    const workMailboxHead = async (item: WorkItem): Promise<void> => {
      setActivity("discovering", item.path);
      const ctx = await topContext(item, true);
      const root: PlanNode = {
        index: 0, parentIndex: null, entryIndex: 0, depth: 0, path: item.path, fileName: item.file_name, byteSize: ctx.byteSize, sha256: ctx.sha256,
        messageHash: null, kind: "file", local: null, children: [],
      };
      await hooks.afterDiscover?.(viewOf(item));
      await timed("record nodes", publishNodes(db, r, item, [root]));
      let first = true;
      for (;;) {
        const cur = await timed("wait for the sequencer", waitSequenced(item));
        await loadDecisions(db, r, item, [root]);
        if (first) {
          await hooks.beforeWrite?.(viewOf(cur));
          first = false;
        }
        if (!(await timed("wait for earlier copies", waitForHolders(item, [root], cur.decide_version)))) continue;
        setActivity("writing", `${item.path} (storing the mailbox and splitting it into parts)`);
        const res = await timed("write", writeMailboxHead(env, { ...item, decide_version: cur.decide_version }, ctx, root, files));
        if (res) results?.set(item.top_seq, res);
        return;
      }
    };

    const mailboxContext = (item: WorkItem, ctxBase: { byteSize: number; sha256: string }): IngestItemContext => ({
      resolvedTenantId: tenantId, workspaceId: r.workspaceId, investigationId: r.investigationId, actorId: r.actorId,
      fileName: item.file_name, sourcePath: item.path, fileBytes: Buffer.alloc(0), byteSize: ctxBase.byteSize, sha256: ctxBase.sha256,
      isBucketSource: run.sourceKind === "bucket", bucketSources: run.bucketSources, bucketArtifacts: run.bucketArtifacts, zipOptions: run.options.zip,
      run: state, triageDecisionId: item.decision_id ?? undefined, order: { topSeq: item.top_seq, partNo: item.part_no, entryIndex: 0 },
    });

    const workMailboxPart = async (item: WorkItem): Promise<void> => {
      setActivity("discovering", `${item.path} (part ${item.part_no})`);
      const head = await headOf(env, item);
      const ctx = mailboxContext(item, { byteSize: item.byte_size, sha256: item.sha256 ?? (await mailboxSha(item)) });
      const { roots, contexts } = await timed("discover", discoverMailboxPart(env, item, ctx, head, files));
      await hooks.afterDiscover?.(viewOf(item));
      await timed("record nodes", publishNodes(db, r, item, roots));
      let first = true;
      for (;;) {
        const cur = await timed("wait for the sequencer", waitSequenced(item));
        await loadDecisions(db, r, item, roots);
        if (first) {
          await hooks.beforeWrite?.(viewOf(cur));
          first = false;
        }
        if (await timed("write", writeMailboxPart(env, cur, roots, contexts, cur.decide_version, cur.progress))) return;
        discardPending(state);
      }
    };

    /** The mailbox's SHA-256 as the head recorded it on its source (the parts and the finish use it). */
    const mailboxSha = async (item: WorkItem): Promise<string> => {
      const rows = await withTenant(tenantId, (tx) => tx<{ sha256: string }[]>`
        SELECT s.sha256 FROM sources s JOIN ingest_work h ON h.tenant_id = s.tenant_id AND (h.result->>'mailbox_source_id')::uuid = s.id
        WHERE h.tenant_id = ${tenantId} AND h.run_id = ${item.run_id} AND h.top_seq = ${item.top_seq} AND h.part_no = 0`, db);
      if (!rows[0]) throw new Error(`${item.path}: the mailbox's source is not written`);
      return rows[0].sha256;
    };

    const workMailboxFinish = async (item: WorkItem): Promise<void> => {
      setActivity("writing", `${item.path} (the mailbox's summary)`);
      const ctx = mailboxContext(item, { byteSize: item.byte_size, sha256: item.sha256 ?? (await mailboxSha(item)) });
      const res = await timed("write", writeMailboxFinish(env, item, ctx));
      results?.set(item.top_seq, res);
    };

    /** An item that failed for good: its audit row, and the sequencer goes back to it. */
    const onItemFailed = async (tx: Tx, item: WorkItem, message: string) => {
      const path = item.kind === "mailbox-part" ? `${item.path} (part ${item.part_no} of the mailbox)` : item.path;
      // The rewind first: it may wait for other items' write transactions (their rows), which take the
      // audit chain head last; this transaction takes the chain head after it, so they never wait on each other.
      await rewindAfterFailure(tx, r, item);
      await recordNotIngested(tx, r, { filename: item.file_name, filePath: path, byteSize: item.byte_size, sha256: item.sha256 ?? "unknown", status: "failed", reason: message }, "error");
      if (item.kind === "file" || item.kind === "mailbox") {
        results?.set(item.top_seq, { filename: item.file_name, filePath: item.path, byteSize: item.byte_size, sha256: item.sha256 ?? "unknown", status: "failed", reason: message });
      }
    };

    const passCursor = newPassCursor();
    let lastPass = 0;
    const nearDuplicates = async () => {
      setActivity("indexing", "near-duplicate pass");
      const nd = await timed("near-duplicate pass", advanceNearDuplicates(db, r, opts.runId, passCursor));
      report.nearDuplicateMs += nd.ms;
    };

    for (;;) {
      const item = await timed("claim", claimItem(db, r, opts.runId, workerId, { leaseSeconds }));
      if (!item) {
        setActivity("idle", "no item to take now");
        await advanceSequencer(db, r, opts.runId);
        await nearDuplicates();
        if (await timed("idle", finalizeRunIfComplete(db, r, opts.runId))) break;
        await timed("idle", sleep(Math.max(pollMs, 100)));
        continue;
      }
      if (item.attempts > item.max_attempts) {
        await failExhaustedItem(db, r, item, (tx, message) => onItemFailed(tx, item, message));
        continue;
      }
      current = item;
      try {
        if (item.kind === "file") await workFile(item);
        else if (item.kind === "mailbox") await workMailboxHead(item);
        else if (item.kind === "mailbox-part") await workMailboxPart(item);
        else await workMailboxFinish(item);
        report.itemsDone++;
      } catch (err: unknown) {
        discardPending(state);
        if (err instanceof LeaseLostError) report.leasesLost++;
        else if (err instanceof ItemReleased) report.released++;
        else {
          report.attemptsFailed++;
          const failed = item;
          await recordAttemptError(db, r, failed, name, err, (tx, message) => onItemFailed(tx, failed, message));
        }
      } finally {
        current = null;
      }
      // The pass is one at a time and not on any item's way: a busy worker runs it at most every 2 s
      // (an idle one runs it at once, above), so no worker waits for it between items.
      if (performance.now() - lastPass > 2000) {
        lastPass = performance.now();
        await nearDuplicates();
      }
    }
    setActivity("idle", "the run is finished");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    clearInterval(rssTimer);
    files.close();
    report.chain.rows = auditChainStats.rows - chainAtStart.rows;
    report.chain.waitMs = auditChainStats.waitMs - chainAtStart.waitMs;
    report.peakRssMb = Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1e6);
    for (const k of Object.keys(report.phases)) report.phases[k] = Math.round(report.phases[k]!);
    report.seconds = (performance.now() - started) / 1000;
    if (rec && report.workerId) {
      await withTenant(tenantId, (tx) => tx`
        UPDATE ingest_workers SET state = 'stopped', stopped_at = NOW(), heartbeat_at = NOW(), current_work_id = NULL, items_done = ${report.itemsDone},
               activity = ${"stopped"}, stats = ${tx.json({ ...report })}
        WHERE id = ${report.workerId}`, db).catch(() => undefined);
    }
    await db.end();
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI: one worker process
// ─────────────────────────────────────────────────────────────────────────────
async function runCli() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const runId = typeof args["run"] === "string" ? args["run"] : process.env.INGEST_RUN_ID ?? "";
  if (!runId) {
    console.error("Usage: pnpm ingest:worker --run <run id> [--name <name>] [--stats-file <path>]   (MATTER_TENANT_ID from the matter environment)");
    process.exit(1);
  }
  // A Cloud Run job task is named by its index (CLOUD_RUN_TASK_INDEX), so ingest:status says which task does what.
  const name = typeof args["name"] === "string" ? args["name"] : process.env.CLOUD_RUN_TASK_INDEX !== undefined ? `task-${process.env.CLOUD_RUN_TASK_INDEX}` : undefined;
  const statsFile = typeof args["stats-file"] === "string" ? args["stats-file"] : process.env.INGEST_WORKER_STATS_FILE;
  try {
    const report = await runWorker({ runId, name });
    console.log(`worker ${report.name} finished: ${report.itemsDone} items, ${report.attemptsFailed} failed attempts, ${report.leasesLost} leases lost, peak ${report.peakRssMb} MB, ${report.seconds.toFixed(1)} s`);
    if (statsFile) writeFileSync(statsFile, JSON.stringify({ ...report, pid: process.pid }, null, 2));
  } catch (err: unknown) {
    console.error(`worker failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (/^worker\.(ts|js)$/.test(basename(process.argv[1] ?? ""))) {
  void runCli();
}
