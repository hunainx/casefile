import { createReadStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PSTFile } from "pst-extractor";
import { jsonb, withTenant, type Tx } from "@casefile/db";
import { writeAuditRow } from "./audit-buffer.js";
import { getObjectStore, createSourceStorageKey, computeSha256, bucketObjectReadStream, downloadBucketObjectToFile } from "@casefile/storage";
import { parseEml, type ParsedEmailResult } from "../../../apps/api/src/services/document-parsers.js";
import { emailFilterDecision, hasEmailFilters, RULE_VERSIONS } from "./triage-rules.js";
import { messagePath, messageFileName, MAILBOX_SEGMENT_PREFIX, encodeFolderName } from "./mailbox-paths.js";
import { openMailbox, messageIdentity, mboxEntry, pstEntry, MailboxUnreadableError, MAILBOX_MIME, MESSAGE_HASH_VERSION, type MailboxEntry, type MailboxFormat } from "./mailbox.js";
import { openPst } from "./pst.js";
import { planMboxParts, planPstParts, readMboxPart, readPstPart } from "./mailbox-split.js";
import { discoverNode, type Counter } from "./discover.js";
import { preorder, type PlanNode } from "./plan.js";
import { markDone, type WorkItem } from "./queue.js";
import { countNearDuplicates } from "./near-duplicate-pass.js";
import {
  processSingleItem,
  plannedExistingOutcome,
  ingestStageDecision,
  flushPending,
  discardPending,
  recordNotIngested,
  type IngestItemContext,
  type IngestFileResult,
} from "./ingest.js";
import type { WorkEnv } from "./work-env.js";

/**
 * A mailbox file (PST, OST, MBOX) in the ingest (BIGDATA-3B, D108-D113; BIGDATA-4 split it into
 * parts that different workers read, plan section 16).
 *
 *  1. The mailbox's head item: the mailbox is admitted like any file (the same bytes already a source
 *     are skipped or linked, as the sequencer decided), stored whole by streaming (or it stays where
 *     it is, in bucket mode), never changed, with its source, acquisition, instance and artifact rows
 *     and a source.admit audit row. One that cannot be read (high encryption, not a mailbox, damaged
 *     so that it does not open) is stored_unparsed with the reason: stored and listed, never dropped.
 *     A password-protected PST is read (the owner's answer 1) and marked. Then the head writes the
 *     mailbox's parts (plan section 16: a PST by folder, 50 messages a part; an MBOX by byte range,
 *     16 MiB a part) and its finish item, in the same transaction.
 *  2. Each part: its messages are read (discovery), decided by the sequencer in reading order (the
 *     owner's email filters; the same message kept before it, D111; the same bytes kept before it),
 *     and written one message per transaction, each moving the part's progress from i to i + 1 behind
 *     the fence, so a stopped part is taken up again at its first message not written (DEV-038). A
 *     message that stays becomes its own source under the mailbox (its bytes: the MBOX message itself,
 *     or the .eml rendering of a PST message), with the folder path and headers in its metadata, and
 *     its attachments become its children. A message or folder that cannot be read is a
 *     source.ingest_failed audit row and is listed; reading goes on.
 *  3. The finish item, once every part is done: the mailbox's status and what reading found (counts,
 *     errors, where it stopped) go on its source and a source.mailbox_read audit row.
 */

export interface MailboxReadSummary {
  format: MailboxFormat;
  status: "indexed" | "stored_unparsed";
  reason?: string | undefined;
  /** BIGDATA-4 (answer 1): the PST's store had a password; it was read anyway. */
  password_protected?: boolean | undefined;
  /** Messages read out of the file. */
  messages_read: number;
  /** Messages that became sources (indexed, or stored when not readable as an email). */
  messages_admitted: number;
  /** Messages set aside, by rule (message-duplicate, email-date, person, exclude-person, ...). */
  messages_skipped: Record<string, number>;
  /** Messages or folders that could not be read (each has a source.ingest_failed audit row). */
  failed: number;
  folders_skipped: number;
  attachments: { admitted: number; skipped: number; failed: number };
  near_duplicates: number;
  /** The first 100 read errors, with their paths. */
  errors: { path: string; reason: string }[];
  errors_not_listed: number;
  /** Where reading stopped short of the end of the file, when it did. */
  stopped_at?: string | undefined;
  seconds: number;
}

const MAX_LISTED_ERRORS = 100;
const errMsg = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0]! : String(err));

/** The path of a folder of the mailbox (for an error that is not about one message). */
const folderPath = (mailboxPath: string, folder: string[]) => `${mailboxPath}#${MAILBOX_SEGMENT_PREFIX}${folder.map(encodeFolderName).join("/")}`;

/** What the head item leaves for the parts and the finish (ingest_work.result of the head). */
export interface MailboxHeadResult {
  mailbox_source_id: string;
  artifact_id: string;
  format: MailboxFormat;
  parts: number;
  folders_skipped: number;
  started_ms: number;
  password_protected: boolean;
}

/** Inserts the mailbox's source, acquisition, instance and artifact rows and its source.admit audit row. */
async function admitMailbox(tx: Tx, ctx: IngestItemContext, format: MailboxFormat, localPath: string | undefined, status: "processing" | "stored_unparsed", extra: Record<string, unknown>): Promise<{ sourceId: string; artifactId: string }> {
  const { resolvedTenantId, workspaceId, investigationId, actorId, fileName, sourcePath, byteSize, sha256 } = ctx;
  let storageUri: string;
  if (ctx.isBucketSource) {
    storageUri = sourcePath;
  } else {
    const storageKey = createSourceStorageKey(resolvedTenantId, investigationId, sha256);
    await getObjectStore().putFile(storageKey, localPath!, { contentType: MAILBOX_MIME[format], metadata: { filename: fileName }, sha256 });
    storageUri = `gcs://${ctx.bucketSources}/${storageKey}`;
  }
  const sourceId = ctx.plan?.decision?.sourceId ?? randomUUID();
  const metadata = { source_path: sourcePath, mailbox_format: format, ...(ctx.sourceMetadata ?? {}), ...extra };
  await tx`
    INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, status, source_class, metadata, is_encrypted, created_by)
    VALUES (${sourceId}, ${resolvedTenantId}, ${workspaceId}, ${investigationId}, ${fileName}, ${MAILBOX_MIME[format]}, ${byteSize}, ${sha256}, ${storageUri},
            ${status}, 'communication', ${jsonb(tx, metadata)}, ${extra.unparsed_reason === "encrypted"}, ${actorId})`;
  const acqId = randomUUID();
  await tx`
    INSERT INTO acquisition_records (id, tenant_id, source_id, origin, custodian, acquisition_method, obtained_at, declared_by, created_by)
    VALUES (${acqId}, ${resolvedTenantId}, ${sourceId}, ${ctx.isBucketSource ? "GCS Bucket Import" : "CLI Folder Import"},
            ${ctx.isBucketSource ? "GCS Ingestion Operator" : "Local Ingestion Operator"}, 'folder_import', NOW(), ${actorId}, ${actorId})`;
  await tx`
    INSERT INTO source_instances (id, tenant_id, source_id, acquisition_record_id, investigation_id, created_by)
    VALUES (${randomUUID()}, ${resolvedTenantId}, ${sourceId}, ${acqId}, ${investigationId}, ${actorId})`;
  const artifactId = randomUUID();
  // No byte-identical copy (F3, D95): the primary artifact is the mailbox file itself.
  await tx`
    INSERT INTO artifacts (id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by)
    VALUES (${artifactId}, ${resolvedTenantId}, ${sourceId}, ${ctx.parentArtifactId ?? null}, 'primary', ${format === "mbox" ? "mbox_reader" : "pst_reader"}, '1.0.0',
            ${status === "processing" ? "processing" : "failed"}, ${storageUri}, ${actorId})`;
  await writeAuditRow(tx, {
    tenantId: resolvedTenantId,
    workspaceId,
    investigationId,
    actorType: "user",
    actorId,
    actorDisplay: "Ingest CLI",
    action: "source.admit",
    objectType: "source",
    objectId: sourceId,
    objectDisplay: fileName,
    after: {
      filename: fileName, sha256, status, is_supported: true, mailbox_format: format,
      ...(extra.reason ? { reason: extra.reason } : { note: "a mailbox: its messages are read one by one after this" }),
      ...(extra.password_protected ? { password_protected: true } : {}),
    },
    outcome: "success",
    requestId: randomUUID(),
  });
  return { sourceId, artifactId };
}

/** What a message source's metadata says about it (the ingest, and `pnpm ingest:include` of a message). */
export function messageMetadata(
  mailbox: { sourceId?: string | undefined; fileName: string; path: string; format: MailboxFormat },
  folder: string[], locator: string, parsed: ParsedEmailResult, hash: string, rendered: boolean, meta: Record<string, unknown>,
): Record<string, unknown> {
  const h = parsed.headers;
  return {
    ...(mailbox.sourceId ? { mailbox_source_id: mailbox.sourceId } : {}),
    mailbox_file: mailbox.fileName,
    mailbox_path: mailbox.path,
    mailbox_format: mailbox.format,
    folder_path: folder.join("/"),
    message_locator: locator,
    message_hash: hash,
    message_hash_version: MESSAGE_HASH_VERSION,
    headers: {
      from: h.from ?? "", to: h.to ?? "", cc: h.cc ?? "", bcc: h.bcc ?? "", date: h.date ?? "", subject: h.subject ?? "", message_id: h.messageId ?? "",
    },
    ...(rendered ? { rendered: "an .eml rendering of the PST/OST message's properties (the PST has no per-message original bytes)" } : {}),
    ...meta,
  };
}

/** The context of one message of the mailbox, as processSingleItem takes it. */
function messageContext(ctx: IngestItemContext, mailbox: { sourceId: string; artifactId: string; format: MailboxFormat }, e: Extract<MailboxEntry, { kind: "message" }>, parsed: ParsedEmailResult, hash: string): IngestItemContext {
  const h = parsed.headers;
  return {
    ...ctx,
    fileName: messageFileName(h.subject ?? ""),
    sourcePath: messagePath(ctx.sourcePath, e.folder, e.locator),
    fileBytes: e.bytes,
    byteSize: e.bytes.length,
    sha256: computeSha256(e.bytes),
    isBucketSource: false,
    parentSourceId: mailbox.sourceId,
    parentArtifactId: mailbox.artifactId,
    triageDecisionId: undefined,
    reinclude: false,
    entryModified: null,
    tooLargeToParse: undefined,
    preParsedEmail: parsed,
    triagedByCaller: true,
    plan: undefined,
    sourceMetadata: messageMetadata({ sourceId: mailbox.sourceId, fileName: ctx.fileName, path: ctx.sourcePath, format: mailbox.format }, e.folder, e.locator, parsed, hash, e.rendered, e.meta),
  };
}

function emptyMailboxSummary(format: MailboxFormat): MailboxReadSummary {
  return {
    format, status: "indexed", messages_read: 0, messages_admitted: 0, messages_skipped: {}, failed: 0, folders_skipped: 0,
    attachments: { admitted: 0, skipped: 0, failed: 0 }, near_duplicates: 0, errors: [], errors_not_listed: 0, seconds: 0,
  };
}

/** The mailbox source's status and summary, its artifact's status, and its source.mailbox_read audit row. */
async function finishMailbox(tx: Tx, ctx: IngestItemContext, sourceId: string, artifactId: string, summary: MailboxReadSummary, artifactStatus: "ready" | "failed"): Promise<void> {
  const read = { ...summary, seconds: Math.round(summary.seconds * 10) / 10 };
  await tx`
    UPDATE sources SET status = ${summary.status}, metadata = metadata || ${jsonb(tx, { mailbox_read: read })}, updated_at = NOW()
    WHERE id = ${sourceId} AND tenant_id = ${ctx.resolvedTenantId}`;
  await tx`UPDATE artifacts SET status = ${artifactStatus}, updated_at = NOW() WHERE id = ${artifactId} AND tenant_id = ${ctx.resolvedTenantId}`;
  await writeAuditRow(tx, {
    tenantId: ctx.resolvedTenantId,
    workspaceId: ctx.workspaceId,
    investigationId: ctx.investigationId,
    actorType: "user",
    actorId: ctx.actorId,
    actorDisplay: "Ingest CLI",
    action: "source.mailbox_read",
    objectType: "source",
    objectId: sourceId,
    objectDisplay: ctx.fileName,
    after: { path: ctx.sourcePath, ...read, errors: read.errors.slice(0, 20) },
    outcome: summary.status === "indexed" && summary.failed === 0 ? "success" : "failure",
    requestId: randomUUID(),
  });
}

// ── Opening the file ─────────────────────────────────────────────────────────

/** The mailbox file for a worker: on disk, or (bucket mode) a PST copied to a temporary file once per worker. */
export class MailboxFiles {
  private readonly copies = new Map<string, { dir: string; path: string }>();
  private pst: { path: string; file: PSTFile; passwordProtected: boolean } | null = null;

  async localPath(ctx: IngestItemContext, bucket: string | null, key: string | null): Promise<string> {
    if (!ctx.isBucketSource) return ctx.sourcePath;
    // A Cloud Run job task has the matter's sources bucket mounted read-only (INGEST_BUCKET_MOUNTS,
    // "bucket=/mount/path"): the PST is read in place there, by every part, instead of being copied.
    const mounted = bucketMount(bucket);
    if (mounted && key && existsSync(join(mounted, key))) return join(mounted, key);
    const id = `${bucket}/${key}`;
    const have = this.copies.get(id);
    if (have) return have.path;
    const dir = mkdtempSync(join(tmpdir(), "casefile-mailbox-"));
    const path = join(dir, basename(key!));
    await downloadBucketObjectToFile(bucket!, key!, path);
    this.copies.set(id, { dir, path });
    return path;
  }

  /** The PST opened once and kept for the next part of the same file. */
  openPst(path: string): { file: PSTFile; passwordProtected: boolean } {
    if (this.pst?.path === path) return this.pst;
    this.pst?.file.close();
    const opened = openPst(path);
    this.pst = { path, file: opened.file, passwordProtected: opened.info.passwordProtected };
    return this.pst;
  }

  close(): void {
    this.pst?.file.close();
    this.pst = null;
    for (const c of this.copies.values()) rmSync(c.dir, { recursive: true, force: true });
    this.copies.clear();
  }
}

/** The read-only mount of a bucket, from INGEST_BUCKET_MOUNTS ("bucket=/path,other=/path2"), or null. */
function bucketMount(bucket: string | null): string | null {
  if (!bucket) return null;
  for (const pair of (process.env.INGEST_BUCKET_MOUNTS ?? "").split(",")) {
    const [b, path] = pair.split("=");
    if (b?.trim() === bucket && path?.trim()) return path.trim();
  }
  return null;
}

/** Streams an MBOX from a byte offset (a file, or a bucket object read as a stream). */
function mboxOpener(ctx: IngestItemContext, bucket: string | null, key: string | null): (start: number) => AsyncIterable<Buffer> {
  if (!ctx.isBucketSource) return (start) => createReadStream(ctx.sourcePath, { start, highWaterMark: 1 << 20 });
  return (start) => ({
    async *[Symbol.asyncIterator]() {
      const s = await bucketObjectReadStream(bucket!, key!, { start });
      for await (const chunk of s) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    },
  });
}

// ── 1. The head ──────────────────────────────────────────────────────────────

/**
 * Writes the mailbox's head item: the sequencer's decision for the file itself; for a new mailbox,
 * its admission, its parts and its finish item. Returns the file's result when the head is all
 * there is (a duplicate, a link, an unreadable mailbox), or null (the finish gives the result).
 */
export async function writeMailboxHead(env: WorkEnv, item: WorkItem, ctx: IngestItemContext, root: PlanNode, files: MailboxFiles): Promise<IngestFileResult | null> {
  const format = item.mailbox_format!;
  const base = { filename: ctx.fileName, filePath: ctx.sourcePath, byteSize: ctx.byteSize, sha256: ctx.sha256 };
  const planned = { ...ctx, plan: root };
  if (root.decision?.decision !== "ingest") {
    return env.fenced(item, async (tx) => {
      const r = (await plannedExistingOutcome(tx, planned))!;
      await flushPending(tx, env.state);
      await markDone(tx, item, { status: r.status, reason: r.reason ?? null, source_id: r.sourceId ?? null });
      return r;
    });
  }
  // Open it: a file that cannot be read is stored and listed (D113).
  let unreadable: MailboxUnreadableError | null = null;
  let description: Record<string, unknown> = {};
  let passwordProtected = false;
  let segments: Array<Record<string, unknown>> = [];
  let foldersSkipped = 0;
  const localPath = format === "mbox" && ctx.isBucketSource ? undefined : await files.localPath(ctx, env.run.bucket, item.object_key);
  try {
    if (format === "mbox") {
      const stream = localPath ? null : mboxOpener(ctx, env.run.bucket, item.object_key)(0);
      const opened = await openMailbox("mbox", localPath ? { path: localPath } : { stream: () => stream! }, { maxMessageBytes: env.run.options.max_parse_bytes });
      opened.close();
      description = opened.description;
      segments = planMboxParts(ctx.byteSize, env.run.options.mbox_part_bytes).map((r) => ({ kind: "range", start: r.start, end: r.end }));
    } else {
      const opened = await openMailbox(format, { path: localPath! }, { maxMessageBytes: env.run.options.max_parse_bytes });
      description = opened.description;
      opened.close();
      const pst = files.openPst(localPath!);
      passwordProtected = pst.passwordProtected;
      const plan = planPstParts(pst.file, env.run.options.pst_part_messages);
      for (const s of plan.segments) {
        if (s.kind === "skipped") foldersSkipped++;
        else if (s.kind === "error") segments.push({ kind: "error", folder: s.folder, reason: s.reason });
        else segments.push({ kind: "messages", folder: s.folder, folder_nid: s.folderNid, start: s.start, count: s.count });
      }
    }
  } catch (err: unknown) {
    if (!(err instanceof MailboxUnreadableError)) throw err;
    unreadable = err;
  }
  if (unreadable) {
    const summary: MailboxReadSummary = { ...emptyMailboxSummary(format), status: "stored_unparsed", reason: unreadable.message, seconds: 0 };
    const err = unreadable;
    return env.fenced(item, async (tx) => {
      const m = await admitMailbox(tx, planned, format, localPath, "stored_unparsed", { unparsed_reason: err.code, reason: err.message });
      await flushPending(tx, env.state);
      await finishMailbox(tx, planned, m.sourceId, m.artifactId, summary, "failed");
      await markDone(tx, item, { status: "stored_unparsed", reason: err.message, source_id: m.sourceId, mailbox: { ...summary } });
      return { ...base, status: "stored_unparsed", reason: err.message, sourceId: m.sourceId, mailbox: summary };
    });
  }
  const started = Date.now();
  await env.fenced(item, async (tx) => {
    const m = await admitMailbox(tx, planned, format, localPath, "processing", { mailbox_description: description, ...(passwordProtected ? { password_protected: true } : {}) });
    await flushPending(tx, env.state);
    const rows = segments.map((spec, i) => ({
      tenant_id: env.rec.resolvedTenantId, investigation_id: env.rec.investigationId, run_id: item.run_id, top_seq: item.top_seq, part_no: i + 1,
      kind: "mailbox-part", decision_id: item.decision_id, path: item.path, file_name: item.file_name, object_key: item.object_key, byte_size: item.byte_size,
      sha256: item.sha256, mailbox_format: format, spec: JSON.parse(JSON.stringify(spec)),
    }));
    rows.push({
      tenant_id: env.rec.resolvedTenantId, investigation_id: env.rec.investigationId, run_id: item.run_id, top_seq: item.top_seq, part_no: segments.length + 1,
      kind: "mailbox-finish", decision_id: item.decision_id, path: item.path, file_name: item.file_name, object_key: item.object_key, byte_size: item.byte_size,
      sha256: item.sha256, mailbox_format: format, spec: { parts: segments.length },
    });
    for (let i = 0; i < rows.length; i += 500) {
      await tx`INSERT INTO ingest_work ${tx(rows.slice(i, i + 500), "tenant_id", "investigation_id", "run_id", "top_seq", "part_no", "kind", "decision_id", "path", "file_name", "object_key", "byte_size", "sha256", "mailbox_format", "spec")}
               ON CONFLICT (run_id, top_seq, part_no) DO NOTHING`;
    }
    const head: MailboxHeadResult = { mailbox_source_id: m.sourceId, artifact_id: m.artifactId, format, parts: segments.length, folders_skipped: foldersSkipped, started_ms: started, password_protected: passwordProtected };
    await markDone(tx, item, { status: "processing", ...head });
  });
  return null;
}

// ── 2. A part ────────────────────────────────────────────────────────────────

/** The head's result, for its parts and its finish. */
export async function headOf(env: WorkEnv, item: WorkItem): Promise<MailboxHeadResult> {
  const rows = await withTenant(env.rec.resolvedTenantId, (tx) => tx<{ result: MailboxHeadResult | null }[]>`
    SELECT result FROM ingest_work WHERE tenant_id = ${env.rec.resolvedTenantId} AND run_id = ${item.run_id} AND top_seq = ${item.top_seq} AND part_no = 0 AND state = 'done'`, env.db);
  if (!rows[0]?.result?.mailbox_source_id) throw new Error(`${item.path}: the mailbox's head item is not written`);
  return rows[0].result;
}

/** A mailbox part's entries, and a node tree for each one (discovery). */
export async function discoverMailboxPart(env: WorkEnv, item: WorkItem, ctx: IngestItemContext, head: MailboxHeadResult, files: MailboxFiles): Promise<{ roots: PlanNode[]; contexts: Array<IngestItemContext | null> }> {
  const format = item.mailbox_format!;
  const spec = item.spec;
  const max = env.run.options.max_parse_bytes;
  const entries: MailboxEntry[] = [];
  let readerStopped: string | null = null;
  try {
    if (spec.kind === "error") {
      entries.push({ kind: "error", folder: (spec.folder as string[]) ?? [], locator: null, reason: String(spec.reason) });
    } else if (format === "mbox") {
      for await (const m of readMboxPart(mboxOpener(ctx, env.run.bucket, item.object_key), { start: Number(spec.start), end: Number(spec.end) }, { maxMessageBytes: max })) entries.push(mboxEntry(m, max));
    } else {
      const pst = files.openPst(await files.localPath(ctx, env.run.bucket, item.object_key));
      const part = { folder: (spec.folder as string[]) ?? [], folderNid: Number(spec.folder_nid), start: Number(spec.start), count: Number(spec.count) };
      for (const e of readPstPart(pst.file, part)) entries.push(pstEntry(e, max, pst.passwordProtected));
    }
  } catch (err: unknown) {
    if (err instanceof MailboxUnreadableError && item.part_no === 1) throw err;
    readerStopped = errMsg(err); // the reader itself failed: what was read stays; the summary says where it stopped
  }
  const counter: Counter = { n: 0 };
  const roots: PlanNode[] = [];
  const contexts: Array<IngestItemContext | null> = [];
  const mailbox = { sourceId: head.mailbox_source_id, artifactId: head.artifact_id, format };
  const errorNode = (i: number, path: string, fileName: string, reason: string, info: NonNullable<PlanNode["errorInfo"]>): PlanNode => ({
    index: counter.n++, parentIndex: null, entryIndex: i, depth: 0, path, fileName, byteSize: 0, sha256: null, messageHash: null, kind: "error",
    local: { error: reason }, children: [], errorInfo: info,
  });
  for (const [i, e] of entries.entries()) {
    if (e.kind === "folder-skipped") continue; // not produced by a part reader
    if (e.kind === "error") {
      const p = e.locator ? messagePath(ctx.sourcePath, e.folder, e.locator) : folderPath(ctx.sourcePath, e.folder);
      roots.push(errorNode(i, p, e.locator ?? (e.folder.join("/") || "(top)"), e.reason, { row: true, countsAsMessage: true, ...(e.locator ? {} : { stoppedAt: `${p}: ${e.reason}` }) }));
      contexts.push(null);
      continue;
    }
    const p = messagePath(ctx.sourcePath, e.folder, e.locator);
    let parsed: ParsedEmailResult;
    let hash: string;
    try {
      parsed = await parseEml(e.bytes);
      hash = await messageIdentity(parsed);
    } catch (err: unknown) {
      roots.push(errorNode(i, p, e.locator, `the message could not be read as an email: ${errMsg(err)}`, { row: true, countsAsMessage: true }));
      contexts.push(null);
      continue;
    }
    const mctx = { ...messageContext(ctx, mailbox, e, parsed, hash), order: { topSeq: item.top_seq, partNo: item.part_no, entryIndex: i } };
    const node = await discoverNode(mctx, null, i, counter, env.run.filters);
    node.kind = "message";
    node.messageHash = hash;
    node.entry = { folder: e.folder, locator: e.locator, rendered: e.rendered, meta: e.meta, truncated: e.meta.truncated === true };
    if (hasEmailFilters(env.run.filters)) {
      const d = emailFilterDecision(parsed.headers, env.run.filters);
      if (d.skip) node.local = { skip: { decision: "skip-filter", rule: d.rule, rule_version: d.version, reason: d.reason, filter: d.filter } };
    }
    roots.push(node);
    contexts.push(mctx);
  }
  if (readerStopped !== null) {
    const i = roots.length;
    roots.push(errorNode(i, ctx.sourcePath, ctx.fileName, `reading stopped: ${readerStopped}`, { row: false, countsAsMessage: true, stoppedAt: `after the part's ${i} entries: ${readerStopped}` }));
    contexts.push(null);
  }
  return { roots, contexts };
}

/** What a part found, as the part's result (the finish adds the parts up in order). */
interface PartSummary {
  messages_read: number;
  messages_admitted: number;
  messages_skipped: Record<string, number>;
  failed: number;
  attachments: { admitted: number; skipped: number; failed: number };
  errors: { path: string; reason: string }[];
  errors_not_listed: number;
  stopped_at?: string | undefined;
}

const emptyPart = (): PartSummary => ({ messages_read: 0, messages_admitted: 0, messages_skipped: {}, failed: 0, attachments: { admitted: 0, skipped: 0, failed: 0 }, errors: [], errors_not_listed: 0 });

function readPartSummary(v: unknown): PartSummary {
  const o = v && typeof v === "object" ? (v as Partial<PartSummary>) : {};
  return { ...emptyPart(), ...o, messages_skipped: { ...(o.messages_skipped ?? {}) }, attachments: { ...emptyPart().attachments, ...(o.attachments ?? {}) }, errors: [...(o.errors ?? [])] };
}

/**
 * Writes a part's entries from its progress on, one per transaction, each behind the fence and
 * moving the progress by one. Returns false when the part's decisions changed while it waited (the
 * caller waits for the sequencer again).
 */
export async function writeMailboxPart(env: WorkEnv, item: WorkItem, roots: PlanNode[], contexts: Array<IngestItemContext | null>, version: number, progress: number): Promise<boolean> {
  let summary = readPartSummary(item.result);
  const listError = (p: string, reason: string, countsAsMessage: boolean) => {
    if (countsAsMessage) summary.failed++;
    if (summary.errors.length < MAX_LISTED_ERRORS) summary.errors.push({ path: p, reason });
    else summary.errors_not_listed++;
  };
  for (let i = progress; i < roots.length; i++) {
    const node = roots[i]!;
    const mctx = contexts[i] ?? null;
    env.setActivity("writing", `${item.path} (part ${item.part_no}, entry ${i + 1} of ${roots.length})`);
    if (!(await env.waitForHolders(item, [node], version))) return false;
    const before = summary;
    summary = readPartSummary(JSON.parse(JSON.stringify(before)));
    try {
      const done = await env.fenced(item, async (tx, row) => {
        if (row.decide_version !== version) return "rewound" as const;
        if (row.progress > i) return "written" as const; // written already (this item done twice)
        await writeEntry(tx, env, item, node, mctx, summary, listError);
        await tx`UPDATE ingest_work SET progress = ${i + 1}, result = ${tx.json(JSON.parse(JSON.stringify(summary)))}, updated_at = NOW() WHERE id = ${item.id}`;
        return "ok" as const;
      });
      if (done === "rewound") {
        summary = before;
        return false;
      }
      if (done === "written") summary = before;
    } catch (err: unknown) {
      discardPending(env.state);
      if (err instanceof Error && err.name === "LeaseLostError") throw err;
      // The message could not be written: it is listed, the part goes on (BIGDATA-3B).
      summary = before;
      const p = node.path;
      listError(p, `the message could not be ingested: ${errMsg(err)}`, true);
      await env.fenced(item, async (tx) => {
        await recordNotIngested(tx, env.rec, { filename: node.fileName, filePath: p, byteSize: 0, sha256: "not read", status: "failed", reason: `the message could not be ingested: ${errMsg(err)}` }, "error");
        await tx`UPDATE ingest_work SET progress = ${i + 1}, result = ${tx.json(JSON.parse(JSON.stringify(summary)))}, updated_at = NOW() WHERE id = ${item.id}`;
      });
    }
    if (node.kind === "message" && summary.messages_read % 100 === 0) env.onMailboxProgress?.(item.path, summary.messages_read);
  }
  await env.fenced(item, async (tx) => {
    await markDone(tx, item, { ...summary }, roots.length);
  });
  return true;
}

/** One entry of a part, in its transaction (the rows BIGDATA-3B wrote for one message). */
async function writeEntry(tx: Tx, env: WorkEnv, item: WorkItem, node: PlanNode, mctx: IngestItemContext | null, summary: PartSummary, listError: (p: string, reason: string, countsAsMessage: boolean) => void): Promise<void> {
  const d = node.decision!;
  if (node.kind === "error") {
    const reason = node.local && "error" in node.local ? node.local.error : "unreadable";
    listError(node.path, reason, node.errorInfo?.countsAsMessage ?? true);
    if (node.errorInfo?.stoppedAt) summary.stopped_at = node.errorInfo.stoppedAt;
    if (node.errorInfo?.row !== false) await recordNotIngested(tx, env.rec, { filename: node.fileName, filePath: node.path, byteSize: 0, sha256: "not read", status: "failed", reason }, "error");
    return;
  }
  summary.messages_read++;
  if (node.entry?.truncated) summary.stopped_at = `${node.path}: the file ends inside this message (it is kept, marked truncated)`;
  const ctx: IngestItemContext = { ...mctx!, run: env.state, plan: node };
  if (d.decision === "skip-filter") {
    const skip = node.local && "skip" in node.local ? node.local.skip : null;
    ingestStageDecision(ctx, { decision: "skip-filter", rule: skip!.rule, rule_version: skip!.rule_version, reason: skip!.reason, filter: skip!.filter });
    await flushPending(tx, env.state);
    summary.messages_skipped[skip!.rule] = (summary.messages_skipped[skip!.rule] ?? 0) + 1;
    return;
  }
  if (d.decision === "skip-duplicate" && d.duplicateRule === "message-duplicate") {
    ingestStageDecision(ctx, {
      decision: "skip-duplicate",
      rule: "message-duplicate",
      rule_version: RULE_VERSIONS["message-duplicate"],
      reason: `same message as ${d.duplicateOfPath} (same message identity: Message-ID, Date, From, To, Cc, Bcc, Subject, body and attachments)`,
      duplicate_of_path: d.duplicateOfPath,
      duplicate_of_source_id: d.duplicateOfSourceId,
    });
    await flushPending(tx, env.state);
    summary.messages_skipped["message-duplicate"] = (summary.messages_skipped["message-duplicate"] ?? 0) + 1;
    return;
  }
  const r = await processSingleItem(tx, ctx);
  await flushPending(tx, env.state);
  if (r.status === "skipped") summary.messages_skipped["exact-duplicate"] = (summary.messages_skipped["exact-duplicate"] ?? 0) + 1;
  else summary.messages_admitted++;
  const walk = (c: IngestFileResult) => {
    if (c.status === "skipped") summary.attachments.skipped++;
    else if (c.status === "failed" || c.status === "unprocessable") summary.attachments.failed++;
    else summary.attachments.admitted++;
    c.childResults?.forEach(walk);
  };
  r.childResults?.forEach(walk);
  // An attachment the PST reader could not take out of the file (damaged, a reference, too large) is
  // listed like any unreadable item: a source.ingest_failed row with its path.
  if (r.status !== "skipped") {
    const notRead = Array.isArray(node.entry?.meta.attachments_not_read) ? (node.entry!.meta.attachments_not_read as { name: string; reason: string }[]) : [];
    for (const a of notRead) {
      summary.attachments.failed++;
      listError(`${node.path}#attachment:${a.name}`, `attachment not read: ${a.reason}`, false);
      await recordNotIngested(tx, env.rec, { filename: a.name, filePath: `${node.path}#attachment:${a.name}`, byteSize: 0, sha256: "not read", status: "failed", reason: `attachment not read: ${a.reason}` }, "error");
    }
  }
}

/** The nodes of a part (for a caller that needs every node, e.g. to load decisions). */
export const partNodes = (roots: PlanNode[]) => preorder(roots);

// ── 3. The finish ────────────────────────────────────────────────────────────

/** Writes the mailbox's status and summary once all its parts are done. Returns the mailbox's result. */
export async function writeMailboxFinish(env: WorkEnv, item: WorkItem, ctx: IngestItemContext): Promise<IngestFileResult> {
  const head = await headOf(env, item);
  const summary = emptyMailboxSummary(head.format);
  if (head.password_protected) summary.password_protected = true;
  summary.folders_skipped = head.folders_skipped;
  const parts = await withTenant(env.rec.resolvedTenantId, (tx) => tx<{ part_no: number; state: string; result: unknown; last_error: string | null }[]>`
    SELECT part_no, state, result, last_error FROM ingest_work
    WHERE tenant_id = ${env.rec.resolvedTenantId} AND run_id = ${item.run_id} AND top_seq = ${item.top_seq} AND kind = 'mailbox-part' ORDER BY part_no`, env.db);
  for (const p of parts) {
    const s = readPartSummary(p.result);
    summary.messages_read += s.messages_read;
    summary.messages_admitted += s.messages_admitted;
    for (const [k, v] of Object.entries(s.messages_skipped)) summary.messages_skipped[k] = (summary.messages_skipped[k] ?? 0) + v;
    summary.failed += s.failed;
    summary.attachments.admitted += s.attachments.admitted;
    summary.attachments.skipped += s.attachments.skipped;
    summary.attachments.failed += s.attachments.failed;
    for (const e of s.errors) {
      if (summary.errors.length < MAX_LISTED_ERRORS) summary.errors.push(e);
      else summary.errors_not_listed++;
    }
    summary.errors_not_listed += s.errors_not_listed;
    if (s.stopped_at) summary.stopped_at = s.stopped_at;
    if (p.state === "failed") {
      summary.failed++;
      const e = { path: `${item.path} (part ${p.part_no})`, reason: `this part of the mailbox failed and was not read to its end: ${p.last_error ?? "unknown error"}` };
      if (summary.errors.length < MAX_LISTED_ERRORS) summary.errors.push(e);
      else summary.errors_not_listed++;
    }
  }
  return env.fenced(item, async (tx) => {
    summary.near_duplicates = await countNearDuplicates(tx, env.rec, item.run_id, item.top_seq);
    summary.seconds = (Date.now() - head.started_ms) / 1000;
    await finishMailbox(tx, ctx, head.mailbox_source_id, head.artifact_id, summary, "ready");
    await markDone(tx, item, { status: "indexed", source_id: head.mailbox_source_id, mailbox: { ...summary, seconds: Math.round(summary.seconds * 10) / 10 } });
    return { filename: ctx.fileName, filePath: ctx.sourcePath, byteSize: ctx.byteSize, sha256: ctx.sha256, status: "indexed" as const, sourceId: head.mailbox_source_id, mailbox: summary };
  });
}
