import { extname } from "node:path";
import type postgres from "postgres";
import { withTenant } from "@casefile/db";
import { computeSha256 } from "@casefile/storage";
import { parseEml, parseMsg, extractZipArchive, ZipBombError, type ParsedEmailResult } from "../../../apps/api/src/services/document-parsers.js";
import { childTriageDecision, formatOf, type IngestItemContext } from "./ingest.js";
import { mailboxFormatByName } from "./mailbox.js";
import { insertBatches } from "./batch-insert.js";
import { nodeSignature, preorder, type DecisionKind, type NodeLocal, type PlanNode } from "./plan.js";
import { withFence, PermanentItemError, type WorkItem } from "./queue.js";
import type { RecordContext } from "./triage.js";
import type { TriageFilters } from "./triage-rules.js";

/**
 * BIGDATA-4 discovery (plan section 16): what a work item holds, found WITHOUT writing anything and
 * without parsing documents: the object, each zip entry and email attachment (recursively, as the
 * ingest reaches them: parseAndIndex's order), with SHA-256 and what the rules that look only at the
 * object decide. It follows processSingleItem step by step: a child's own triage rules (junk, empty,
 * the owner's filters), too large or empty (admitted without parsing), a mailbox inside a container
 * (stored, not read), and, for a zip or an email, its entries or attachments. Emails are parsed (their
 * attachments are needed) and zips read, and both are kept on the node for the write, so nothing is
 * read or parsed twice. A zip bomb is recorded as "the write will throw" (the sequencer knows what
 * that does to the container around it).
 */

export interface Counter {
  n: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function leaf(ctx: IngestItemContext, parent: PlanNode | null, entryIndex: number, counter: Counter, kind: PlanNode["kind"] = "file"): PlanNode {
  return {
    index: counter.n++, parentIndex: parent?.index ?? null, entryIndex, depth: parent ? parent.depth + 1 : 0,
    path: ctx.sourcePath, fileName: ctx.fileName, byteSize: ctx.byteSize, sha256: HEX64.test(ctx.sha256) ? ctx.sha256 : null,
    messageHash: null, kind, local: null, children: [], bytes: ctx.fileBytes, entryModified: ctx.entryModified ?? null,
  };
}

/** The context of an email attachment, as parseAndIndex builds it (ids come at the write). */
export function attachmentContext(ctx: IngestItemContext, att: ParsedEmailResult["attachments"][number]): IngestItemContext {
  return {
    ...ctx, fileName: att.filename, sourcePath: `${ctx.sourcePath}#attachment:${att.filename}`, fileBytes: att.content, byteSize: att.byteSize,
    sha256: computeSha256(att.content), isBucketSource: false, parentSourceId: "(discovery)", triageDecisionId: undefined, reinclude: false,
    entryModified: null, preParsedEmail: undefined, triagedByCaller: false, tooLargeToParse: undefined, plan: undefined,
  };
}

/** The context of a zip entry, as parseAndIndex builds it. */
function entryContext(ctx: IngestItemContext, entry: NonNullable<PlanNode["zip"]>["entries"][number]): IngestItemContext {
  return {
    ...ctx, fileName: entry.filename, sourcePath: `${ctx.sourcePath}#${entry.path}`, fileBytes: entry.content, byteSize: entry.byteSize,
    sha256: computeSha256(entry.content), isBucketSource: false, parentSourceId: "(discovery)", triageDecisionId: undefined, reinclude: false,
    entryModified: entry.modified ?? null, preParsedEmail: undefined, triagedByCaller: false, tooLargeToParse: undefined, plan: undefined,
  };
}

/**
 * One node and what the ingest would reach inside it. `parent` is null for the item's own object
 * (a top-level file, or a mailbox message, whose own rules the caller applied).
 */
export async function discoverNode(ctx: IngestItemContext, parent: PlanNode | null, entryIndex: number, counter: Counter, filters: TriageFilters): Promise<PlanNode> {
  const node = leaf(ctx, parent, entryIndex, counter);
  // 0. An item inside a zip or an email: its own triage rules.
  if (parent && !ctx.triagedByCaller) {
    const d = await childTriageDecision(ctx, filters);
    if (d) {
      node.local = { skip: d };
      return node;
    }
  }
  // 1b. Admitted without parsing; 1c. a mailbox inside a container: stored, not read.
  if (ctx.tooLargeToParse || ctx.byteSize === 0) return node;
  if (parent && mailboxFormatByName(ctx.fileName)) return node;
  const format = formatOf(ctx.fileName, ctx.fileBytes);
  if (format === "email") {
    let parsed: ParsedEmailResult;
    try {
      parsed = ctx.preParsedEmail ?? (extname(ctx.fileName).toLowerCase() === ".eml" ? await parseEml(ctx.fileBytes) : await parseMsg(ctx.fileBytes));
    } catch (err: unknown) {
      node.emailFailed = err instanceof Error ? err.message : String(err); // stored_unparsed at the write, as before
      return node;
    }
    node.email = parsed;
    for (const att of parsed.attachments) node.children.push(await discoverNode(attachmentContext(ctx, att), node, entryIndex, counter, filters));
  } else if (format === "zip") {
    try {
      node.zip = await extractZipArchive(ctx.fileBytes, ctx.zipOptions);
    } catch (err: unknown) {
      if (err instanceof ZipBombError) {
        node.zipError = err;
        node.local = { throws: err.message };
      } else {
        node.zipFailed = err instanceof Error ? err.message : String(err); // stored_unparsed at the write, as before
      }
      return node;
    }
    for (const entry of node.zip.entries) node.children.push(await discoverNode(entryContext(ctx, entry), node, entryIndex, counter, filters));
  }
  return node;
}

/** The container a node's children come out of (the sequencer needs to know who catches what). */
const containerOf = (n: PlanNode): "zip" | "email" | null => (n.email || n.emailFailed !== undefined ? "email" : n.zip || n.zipError !== undefined || n.zipFailed !== undefined ? "zip" : null);

/**
 * Stores what discovery found (ingest_nodes) and marks the item discovered, behind the fence. If the
 * item was discovered before (a worker stopped after this), the nodes must be the same ones, or the
 * item fails: the object changed since it was first read, and its decisions cannot be trusted.
 */
export async function publishNodes(db: postgres.Sql, rec: RecordContext, item: WorkItem, roots: PlanNode[]): Promise<void> {
  const nodes = preorder(roots);
  const t = rec.resolvedTenantId;
  await withFence(db, rec, item, async (tx) => {
    const existing = await tx<{ node_index: number; parent_index: number | null; entry_index: number; path: string; byte_size: string; sha256: string | null; message_hash: string | null; kind: PlanNode["kind"] }[]>`
      SELECT node_index, parent_index, entry_index, path, byte_size, sha256, message_hash, kind FROM ingest_nodes WHERE tenant_id = ${t} AND work_id = ${item.id} ORDER BY node_index`;
    if (existing.length > 0) {
      const was = existing.map((e) => nodeSignature({ index: e.node_index, parentIndex: e.parent_index, entryIndex: e.entry_index, path: e.path, byteSize: Number(e.byte_size), sha256: e.sha256, messageHash: e.message_hash, kind: e.kind }));
      const now = nodes.map((n) => nodeSignature(n));
      if (was.join("\n") !== now.join("\n")) {
        throw new PermanentItemError(`${item.path}: what it holds is not what it held when it was first read (${existing.length} items then, ${nodes.length} now): it changed, so it is not ingested`);
      }
    } else {
      const rows = nodes.map((n) => ({
        tenant_id: t, investigation_id: rec.investigationId, run_id: item.run_id, work_id: item.id, node_index: n.index, parent_index: n.parentIndex,
        entry_index: n.entryIndex, depth: n.depth, path: n.path, file_name: n.fileName, byte_size: n.byteSize, sha256: n.sha256, message_hash: n.messageHash,
        kind: n.kind, container: containerOf(n), local: n.local,
      }));
      for (const b of insertBatches(rows, (r) => Buffer.byteLength(r.path) * 2 + 400)) {
        await tx`INSERT INTO ingest_nodes ${tx(b, "tenant_id", "investigation_id", "run_id", "work_id", "node_index", "parent_index", "entry_index", "depth", "path", "file_name", "byte_size", "sha256", "message_hash", "kind", "container", "local")}
                 ON CONFLICT (work_id, node_index) DO NOTHING`;
      }
    }
    const entries = new Set(nodes.map((n) => n.entryIndex)).size;
    await tx`UPDATE ingest_work SET state = CASE WHEN state = 'pending' THEN 'discovered' ELSE state END,
             entries = ${item.kind === "mailbox-part" ? roots.length : entries}, discovered_at = COALESCE(discovered_at, NOW()), updated_at = NOW()
             WHERE id = ${item.id}`;
  });
}

/** The sequencer's decisions, onto the nodes discovery found (by position). */
export async function loadDecisions(db: postgres.Sql, rec: RecordContext, item: WorkItem, roots: PlanNode[]): Promise<void> {
  const rows = await withTenant(rec.resolvedTenantId, (tx) => tx<{ node_index: number; decision: DecisionKind | null; source_id: string | null; duplicate_rule: string | null; duplicate_of_path: string | null; duplicate_of_source_id: string | null; local: NodeLocal | null }[]>`
    SELECT node_index, decision, source_id, duplicate_rule, duplicate_of_path, duplicate_of_source_id, local FROM ingest_nodes
    WHERE tenant_id = ${rec.resolvedTenantId} AND work_id = ${item.id} ORDER BY node_index`, db);
  const byIndex = new Map(rows.map((r) => [r.node_index, r]));
  for (const n of preorder(roots)) {
    const r = byIndex.get(n.index);
    if (!r || r.decision === null) throw new Error(`${n.path}: no decision yet (item ${item.id})`);
    n.decision = {
      decision: r.decision,
      sourceId: r.source_id,
      duplicateRule: r.duplicate_rule === "exact-duplicate" || r.duplicate_rule === "message-duplicate" ? r.duplicate_rule : null,
      duplicateOfPath: r.duplicate_of_path,
      duplicateOfSourceId: r.duplicate_of_source_id,
    };
  }
}
