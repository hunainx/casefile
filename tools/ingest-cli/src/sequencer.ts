import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { withTenant, type Tx } from "@casefile/db";
import type { RecordContext } from "./triage.js";
import type { DecisionKind, NodeLocal } from "./plan.js";

/**
 * BIGDATA-4 sequencer (plan section 16): decides every node of a run in READING ORDER, one item at
 * a time, whatever the number of workers. The fixed keep rule: the copy that comes first in reading
 * order is kept (top-level objects in path order; inside an object the object first, then what it
 * contains, in the container's own order; a mailbox's messages in the file's order); anything the
 * matter already holds comes before everything in the run.
 *
 * An item is decided only once every earlier item is discovered, so "the first copy" is known when a
 * copy is decided. Deciding is a few queries per item (the kept copies with the item's SHA-256 and
 * message identities); any worker runs it while it waits, one at a time (an advisory lock per run).
 * The database refuses a second kept copy of one SHA-256 or message in a run (partial unique
 * indexes, migration 0031), whatever happens to the lock.
 *
 * For a node, in pre-order: not reached (inside a skipped container); its own rule (junk, empty,
 * the owner's filters; unreadable); for a mailbox message, the same message kept before it
 * (message-duplicate, D111); the same bytes kept before it (exact-duplicate), or a source of another
 * investigation (a link, as the ingest has always done); else ingest, with its new source id. A node
 * that will throw when written (a zip bomb) stops its container: an email goes on without the rest
 * of its attachments, a zip fails, and an item whose top fails writes nothing (every node void).
 */

const lockKey = (runId: string) => `casefile-sequencer:${runId}`;

interface NodeRow {
  id: string;
  node_index: number;
  parent_index: number | null;
  entry_index: number;
  path: string;
  sha256: string | null;
  message_hash: string | null;
  kind: "file" | "message" | "error";
  container: "zip" | "email" | null;
  local: NodeLocal | null;
  decision: DecisionKind | null;
  source_id: string | null;
  duplicate_of_path: string | null;
}

interface Holder {
  sourceId: string;
  path: string;
  /** The source is in this investigation (a later copy is a duplicate); otherwise a copy is linked to it. */
  here: boolean;
}

interface Decided {
  decision: DecisionKind;
  rule: "exact-duplicate" | "message-duplicate" | null;
  path: string | null;
  duplicateOfSourceId: string | null;
  sourceId: string | null;
}

const parseLocal = (v: unknown): NodeLocal | null => {
  const o = typeof v === "string" ? JSON.parse(v) : v;
  return o && typeof o === "object" ? (o as NodeLocal) : null;
};

/** Decides items in reading order as far as it can. Returns the number of items it decided. */
export async function advanceSequencer(db: postgres.Sql, rec: RecordContext, runId: string): Promise<number> {
  // One transaction for as many items as can be decided now (up to 200: the lock is not held long).
  return withTenant(rec.resolvedTenantId, async (tx) => {
    let n = 0;
    while (n < 200 && (await sequenceNext(tx, rec, runId, n === 0)) === "sequenced") n++;
    return n;
  }, db);
}

async function sequenceNext(tx: Tx, rec: RecordContext, runId: string, takeLock: boolean): Promise<"sequenced" | "busy" | "waiting" | "none"> {
  const t = rec.resolvedTenantId;
  if (takeLock) {
    const lock = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey(runId)}, 0)) AS locked`;
    if (!lock[0]!.locked) return "busy";
  }
  const next = await tx<{ id: string; state: string; top_seq: number; part_no: number }[]>`
    SELECT id, state, top_seq, part_no FROM ingest_work
    WHERE tenant_id = ${t} AND run_id = ${runId} AND state IN ('pending', 'discovered') AND kind <> 'mailbox-finish'
    ORDER BY top_seq, part_no LIMIT 1`;
  const w = next[0];
  if (!w) return "none";
  if (w.state === "pending") return "waiting"; // not discovered yet: nothing after it can be decided
  // A mailbox head that is decided but not written has not added its parts yet: they come before
  // anything after the mailbox in reading order, so nothing after it can be decided yet.
  const barrier = await tx`
    SELECT 1 FROM ingest_work WHERE tenant_id = ${t} AND run_id = ${runId} AND kind = 'mailbox' AND state = 'sequenced'
      AND (top_seq, part_no) < (${w.top_seq}, ${w.part_no}) LIMIT 1`;
  if (barrier.length > 0) return "waiting";
  await decideItem(tx, rec, runId, w.id);
  await tx`UPDATE ingest_work SET state = 'sequenced', sequenced_at = NOW(), updated_at = NOW() WHERE id = ${w.id}`;
  return "sequenced";
}

/** Decides every undecided node of one item (see the comment at the top). */
async function decideItem(tx: Tx, rec: RecordContext, runId: string, workId: string): Promise<void> {
  const t = rec.resolvedTenantId;
  const rows = (await tx<NodeRow[]>`
    SELECT id, node_index, parent_index, entry_index, path, sha256, message_hash, kind, container, local, decision, source_id, duplicate_of_path
    FROM ingest_nodes WHERE tenant_id = ${t} AND work_id = ${workId} ORDER BY node_index`).map((r) => ({ ...r, local: parseLocal(r.local) }));
  const open = rows.filter((r) => r.decision === null);
  if (open.length === 0) return;

  const shas = [...new Set(open.map((r) => r.sha256).filter((x): x is string => x !== null))];
  const msgs = [...new Set(open.map((r) => r.message_hash).filter((x): x is string => x !== null))];
  const bySha = new Map<string, Holder>();
  const byMessage = new Map<string, Holder>();
  if (shas.length > 0) {
    // What the matter holds already (earlier runs, other investigations of the workspace): the first one.
    const existing = await tx<{ id: string; sha256: string; path: string | null; here: boolean }[]>`
      SELECT s.id, s.sha256, s.metadata->>'source_path' AS path,
             EXISTS (SELECT 1 FROM source_instances si WHERE si.source_id = s.id AND si.investigation_id = ${rec.investigationId} AND si.tenant_id = ${t}) AS here
      FROM sources s
      WHERE s.tenant_id = ${t} AND s.workspace_id = ${rec.workspaceId} AND s.sha256 = ANY(${shas})
        AND s.status NOT IN ('purged', 'quarantined') AND s.deleted_at IS NULL
      ORDER BY s.created_at, s.id`;
    for (const e of existing) if (!bySha.has(e.sha256)) bySha.set(e.sha256, { sourceId: e.id, path: e.path ?? `source ${e.id}`, here: e.here });
  }
  if (msgs.length > 0) {
    const existing = await tx<{ id: string; hash: string; path: string | null }[]>`
      SELECT s.id, s.metadata->>'message_hash' AS hash, s.metadata->>'source_path' AS path FROM sources s
      WHERE s.tenant_id = ${t} AND s.metadata ? 'message_hash' AND s.metadata->>'message_hash' = ANY(${msgs})
        AND s.deleted_at IS NULL AND s.status NOT IN ('purged', 'quarantined')
        AND EXISTS (SELECT 1 FROM source_instances si WHERE si.source_id = s.id AND si.investigation_id = ${rec.investigationId} AND si.tenant_id = ${t})
      ORDER BY s.created_at, s.id`;
    for (const e of existing) if (!byMessage.has(e.hash)) byMessage.set(e.hash, { sourceId: e.id, path: e.path ?? `source ${e.id}`, here: true });
  }
  if (shas.length > 0 || msgs.length > 0) {
    // This run's kept copies (items decided before this one; written or still being written).
    const kept = await tx<{ sha256: string | null; message_hash: string | null; decision: string; source_id: string; path: string; duplicate_of_path: string | null }[]>`
      SELECT sha256, message_hash, decision, source_id, path, duplicate_of_path FROM ingest_nodes
      WHERE tenant_id = ${t} AND run_id = ${runId} AND decision IN ('ingest', 'link')
        AND (sha256 = ANY(${shas}) OR message_hash = ANY(${msgs}))`;
    for (const k of kept) {
      const holder: Holder = { sourceId: k.source_id, path: k.decision === "link" ? (k.duplicate_of_path ?? k.path) : k.path, here: true };
      if (k.sha256) bySha.set(k.sha256, holder);
      if (k.message_hash && k.decision === "ingest") byMessage.set(k.message_hash, holder);
    }
  }

  const byIndex = new Map(rows.map((r) => [r.node_index, r]));
  const children = new Map<number, NodeRow[]>();
  for (const r of rows) if (r.parent_index !== null) (children.get(r.parent_index) ?? children.set(r.parent_index, []).get(r.parent_index)!).push(r);
  const decided = new Map<string, Decided>();
  const set = (n: NodeRow, d: Decided) => {
    if (n.decision === null) decided.set(n.id, d);
  };
  const skipSubtree = (n: NodeRow) => {
    for (const c of children.get(n.node_index) ?? []) {
      set(c, { decision: "not-reached", rule: null, path: null, duplicateOfSourceId: null, sourceId: null });
      skipSubtree(c);
    }
  };
  const keep = (n: NodeRow, sourceId: string) => {
    const h: Holder = { sourceId, path: n.path, here: true };
    if (n.sha256) bySha.set(n.sha256, h);
    if (n.message_hash) byMessage.set(n.message_hash, h);
  };

  /** Decides a node and its subtree; true when writing it will throw (a zip bomb reached). */
  const walk = (n: NodeRow): boolean => {
    if (n.decision !== null) {
      // Written already (a part taken up again after a stop): it stays as it is and holds its copies.
      if ((n.decision === "ingest" || n.decision === "link") && n.source_id) {
        const h: Holder = { sourceId: n.source_id, path: n.decision === "link" ? (n.duplicate_of_path ?? n.path) : n.path, here: true };
        if (n.sha256) bySha.set(n.sha256, h);
        if (n.message_hash && n.decision === "ingest") byMessage.set(n.message_hash, h);
      }
      for (const c of children.get(n.node_index) ?? []) walk(c);
      return false;
    }
    const local = n.local;
    if (n.kind === "error" || (local && "error" in local)) {
      set(n, { decision: "error", rule: null, path: null, duplicateOfSourceId: null, sourceId: null });
      skipSubtree(n);
      return false;
    }
    if (local && "skip" in local) {
      set(n, { decision: local.skip.decision, rule: null, path: null, duplicateOfSourceId: null, sourceId: null });
      skipSubtree(n);
      return false;
    }
    if (n.kind === "message" && n.message_hash) {
      const h = byMessage.get(n.message_hash);
      if (h) {
        set(n, { decision: "skip-duplicate", rule: "message-duplicate", path: h.path, duplicateOfSourceId: h.sourceId, sourceId: null });
        skipSubtree(n);
        return false;
      }
    }
    const h = n.sha256 ? bySha.get(n.sha256) : undefined;
    if (h && h.here) {
      set(n, { decision: "skip-duplicate", rule: "exact-duplicate", path: h.path, duplicateOfSourceId: h.sourceId, sourceId: null });
      skipSubtree(n);
      return false;
    }
    if (h && !h.here) {
      // Only in another investigation: linked here (another acquisition of that source), as before.
      set(n, { decision: "link", rule: null, path: h.path, duplicateOfSourceId: null, sourceId: h.sourceId });
      bySha.set(n.sha256!, { sourceId: h.sourceId, path: h.path, here: true });
      skipSubtree(n);
      return false;
    }
    const sourceId = randomUUID();
    set(n, { decision: "ingest", rule: null, path: null, duplicateOfSourceId: null, sourceId });
    keep(n, sourceId);
    if (local && "throws" in local) return true;
    const kids = children.get(n.node_index) ?? [];
    for (let i = 0; i < kids.length; i++) {
      if (!walk(kids[i]!)) continue;
      // A child throws: nothing after it in this container is reached.
      for (const later of kids.slice(i + 1)) {
        set(later, { decision: "not-reached", rule: null, path: null, duplicateOfSourceId: null, sourceId: null });
        skipSubtree(later);
      }
      if (n.container === "email") return false; // the email records itself as not parsed and goes on
      return true;
    }
    return false;
  };

  const roots = rows.filter((r) => r.parent_index === null || !byIndex.has(r.parent_index));
  let itemThrows = false;
  for (const r of roots) if (walk(r)) itemThrows = true;
  if (itemThrows) {
    // The write would fail and roll back: nothing of it is kept, so no later copy waits for it.
    for (const r of open) decided.set(r.id, { decision: "void", rule: null, path: null, duplicateOfSourceId: null, sourceId: null });
  }

  const ids: string[] = [];
  const decisions: string[] = [];
  const rules: (string | null)[] = [];
  const paths: (string | null)[] = [];
  const dups: (string | null)[] = [];
  const srcs: (string | null)[] = [];
  for (const r of open) {
    const d = decided.get(r.id) ?? { decision: "not-reached" as const, rule: null, path: null, duplicateOfSourceId: null, sourceId: null };
    ids.push(r.id);
    decisions.push(d.decision);
    rules.push(d.rule);
    paths.push(d.path);
    dups.push(d.duplicateOfSourceId);
    srcs.push(d.sourceId);
  }
  await tx`
    UPDATE ingest_nodes n SET decision = v.decision, duplicate_rule = v.rule, duplicate_of_path = v.path,
           duplicate_of_source_id = v.dup, source_id = v.src, decided_at = NOW()
    FROM unnest(${ids}::uuid[], ${decisions}::text[], ${rules}::text[], ${paths}::text[], ${dups}::uuid[], ${srcs}::uuid[]) AS v(id, decision, rule, path, dup, src)
    WHERE n.id = v.id AND n.tenant_id = ${t}`;
}

/**
 * An item failed after it was decided: its nodes not written give up what they kept, and every later
 * item that is not written yet is decided again (it may now keep a copy the failed item was going to
 * keep). The result is what the one-process ingest gave when a file failed. Runs in the caller's
 * transaction, under the sequencer's lock.
 */
export async function rewindAfterFailure(tx: Tx, rec: RecordContext, item: { id: string; run_id: string; top_seq: number; part_no: number }): Promise<void> {
  const t = rec.resolvedTenantId;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(item.run_id)}, 0))`;
  const progress = (await tx<{ progress: number }[]>`SELECT progress FROM ingest_work WHERE id = ${item.id}`)[0]?.progress ?? 0;
  await tx`UPDATE ingest_nodes SET decision = 'void', decided_at = NOW()
           WHERE tenant_id = ${t} AND work_id = ${item.id} AND entry_index >= ${progress} AND decision IS NOT NULL AND decision <> 'void'`;
  const later = await tx<{ id: string; progress: number }[]>`
    UPDATE ingest_work SET state = 'discovered', decide_version = decide_version + 1, updated_at = NOW()
    WHERE tenant_id = ${t} AND run_id = ${item.run_id} AND state = 'sequenced' AND (top_seq, part_no) > (${item.top_seq}, ${item.part_no})
    RETURNING id, progress`;
  for (const l of later) {
    await tx`UPDATE ingest_nodes SET decision = NULL, duplicate_rule = NULL, duplicate_of_path = NULL, duplicate_of_source_id = NULL, source_id = NULL, decided_at = NULL
             WHERE tenant_id = ${t} AND work_id = ${l.id} AND entry_index >= ${l.progress} AND decision IS NOT NULL`;
  }
}
