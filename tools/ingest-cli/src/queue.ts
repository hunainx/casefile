import { hostname } from "node:os";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, getDbUrl, type Tx } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import { mailboxFormatByName, mailboxFormatOfFile, type MailboxFormat } from "./mailbox.js";
import { resolveRecordContext, type RecordContext } from "./triage.js";

/**
 * BIGDATA-4 work queue (plan section 16; answer 9): a table in the matter's own database.
 *
 *  - The queue of a run is built from its triage decisions: one item per object triage decided to
 *    ingest, at its place in reading order (top_seq = its position among them; part_no 0). A mailbox's
 *    head item later adds its parts (part_no 1..n) and its finish item. Building it again adds nothing.
 *  - A worker claims the earliest item it can (FOR UPDATE SKIP LOCKED): an item nobody holds, or one
 *    whose lease ran out (its worker was killed). Each claim is an attempt; a lease lasts
 *    `leaseSeconds` of the DATABASE clock and the worker's heartbeat renews it.
 *  - The fence: a worker writes an item only inside withFence(), which locks the item's row and
 *    checks that the lease token is still the worker's own; the same transaction marks it done. A
 *    worker whose lease was taken over cannot commit; while the transaction is open, SKIP LOCKED keeps
 *    anyone else from claiming the item.
 *  - An error goes on the item (its history is kept) and the item goes back to the queue; after
 *    max_attempts it is failed, with one source.ingest_failed audit row, and it stays listed.
 */

export type WorkKind = "file" | "mailbox" | "mailbox-part" | "mailbox-finish";
export type WorkState = "pending" | "discovered" | "sequenced" | "done" | "failed";

export interface WorkItem {
  id: string;
  tenant_id: string;
  investigation_id: string;
  run_id: string;
  top_seq: number;
  part_no: number;
  kind: WorkKind;
  decision_id: string | null;
  path: string;
  file_name: string;
  object_key: string | null;
  byte_size: number;
  sha256: string | null;
  mailbox_format: MailboxFormat | null;
  spec: Record<string, unknown>;
  state: WorkState;
  decide_version: number;
  entries: number | null;
  progress: number;
  lease_token: string | null;
  leased_by: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  errors: unknown[];
  result: Record<string, unknown> | null;
}

/** What a worker hook sees of an item (tests use it to hold items back or break them). */
export type WorkItemView = Pick<WorkItem, "id" | "kind" | "top_seq" | "part_no" | "path" | "file_name" | "spec" | "state" | "attempts">;

export const viewOf = (w: WorkItem): WorkItemView => ({ id: w.id, kind: w.kind, top_seq: w.top_seq, part_no: w.part_no, path: w.path, file_name: w.file_name, spec: w.spec, state: w.state, attempts: w.attempts });

/** The lease of the item is no longer the caller's (it ran out and another worker took the item). */
export class LeaseLostError extends Error {
  constructor(readonly itemId: string) {
    super(`the lease on work item ${itemId} is no longer held by this worker: another worker has it`);
    this.name = "LeaseLostError";
  }
}

/** An error a retry cannot change (a zip bomb, a file that changed since it was read): the item fails at once. */
export class PermanentItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentItemError";
  }
}

const WORK_COLUMNS = `id, tenant_id, investigation_id, run_id, top_seq, part_no, kind, decision_id, path, file_name, object_key,
  byte_size::float8 AS byte_size, sha256, mailbox_format, spec, state, decide_version, entries, progress, lease_token, leased_by,
  attempts, max_attempts, last_error, errors, result`;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : null);

function toItem(r: Record<string, unknown>): WorkItem {
  const kind = str(r.kind);
  const state = str(r.state);
  const format = strOrNull(r.mailbox_format);
  if (kind !== "file" && kind !== "mailbox" && kind !== "mailbox-part" && kind !== "mailbox-finish") throw new Error(`unknown work item kind ${kind}`);
  if (state !== "pending" && state !== "discovered" && state !== "sequenced" && state !== "done" && state !== "failed") throw new Error(`unknown work item state ${state}`);
  if (format !== null && format !== "pst" && format !== "ost" && format !== "mbox") throw new Error(`unknown mailbox format ${format}`);
  return {
    id: str(r.id), tenant_id: str(r.tenant_id), investigation_id: str(r.investigation_id), run_id: str(r.run_id),
    top_seq: Number(r.top_seq), part_no: Number(r.part_no), kind, decision_id: strOrNull(r.decision_id),
    path: str(r.path), file_name: str(r.file_name), object_key: strOrNull(r.object_key), byte_size: Number(r.byte_size),
    sha256: strOrNull(r.sha256), mailbox_format: format, spec: obj(r.spec) ?? {}, state, decide_version: Number(r.decide_version),
    entries: r.entries === null || r.entries === undefined ? null : Number(r.entries), progress: Number(r.progress),
    lease_token: strOrNull(r.lease_token), leased_by: strOrNull(r.leased_by), attempts: Number(r.attempts), max_attempts: Number(r.max_attempts),
    last_error: strOrNull(r.last_error), errors: Array.isArray(r.errors) ? r.errors : [], result: obj(r.result),
  };
}

/** Reads one item as it is now (another worker may have changed it). */
export async function readItem(db: postgres.Sql, rec: RecordContext, id: string): Promise<WorkItem | null> {
  const rows = await withTenant(rec.resolvedTenantId, (tx) => tx.unsafe(`SELECT ${WORK_COLUMNS} FROM ingest_work WHERE id = $1 AND tenant_id = $2`, [id, rec.resolvedTenantId]), db);
  return rows[0] ? toItem(rows[0]) : null;
}

const parseGcs = (p: string) => /^gcs:\/\/([^/]+)\/(.+)$/.exec(p);

/**
 * Builds the run's queue from its triage decisions ("ingest", in the run's order), and marks the run
 * queued. Idempotent: an item that exists already is left as it is.
 */
export async function enqueueRun(db: postgres.Sql, rec: RecordContext, runId: string): Promise<{ added: number; total: number }> {
  const t = rec.resolvedTenantId;
  const decisions = await withTenant(t, (tx) => tx<{ id: string; path: string; byte_size: string; sha256: string | null }[]>`
    SELECT id, path, byte_size, sha256 FROM ingest_decisions
    WHERE tenant_id = ${t} AND run_id = ${runId} AND stage = 'triage' AND decision = 'ingest'
    ORDER BY seq`, db);
  let added = 0;
  const rows = decisions.map((d, i) => {
    const g = parseGcs(d.path);
    const fileName = basename(g ? g[2]! : d.path);
    let format: MailboxFormat | null = null;
    const size = Number(d.byte_size);
    if (size > 0) {
      try {
        format = g ? mailboxFormatByName(fileName) : mailboxFormatOfFile(d.path, fileName);
      } catch {
        format = mailboxFormatByName(fileName); // unreadable now: the worker reads it and records what happens
      }
    }
    return {
      tenant_id: t, investigation_id: rec.investigationId, run_id: runId, top_seq: i, part_no: 0,
      kind: format ? "mailbox" : "file", decision_id: d.id, path: d.path, file_name: fileName,
      object_key: g ? g[2]! : null, byte_size: size, sha256: d.sha256, mailbox_format: format,
    };
  });
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    const res = await withTenant(t, (tx) => tx`
      INSERT INTO ingest_work ${tx(batch, "tenant_id", "investigation_id", "run_id", "top_seq", "part_no", "kind", "decision_id", "path", "file_name", "object_key", "byte_size", "sha256", "mailbox_format")}
      ON CONFLICT (run_id, top_seq, part_no) DO NOTHING`, db);
    added += res.count;
  }
  await withTenant(t, (tx) => tx`UPDATE ingest_runs SET queued_at = COALESCE(queued_at, NOW()) WHERE id = ${runId} AND tenant_id = ${t}`, db);
  return { added, total: rows.length };
}

/** Registers a worker process of the run (ingest_workers); its id is the lease holder's id. */
export async function registerWorker(db: postgres.Sql, rec: RecordContext, runId: string, name: string): Promise<string> {
  const rows = await withTenant(rec.resolvedTenantId, (tx) => tx<{ id: string }[]>`
    INSERT INTO ingest_workers (tenant_id, investigation_id, run_id, name, host, pid, state)
    VALUES (${rec.resolvedTenantId}, ${rec.investigationId}, ${runId}, ${name}, ${hostname()}, ${process.pid}, 'idle')
    RETURNING id`, db);
  return rows[0]!.id;
}

/**
 * Claims the earliest item of the run that nobody holds (or whose lease ran out), in reading order.
 * A mailbox's finish item is claimable once all its parts are finished and their documents have been
 * through the near-duplicate pass (its summary counts them).
 */
export async function claimItem(db: postgres.Sql, rec: RecordContext, runId: string, workerId: string, opts: { leaseSeconds?: number } = {}): Promise<WorkItem | null> {
  const t = rec.resolvedTenantId;
  const lease = opts.leaseSeconds ?? leaseSecondsFromEnv();
  const rows = await withTenant(t, (tx) => tx.unsafe(`
    UPDATE ingest_work w SET leased_by = $3, lease_token = gen_random_uuid(), lease_expires_at = NOW() + make_interval(secs => $4::float8),
           attempts = w.attempts + 1, updated_at = NOW()
    WHERE w.id = (
      SELECT c.id FROM ingest_work c
      WHERE c.tenant_id = $1 AND c.run_id = $2 AND c.state IN ('pending', 'discovered', 'sequenced')
        AND (c.leased_by IS NULL OR c.lease_expires_at < NOW())
        AND (c.kind <> 'mailbox-finish' OR (
              NOT EXISTS (SELECT 1 FROM ingest_work p WHERE p.tenant_id = c.tenant_id AND p.run_id = c.run_id AND p.top_seq = c.top_seq
                          AND p.kind = 'mailbox-part' AND p.state IN ('pending', 'discovered', 'sequenced'))
          AND NOT EXISTS (SELECT 1 FROM ingest_signatures s WHERE s.tenant_id = c.tenant_id AND s.run_id = c.run_id AND s.top_seq = c.top_seq
                          AND NOT EXISTS (SELECT 1 FROM document_fingerprints f WHERE f.tenant_id = s.tenant_id AND f.content_document_id = s.content_document_id))))
      ORDER BY c.top_seq, c.part_no
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
    RETURNING ${WORK_COLUMNS}`, [t, runId, workerId, lease]), db);
  return rows[0] ? toItem(rows[0]) : null;
}

export function leaseSecondsFromEnv(): number {
  const v = Number(process.env.INGEST_LEASE_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 90;
}

/** Renews the lease, unless the item's row is locked by the worker's own write (then it cannot be claimed anyway). */
export async function renewLease(db: postgres.Sql, rec: RecordContext, item: WorkItem, leaseSeconds: number): Promise<boolean> {
  const rows = await withTenant(rec.resolvedTenantId, (tx) => tx`
    UPDATE ingest_work SET lease_expires_at = NOW() + make_interval(secs => ${leaseSeconds}::float8)
    WHERE id = (SELECT id FROM ingest_work WHERE id = ${item.id} AND lease_token = ${item.lease_token} FOR UPDATE SKIP LOCKED)
    RETURNING id`, db);
  return rows.length > 0;
}

/** Gives an item back without it counting as a failed attempt (a worker that makes way for an earlier item). */
export async function releaseItem(db: postgres.Sql, rec: RecordContext, item: WorkItem): Promise<void> {
  await withTenant(rec.resolvedTenantId, (tx) => tx`
    UPDATE ingest_work SET leased_by = NULL, lease_token = NULL, lease_expires_at = NULL, attempts = GREATEST(attempts - 1, 0), updated_at = NOW()
    WHERE id = ${item.id} AND lease_token = ${item.lease_token}`, db);
}

/**
 * Runs `fn` in one transaction behind the fence: the item's row is locked and its lease token must
 * still be the caller's, or LeaseLostError is thrown and nothing is written.
 */
export async function withFence<T>(db: postgres.Sql, rec: RecordContext, item: WorkItem, fn: (tx: Tx, row: { state: WorkState; progress: number; decide_version: number }) => Promise<T>): Promise<T> {
  return withTenant(rec.resolvedTenantId, async (tx) => {
    const rows = await tx<{ lease_token: string | null; state: WorkState; progress: number; decide_version: number }[]>`
      SELECT lease_token, state, progress, decide_version FROM ingest_work WHERE id = ${item.id} AND tenant_id = ${rec.resolvedTenantId} FOR UPDATE`;
    if (!rows[0] || rows[0].lease_token !== item.lease_token || item.lease_token === null) throw new LeaseLostError(item.id);
    return fn(tx, rows[0]);
  }, db);
}

/** Marks the item done, in the caller's fenced transaction. */
export async function markDone(tx: Tx, item: WorkItem, result: Record<string, unknown>, progress?: number): Promise<void> {
  await tx`
    UPDATE ingest_work SET state = 'done', result = ${tx.json(result as postgres.JSONValue)}, finished_at = NOW(), updated_at = NOW(),
           leased_by = NULL, lease_token = NULL, lease_expires_at = NULL${progress !== undefined ? tx`, progress = ${progress}` : tx``}
    WHERE id = ${item.id}`;
}

/**
 * Records an attempt's error on the item and gives it back; once it has had max_attempts (or the
 * error is permanent) the item is failed, and `onFailed` runs in the same transaction (the item's
 * source.ingest_failed audit row, and the sequencer's rewind). Returns the item's new state.
 */
export async function recordAttemptError(
  db: postgres.Sql,
  rec: RecordContext,
  item: WorkItem,
  workerName: string,
  err: unknown,
  onFailed: (tx: Tx, message: string) => Promise<void>,
): Promise<WorkState | "lost"> {
  const message = err instanceof Error ? err.message : String(err);
  const permanent = err instanceof PermanentItemError;
  return withTenant(rec.resolvedTenantId, async (tx) => {
    const rows = await tx<{ attempts: number; max_attempts: number; lease_token: string | null }[]>`
      SELECT attempts, max_attempts, lease_token FROM ingest_work WHERE id = ${item.id} FOR UPDATE`;
    if (!rows[0] || rows[0].lease_token !== item.lease_token) return "lost";
    const failed = permanent || rows[0].attempts >= rows[0].max_attempts;
    const entry = { attempt: rows[0].attempts, worker: workerName, error: message, permanent };
    await tx`
      UPDATE ingest_work SET errors = errors || ${tx.json([entry])}, last_error = ${message},
             leased_by = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
             ${failed ? tx`, state = 'failed', finished_at = NOW()` : tx``}
      WHERE id = ${item.id}`;
    if (failed) await onFailed(tx, message);
    return failed ? "failed" : item.state;
  }, db);
}

/** Fails an item whose workers stopped while holding it more often than it may be tried (claimed past max_attempts). */
export async function failExhaustedItem(db: postgres.Sql, rec: RecordContext, item: WorkItem, onFailed: (tx: Tx, message: string) => Promise<void>): Promise<void> {
  const message = `the item's worker stopped ${item.attempts - 1} time(s) while working on it (killed, or out of memory?), and it may be tried ${item.max_attempts} times`;
  await withTenant(rec.resolvedTenantId, async (tx) => {
    const r = await tx`
      UPDATE ingest_work SET state = 'failed', last_error = ${message}, errors = errors || ${tx.json([{ attempt: item.attempts, error: message, permanent: false }])},
             finished_at = NOW(), leased_by = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE id = ${item.id} AND lease_token = ${item.lease_token}`;
    if (r.count > 0) await onFailed(tx, message);
  }, db);
}

/**
 * `pnpm ingest:retry --run <id> [--item <id>]` (the case owner's command): failed items go back to
 * the queue with their attempts reset; their error history stays. The run is open again until
 * workers finish it (`pnpm ingest:resume`). Audited (ingest.retry).
 */
export async function retryFailedItems(options: { runId: string; tenantId?: string | undefined; dbUrl?: string | undefined; itemId?: string | undefined; userId?: string | undefined }): Promise<{ reset: number; paths: string[] }> {
  const tenantId = options.tenantId || process.env.MATTER_TENANT_ID;
  if (!tenantId) throw new Error("Tenant ID is required: set MATTER_TENANT_ID in the matter environment.");
  const db = postgres(options.dbUrl || getDbUrl(), { max: 2 });
  try {
    const run = await withTenant(tenantId, (tx) => tx<{ investigation_id: string }[]>`SELECT investigation_id FROM ingest_runs WHERE id = ${options.runId} AND tenant_id = ${tenantId}`, db);
    if (!run[0]) throw new Error(`Run ${options.runId} not found in this matter`);
    const rec = await resolveRecordContext(db, tenantId, run[0].investigation_id, options.userId);
    return await withTenant(tenantId, async (tx) => {
      const items = await tx<{ id: string; path: string; progress: number; discovered: boolean }[]>`
        SELECT id, path, progress, discovered_at IS NOT NULL AS discovered FROM ingest_work
        WHERE tenant_id = ${tenantId} AND run_id = ${options.runId} AND state = 'failed'
          AND (${options.itemId ?? null}::uuid IS NULL OR id = ${options.itemId ?? null}::uuid)
        ORDER BY top_seq, part_no`;
      for (const it of items) {
        await tx`UPDATE ingest_nodes SET decision = NULL, duplicate_rule = NULL, duplicate_of_path = NULL, duplicate_of_source_id = NULL, source_id = NULL, decided_at = NULL
                 WHERE work_id = ${it.id} AND entry_index >= ${it.progress} AND decision IS NOT NULL`;
        await tx`UPDATE ingest_work SET state = ${it.discovered ? "discovered" : "pending"}, attempts = 0, decide_version = decide_version + 1,
                 finished_at = NULL, updated_at = NOW() WHERE id = ${it.id}`;
      }
      if (items.length > 0) {
        await tx`UPDATE ingest_runs SET finished_at = NULL WHERE id = ${options.runId} AND tenant_id = ${tenantId}`;
        await writeAuditEvent(tx, {
          tenantId, workspaceId: rec.workspaceId, investigationId: rec.investigationId, actorType: "user", actorId: rec.actorId,
          actorDisplay: "Ingest CLI (retry)", action: "ingest.retry", objectType: "ingest_run", objectId: options.runId, objectDisplay: `${items.length} failed item(s)`,
          after: { run_id: options.runId, items: items.map((i) => ({ id: i.id, path: i.path })) }, outcome: "success", requestId: randomUUID(),
        });
      }
      return { reset: items.length, paths: items.map((i) => i.path) };
    }, db);
  } finally {
    await db.end();
  }
}
