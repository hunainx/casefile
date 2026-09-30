import { spawn } from "node:child_process";
import { resolve, basename, extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, getDbUrl, jsonb, type Tx } from "@casefile/db";
import { writeAuditRow } from "./audit-buffer.js";
import { getObjectStore, createSourceStorageKey, computeSha256 } from "@casefile/storage";
import { parsePdfStructure } from "../../../apps/api/src/services/pdf-parser.js";
import {
  parseDocx,
  parseDoc,
  parseSpreadsheet,
  parseHtml,
  parseRtf,
  parseEml,
  parseMsg,
  extractZipArchive,
  ZipBombError,
  type ParsedBlock,
  type ParsedEmailResult,
  type ZipGuardOptions,
} from "../../../apps/api/src/services/document-parsers.js";
import { parseArgs, loadEnv } from "./args.js";
import { insertContentBlockRows, insertChunkRows, insertBatches, type ContentBlockRow, type ChunkRow } from "./batch-insert.js";
import { fullTextToStore } from "../../../apps/api/src/services/document-text.js";
import {
  collectFiles,
  isPipelineSidecar,
  allowedIngestBuckets,
  assertBucketBoundToMatter,
  recordDecisions,
  resolveRecordContext,
  triageDirectory,
  triageBucketObjects,
  triageOnly,
  readEmailHeaders,
  type RecordContext,
  type DecisionRow,
  type TriageItem,
  type TriageStats,
} from "./triage.js";
import {
  RULE_VERSIONS,
  junkRule,
  emailFilterDecision,
  fileDateDecision,
  hasEmailFilters,
  hasFileDateFilter,
  isEmailName,
  parseFilterArgs,
  filtersToRecord,
  type TriageFilters,
  type FilterRecord,
} from "./triage-rules.js";
import { minhashSignature, fingerprintText, signatureToBytes } from "./near-duplicates.js";
import type { PlanNode } from "./plan.js";
import { mailboxFormatByName } from "./mailbox.js";
import type { MailboxReadSummary } from "./mailbox-ingest.js";
import { enqueueRun } from "./queue.js";
import { runWorker, type WorkerHooks } from "./worker.js";
import { getRunStatus, formatRunStatus } from "./run-status.js";
import { DEFAULT_MBOX_PART_BYTES, DEFAULT_PST_PART_MESSAGES, type RunOptions } from "./work-env.js";

// The walk, the sidecar rule and the bucket binding moved to triage.ts in BIGDATA-3.
export { collectFiles, isPipelineSidecar, allowedIngestBuckets, assertBucketBoundToMatter, triageOnly };
export type { WalkEntry } from "./triage.js";

loadEnv();

export interface IngestFileResult {
  filename: string;
  filePath: string;
  byteSize: number;
  sha256: string;
  status: "indexed" | "stored_unparsed" | "needs_ocr" | "unprocessable" | "skipped" | "failed";
  reason?: string;
  sourceId?: string;
  childResults?: IngestFileResult[] | undefined;
  /** An include of a skipped duplicate: recorded as another copy of this source (D103). */
  linkedCopyOf?: string | undefined;
  /** A mailbox file (BIGDATA-3B): what reading its messages found. Its messages are not listed here. */
  mailbox?: MailboxReadSummary | undefined;
}

export interface IngestBatchSummary {
  totalFiles: number;
  admitted: number;
  parsed: number;
  needsOcr: number;
  storedUnparsed: number;
  skipped: number;
  skippedSidecars: number;
  failed: number;
  results: IngestFileResult[];
  /** BIGDATA-3: the run this ingest recorded (ingest_runs), and what triage decided. */
  runId: string;
  triage: TriageStats;
  timings: { triageMs: number; nearDuplicateMs: number };
  /** Documents this run linked to the first document of a near-duplicate group. */
  nearDuplicates: number;
  /** BIGDATA-3B: every mailbox file of the run, with what reading it found. */
  mailboxes: Array<{ path: string } & MailboxReadSummary>;
}

export interface IngestOptions {
  dir: string;
  investigationId: string;
  tenantId?: string;
  dbUrl?: string;
  userId?: string;
  includeSidecars?: boolean;
  zipOptions?: ZipGuardOptions;
  /** Files above this size are stored and hashed by streaming, not parsed (default DEFAULT_MAX_PARSE_BYTES, D93). */
  maxParseBytes?: number;
  /** The case owner's filters for this run (answer 5, D102). Default: none. */
  filters?: TriageFilters | undefined;
  onFileResult?: (result: IngestFileResult) => void;
  /** BIGDATA-3B: called every 100 messages read out of a mailbox file. */
  onMailboxProgress?: ((path: string, messagesRead: number) => void) | undefined;
  /** BIGDATA-4: worker loops in this process (default 1). `pnpm ingest --workers N` starts N processes instead. */
  workers?: number | undefined;
  /** BIGDATA-4, tests only: called by every worker at points of an item's life (runWorker). */
  workerHooks?: WorkerHooks | undefined;
  /** BIGDATA-4: the lease a worker takes on an item, in seconds (default INGEST_LEASE_SECONDS or 90). */
  leaseSeconds?: number | undefined;
  /** BIGDATA-4: how big mailboxes are split (recorded on the run; default 50 messages a PST part, 16 MiB an MBOX part). */
  mailboxParts?: MailboxPartOptions | undefined;
}

/** BIGDATA-4: the size of a mailbox's parts (plan section 16). */
export interface MailboxPartOptions {
  pstMessages?: number | undefined;
  mboxBytes?: number | undefined;
}

export interface IngestBucketOptions {
  bucket: string;
  prefix?: string | undefined;
  investigationId: string;
  tenantId?: string;
  dbUrl?: string;
  userId?: string;
  includeSidecars?: boolean;
  zipOptions?: ZipGuardOptions;
  /** Objects above this size are hashed by streaming, not parsed (default DEFAULT_MAX_PARSE_BYTES, D93). */
  maxParseBytes?: number;
  /** The case owner's filters for this run (answer 5, D102). Default: none. */
  filters?: TriageFilters | undefined;
  onFileResult?: (result: IngestFileResult) => void;
  /** BIGDATA-3B: called every 100 messages read out of a mailbox file. */
  onMailboxProgress?: ((path: string, messagesRead: number) => void) | undefined;
  workers?: number | undefined;
  workerHooks?: WorkerHooks | undefined;
  leaseSeconds?: number | undefined;
  mailboxParts?: MailboxPartOptions | undefined;
}

/**
 * Files above this size are never read whole or parsed in this version: they are hashed and
 * stored by streaming and listed as too large to parse (D93). Parsing needs the whole file in
 * memory and the parsers build several times its size on top (measured on the fake corpus: 7.9x
 * for a 3.7 MB email, 4.4x for a 1.7 MB zip), so a 256 MiB file can take about 2 GB; a
 * JavaScript string cannot exceed about 512 M characters, and one Postgres value cannot exceed
 * 1 GB. 256 MiB stays under all three. Every file in the fake corpus is under 4 MB, so no
 * measured run reaches it.
 */
export const DEFAULT_MAX_PARSE_BYTES = 256 * 1024 * 1024;

export function getMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  switch (ext) {
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".doc":
      return "application/msword";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".csv":
      return "text/csv";
    case ".tsv":
      return "text/tab-separated-values";
    case ".html":
    case ".htm":
      return "text/html";
    case ".rtf":
      return "application/rtf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".eml":
      return "message/rfc822";
    case ".msg":
      return "application/vnd.ms-outlook";
    case ".zip":
      return "application/zip";
    case ".pst":
      return "application/vnd.ms-outlook-pst";
    case ".ost":
      return "application/vnd.ms-outlook-ost";
    case ".mbox":
    case ".mbx":
      return "application/mbox";
    default:
      return "application/octet-stream";
  }
}

export interface IngestItemContext {
  resolvedTenantId: string;
  workspaceId: string;
  investigationId: string;
  actorId: string;
  fileName: string;
  sourcePath: string;
  fileBytes: Buffer;
  byteSize: number;
  sha256: string;
  isBucketSource: boolean;
  bucketSources: string;
  /** Nothing is written here since BIGDATA-2B (D95); kept for derived outputs such as OCR (plan §4). */
  bucketArtifacts: string;
  parentSourceId?: string;
  parentArtifactId?: string;
  sourceMetadata?: Record<string, unknown>;
  zipOptions?: ZipGuardOptions | undefined;
  /**
   * Set when the file is above the parse size limit (D93): fileBytes is then empty, the file is
   * stored from `localPath` by streaming (directory mode) or is already in the bucket, and it is
   * admitted as too large to parse.
   */
  tooLargeToParse?: { limitBytes: number; localPath?: string } | undefined;
  /** BIGDATA-3: the run this item belongs to (decisions, filters, near-duplicate index). */
  run?: RunState | undefined;
  /** The triage decision of a top-level object, which an ingest-stage decision may supersede. */
  triageDecisionId?: string | undefined;
  /** `pnpm ingest:include` (D103): a duplicate is linked as another copy instead of skipped. */
  reinclude?: boolean | undefined;
  /** A zip entry's own modification time, for the file-date filter. */
  entryModified?: Date | null | undefined;
  /** BIGDATA-3B: an email the caller has parsed already (a mailbox message): not parsed again. */
  preParsedEmail?: ParsedEmailResult | undefined;
  /** BIGDATA-3B: the caller applied the triage rules to this item already (a mailbox message). */
  triagedByCaller?: boolean | undefined;
  /**
   * BIGDATA-4: the item's discovery node for this object, with the sequencer's decision. When it is
   * set, the duplicate lookups are replaced by that decision, the source id is the one the sequencer
   * gave, and a zip's entries and an email's attachments come from the node (nothing is read twice).
   */
  plan?: PlanNode | undefined;
  /** BIGDATA-4: where the item is in reading order, for the near-duplicate pass (top_seq, part_no, entry). */
  order?: { topSeq: number; partNo: number; entryIndex: number } | undefined;
}

/**
 * A written document's MinHash signature, waiting for the ordered near-duplicate pass
 * (ingest_signatures, migration 0031). BIGDATA-4: the index is in the database (document_lsh), and
 * the pass groups documents in reading order, so no worker holds the matter's signatures in memory.
 */
interface SignatureRow {
  tenant_id: string;
  investigation_id: string;
  run_id: string;
  top_seq: number;
  part_no: number;
  entry_index: number;
  node_index: number;
  source_id: string;
  content_document_id: string;
  shingle_count: number;
  signature: Buffer;
}
const SIGNATURE_COLUMNS = [
  "tenant_id", "investigation_id", "run_id", "top_seq", "part_no", "entry_index", "node_index", "source_id", "content_document_id", "shingle_count", "signature",
] as const satisfies readonly (keyof SignatureRow)[];

/**
 * What a worker carries while it writes an item (BIGDATA-3, BIGDATA-4): the run's id and record
 * context, the owner's filters, and the decisions and signatures of the current transaction.
 */
export interface RunState {
  runId: string;
  rec: RecordContext;
  filters: TriageFilters;
  pendingDecisions: DecisionRow[];
  pendingSignatures: SignatureRow[];
  timings: { triageMs: number; nearDuplicateMs: number };
  nearDuplicates: number;
  /** A run without a queue (an include) numbers its documents in the order it writes them. */
  nextOrder: number;
}

/** Opens a run's state. Nothing about the matter's other documents is loaded (BIGDATA-4: memory stays flat). */
export async function openRunState(_db: ReturnType<typeof postgres>, rec: RecordContext, runId: string, filters: TriageFilters, triageMs: number): Promise<RunState> {
  return { runId, rec, filters, pendingDecisions: [], pendingSignatures: [], timings: { triageMs, nearDuplicateMs: 0 }, nearDuplicates: 0, nextOrder: 0 };
}

/** A decision the ingest stage makes for an item it reached (inside a zip or an email, or a late duplicate). */
export function ingestStageDecision(ctx: IngestItemContext, d: Pick<DecisionRow, "decision" | "rule" | "reason"> & Partial<DecisionRow>): void {
  const run = ctx.run!;
  run.pendingDecisions.push({
    id: randomUUID(), tenant_id: ctx.resolvedTenantId, investigation_id: ctx.investigationId, run_id: run.runId, stage: "ingest",
    path: ctx.sourcePath, byte_size: ctx.byteSize, sha256: /^[0-9a-f]{64}$/.test(ctx.sha256) ? ctx.sha256 : null, crc32c: null, generation: null,
    rule_version: d.rule ? RULE_VERSIONS[d.rule as keyof typeof RULE_VERSIONS] : null,
    duplicate_of_path: null, duplicate_of_decision_id: null, duplicate_of_source_id: null, filter: null, supersedes: null, created_by: ctx.actorId,
    ...d,
  });
}

/** A skip the rules make from an item alone (junk, empty, the owner's filters), as a decision's fields. */
export interface ChildSkip {
  decision: "skip-junk" | "skip-filter";
  rule: string;
  rule_version: number;
  reason: string;
  filter: FilterRecord | null;
}

/**
 * The triage rules for an item the walk could not see: a zip entry or an email attachment, judged
 * when the ingest reaches it (stage 'ingest'). Junk names and empty files; then the owner's email
 * filters for an email, or the file-date filter for a zip entry (by the date the zip records;
 * an attachment has none, so it is kept). Returns the skip, or null to ingest it. Nothing is written
 * here: BIGDATA-4's discovery calls it too.
 */
export async function childTriageDecision(ctx: Pick<IngestItemContext, "fileName" | "byteSize" | "fileBytes" | "entryModified">, filters: TriageFilters): Promise<ChildSkip | null> {
  const junk = junkRule(ctx.fileName, ctx.byteSize);
  if (junk) return { decision: "skip-junk", rule: junk.rule, rule_version: junk.version, reason: junk.reason, filter: null };
  if (isEmailName(ctx.fileName)) {
    if (!hasEmailFilters(filters)) return null;
    const headers = await readEmailHeaders(ctx.fileName, ctx.fileBytes).catch(() => null);
    if (!headers) return null; // unreadable headers: kept (the email branch records its own outcome)
    const d = emailFilterDecision(headers, filters);
    if (!d.skip) return null;
    return { decision: "skip-filter", rule: d.rule, rule_version: d.version, reason: d.reason, filter: d.filter };
  }
  if (!hasFileDateFilter(filters)) return null;
  const d = fileDateDecision(ctx.entryModified ?? null, filters);
  if (!d.skip) return null;
  return { decision: "skip-filter", rule: d.rule, rule_version: d.version, reason: d.reason, filter: d.filter };
}

/** childTriageDecision (or the decision discovery made), written as an ingest-stage decision. */
async function childTriage(ctx: IngestItemContext): Promise<IngestFileResult | null> {
  const run = ctx.run!;
  const planned = ctx.plan && ctx.plan.local && "skip" in ctx.plan.local ? ctx.plan.local.skip : null;
  const d = ctx.plan ? planned : await childTriageDecision(ctx, run.filters);
  if (!d) return null;
  ingestStageDecision(ctx, { decision: d.decision, rule: d.rule, rule_version: d.rule_version, reason: d.reason, filter: d.filter });
  return { filename: ctx.fileName, filePath: ctx.sourcePath, byteSize: ctx.byteSize, sha256: ctx.sha256, status: "skipped", reason: d.reason };
}

/**
 * The near-duplicate rule (answer 4, D101): the document's MinHash signature, written with the
 * document (ingest_signatures) at its place in reading order. BIGDATA-4: the group is found by the
 * ordered near-duplicate pass (near-duplicate-pass.ts), which writes the fingerprint row, so the
 * group a document joins does not depend on which worker wrote it first. The document is indexed either way.
 */
function fingerprintDocument(ctx: IngestItemContext, sourceId: string, contentDocId: string, blocks: ReadonlyArray<{ block_type: string; text: string }>): void {
  const run = ctx.run;
  if (!run) return;
  const t0 = performance.now();
  const sig = minhashSignature(fingerprintText(blocks));
  if (sig) {
    const order = ctx.order ?? { topSeq: run.nextOrder, partNo: 0, entryIndex: 0 };
    run.pendingSignatures.push({
      tenant_id: ctx.resolvedTenantId, investigation_id: ctx.investigationId, run_id: run.runId,
      top_seq: order.topSeq, part_no: order.partNo, entry_index: order.entryIndex, node_index: ctx.plan?.index ?? run.pendingSignatures.length,
      source_id: sourceId, content_document_id: contentDocId, shingle_count: sig.shingles, signature: signatureToBytes(sig.values),
    });
  }
  run.timings.nearDuplicateMs += performance.now() - t0;
}

/** Writes the current transaction's pending decisions (with their audit rows) and signatures. */
export async function flushPending(tx: Tx, run: RunState): Promise<void> {
  await recordDecisions(tx, run.rec, run.pendingDecisions);
  const t0 = performance.now();
  for (const batch of insertBatches(run.pendingSignatures, () => 1100)) {
    await tx`INSERT INTO ingest_signatures ${tx(batch, ...SIGNATURE_COLUMNS)} ON CONFLICT (content_document_id) DO NOTHING`;
  }
  run.timings.nearDuplicateMs += performance.now() - t0;
  run.pendingDecisions = [];
  run.pendingSignatures = [];
}

/** The current transaction rolled back: what it had pending goes with it. */
export function discardPending(run: RunState): void {
  run.pendingDecisions = [];
  run.pendingSignatures = [];
}

/**
 * One top-level object in one transaction: processSingleItem, then the file's decisions and
 * fingerprints, then (for an include) the caller's own rows. A failure rolls all of it back.
 */
export async function ingestInTransaction(
  db: ReturnType<typeof postgres>,
  ctx: IngestItemContext,
  after?: (tx: Tx, result: IngestFileResult) => Promise<void>,
): Promise<IngestFileResult> {
  try {
    const result = await withTenant(ctx.resolvedTenantId, async (tx) => {
      const r = await processSingleItem(tx, ctx);
      if (ctx.run) await flushPending(tx, ctx.run);
      if (after) await after(tx, r);
      return r;
    }, db);
    if (ctx.run) ctx.run.nextOrder++;
    return result;
  } catch (err) {
    if (ctx.run) discardPending(ctx.run);
    throw err;
  }
}

/**
 * Records in the database a file that was not ingested (F1, D90), as an audit row in the given
 * transaction: `source.skip` (a duplicate, a pipeline sidecar, a symbolic link ...) or
 * `source.ingest_failed`, with the path, the reason and the rule. A duplicate's row points at the
 * source it duplicates; anything else points at the investigation. Since BIGDATA-3 a skip that is
 * a decision is recorded by recordDecisions (triage.ts) instead; this stays for failures, for the
 * link of a copy that is in another investigation, and for callers without a run.
 */
export async function recordNotIngested(
  tx: Tx,
  ctx: RecordContext,
  res: IngestFileResult,
  rule: "duplicate" | "sidecar" | "walk" | "error",
  duplicateOf?: string,
): Promise<void> {
  const failed = res.status === "failed";
  await writeAuditRow(tx, {
    tenantId: ctx.resolvedTenantId,
    workspaceId: ctx.workspaceId,
    investigationId: ctx.investigationId,
    actorType: "user",
    actorId: ctx.actorId,
    actorDisplay: "Ingest CLI",
    action: failed ? "source.ingest_failed" : "source.skip",
    objectType: duplicateOf ? "source" : "investigation",
    objectId: duplicateOf ?? ctx.investigationId,
    objectDisplay: res.filename,
    after: {
      path: res.filePath,
      reason: res.reason,
      rule,
      byte_size: res.byteSize,
      ...(/^[0-9a-f]{64}$/.test(res.sha256) ? { sha256: res.sha256 } : {}),
    },
    outcome: failed ? "failure" : "success",
    requestId: randomUUID(),
  });
}

/**
 * The same record in a transaction of its own, for files that never reached one (walk skips,
 * sidecars) or whose own transaction rolled back (failures). If even that cannot be written, the
 * result says so: the file is still listed in the ingest output.
 */
export async function recordNotIngestedAlone(
  db: ReturnType<typeof postgres>,
  ctx: RecordContext,
  res: IngestFileResult,
  rule: "sidecar" | "walk" | "error",
): Promise<void> {
  try {
    await withTenant(ctx.resolvedTenantId, (tx) => recordNotIngested(tx, ctx, res, rule), db);
  } catch (err: unknown) {
    res.reason = `${res.reason} (not recorded in the database: ${err instanceof Error ? err.message : String(err)})`;
  }
}

const fmtBytes = (n: number) => `${n.toLocaleString("en-US")} bytes`;

/**
 * Inserts content blocks and chunk records for a parsed document, as multi-row INSERTs
 * (batch-insert.ts, D89): all the blocks first, then all the chunks, in the parser's order.
 */
async function insertDocumentBlocksAndChunks(
  tx: Tx,
  ctx: IngestItemContext,
  sourceId: string,
  contentDocId: string,
  fileName: string,
  docType: string,
  blocks: ParsedBlock[]
): Promise<void> {
  const { resolvedTenantId, investigationId, actorId } = ctx;

  const blockRows: ContentBlockRow[] = blocks.map((block) => ({
    id: randomUUID(),
    tenant_id: resolvedTenantId,
    content_document_id: contentDocId,
    sequence: block.sequence,
    block_type: block.block_type,
    section_path: block.section_path,
    page: block.page,
    char_start: block.char_start,
    char_end: block.char_end,
    text: block.text,
    language: "en",
    // No OCR ran: the text comes from the file's own text layer (F6, D92; it used to say 1.0).
    ocr_confidence: null,
    created_by: actorId,
  }));

  const chunkRows: ChunkRow[] = blocks.map((b, i) => {
    const pageLabel = b.page !== null ? `Page ${b.page}, ` : "";
    return {
      id: randomUUID(),
      tenant_id: resolvedTenantId,
      investigation_id: investigationId,
      content_document_id: contentDocId,
      block_ids: [blockRows[i]!.id],
      char_start: b.char_start,
      char_end: b.char_end,
      // Text stored once (D94): the chunk is exactly its one block, whose text is the copy.
      text: null,
      contextual_header: `Document '${fileName}', ${pageLabel}${b.section_path || "Section"}`,
      token_count: Math.max(1, Math.round(b.text.length / 4)),
      doc_type: docType,
      created_by: actorId,
    };
  });

  await insertContentBlockRows(tx, blockRows);
  await insertChunkRows(tx, chunkRows);
  fingerprintDocument(ctx, sourceId, contentDocId, blocks);
}

/**
 * Admits a file without reading its content: it is stored (from memory, or by streaming from
 * disk, or it is already in the bucket), gets its source, acquisition and instance rows and its
 * source.admit audit row, and no artifact and no text rows, with status stored_unparsed and the
 * reason in the source's metadata, the audit row and the result.
 * - an empty file (F2, D91): there is no text to index, so it is not a document;
 * - a file above the parse size limit (F5, D93): "too large to parse in this version".
 */
async function admitWithoutParsing(tx: Tx, ctx: IngestItemContext, notReadReason?: string): Promise<IngestFileResult> {
  const { resolvedTenantId, workspaceId, investigationId, actorId, fileName, sourcePath, fileBytes, byteSize, sha256 } = ctx;
  const tooLarge = ctx.tooLargeToParse;
  const reason = notReadReason
    ? notReadReason
    : tooLarge
    ? `too large to parse in this version (${fmtBytes(byteSize)}; the limit is ${fmtBytes(tooLarge.limitBytes)})`
    : "empty file (0 bytes): nothing to index";
  const mimeType = getMimeType(fileName);

  let storageUri: string;
  if (ctx.isBucketSource) {
    storageUri = sourcePath;
  } else {
    const storageKey = createSourceStorageKey(resolvedTenantId, investigationId, sha256);
    const putOpts = { contentType: mimeType, metadata: { filename: fileName } };
    if (tooLarge?.localPath) await getObjectStore().putFile(storageKey, tooLarge.localPath, { ...putOpts, sha256 });
    else await getObjectStore().put(storageKey, fileBytes, putOpts);
    storageUri = `gcs://${ctx.bucketSources}/${storageKey}`;
  }

  const metadata = {
    source_path: sourcePath,
    ...(ctx.parentSourceId ? { parent_file_id: ctx.parentSourceId } : {}),
    ...(ctx.sourceMetadata || {}),
    unparsed_reason: notReadReason ? "mailbox_in_container" : tooLarge ? "too_large_to_parse" : "empty_file",
    ...(tooLarge ? { parse_limit_bytes: tooLarge.limitBytes } : {}),
  };
  const sourceId = ctx.plan?.decision?.sourceId ?? randomUUID();
  await tx`
    INSERT INTO sources (
      id, tenant_id, workspace_id, investigation_id, filename,
      mime_type, byte_size, sha256, storage_uri, status,
      source_class, metadata, is_encrypted, created_by
    )
    VALUES (
      ${sourceId}, ${resolvedTenantId}, ${workspaceId}, ${investigationId},
      ${fileName}, ${mimeType}, ${byteSize}, ${sha256}, ${storageUri},
      'stored_unparsed', ${extname(fileName).toLowerCase() === ".eml" || extname(fileName).toLowerCase() === ".msg" ? "communication" : "primary_record"},
      ${jsonb(tx, metadata)}, false, ${actorId}
    );
  `;
  const acqId = randomUUID();
  await tx`
    INSERT INTO acquisition_records (
      id, tenant_id, source_id, origin, custodian, acquisition_method,
      obtained_at, declared_by, created_by
    )
    VALUES (
      ${acqId}, ${resolvedTenantId}, ${sourceId},
      ${ctx.isBucketSource ? "GCS Bucket Import" : "CLI Folder Import"},
      ${ctx.isBucketSource ? "GCS Ingestion Operator" : "Local Ingestion Operator"},
      'folder_import',
      NOW(), ${actorId}, ${actorId}
    );
  `;
  await tx`
    INSERT INTO source_instances (
      id, tenant_id, source_id, acquisition_record_id, investigation_id, created_by
    )
    VALUES (
      ${randomUUID()}, ${resolvedTenantId}, ${sourceId}, ${acqId}, ${investigationId}, ${actorId}
    );
  `;
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
    after: { filename: fileName, sha256, status: "stored_unparsed", is_supported: false, reason },
    outcome: "success",
    requestId: randomUUID(),
  });
  return { filename: fileName, filePath: sourcePath, byteSize, sha256, status: "stored_unparsed", reason, sourceId };
}

export async function processSingleItem(
  tx: Tx,
  ctx: IngestItemContext
): Promise<IngestFileResult> {
  const { fileName, byteSize, parentSourceId } = ctx;

  // 0. BIGDATA-3: an item inside a zip or an email is judged by the triage rules when it is reached.
  if (parentSourceId && ctx.run && !ctx.triagedByCaller) {
    const skippedChild = await childTriage(ctx);
    if (skippedChild) return skippedChild;
  }

  // 1. The same bytes already a source of the workspace (skipped, or linked to this investigation).
  //    BIGDATA-4: with a plan, the sequencer decided this in reading order; nothing is looked up here.
  const existingOutcome = ctx.plan ? await plannedExistingOutcome(tx, ctx) : await existingSourceOutcome(tx, ctx);
  if (existingOutcome) return existingOutcome;

  // 1b. Admitted but not parsed: an empty file (F2, D91) or one above the parse size limit (F5, D93).
  if (ctx.tooLargeToParse || byteSize === 0) {
    return admitWithoutParsing(tx, ctx);
  }

  // 1c. BIGDATA-3B: a mailbox inside a zip or an email is stored, not read (its messages are read
  // one by one only when the mailbox is ingested on its own).
  if (parentSourceId && mailboxFormatByName(fileName)) {
    return admitWithoutParsing(tx, ctx, "mailbox inside a zip or an email: stored, not read in this version (ingest the mailbox file on its own to read its messages)");
  }

  return parseAndIndex(tx, ctx);
}

/**
 * Step 1 of processSingleItem (moved here unchanged in BIGDATA-3B, so the mailbox admission uses it
 * too): a source of the workspace with the same SHA-256. Already in this investigation: skipped
 * (an include links it as another copy, D103). Only in another investigation: linked here. Returns
 * null when the bytes are new.
 */
export async function existingSourceOutcome(tx: Tx, ctx: IngestItemContext): Promise<IngestFileResult | null> {
  const { resolvedTenantId, workspaceId, investigationId, actorId, fileName, sourcePath, byteSize, sha256, isBucketSource, parentSourceId } = ctx;
  const existingSourceRows = await tx<{ id: string; filename: string; status: string; metadata: unknown }[]>`
    SELECT id, filename, status, metadata
    FROM sources
    WHERE workspace_id = ${workspaceId}
      AND tenant_id = ${resolvedTenantId}
      AND sha256 = ${sha256}
      AND status NOT IN ('purged', 'quarantined')
      AND deleted_at IS NULL
    LIMIT 1;
  `;

  if (existingSourceRows.length > 0 && existingSourceRows[0]) {
    const existingSource = existingSourceRows[0];

    // Check if already linked to this investigation
    const instanceRows = await tx<{ id: string }[]>`
      SELECT id FROM source_instances
      WHERE source_id = ${existingSource.id}
        AND investigation_id = ${investigationId}
        AND tenant_id = ${resolvedTenantId}
      LIMIT 1;
    `;

    if (instanceRows.length > 0 && !ctx.reinclude) {
      const skipped: IngestFileResult = {
        filename: fileName,
        filePath: sourcePath,
        byteSize,
        sha256,
        status: "skipped",
        reason: "already ingested in investigation",
        sourceId: existingSource.id,
      };
      if (ctx.run) {
        // BIGDATA-3: a decision of the ingest stage (an item inside a zip or an email, or a
        // top-level file whose copy this run already ingested inside a zip); it has its audit row.
        const meta = typeof existingSource.metadata === "string" ? JSON.parse(existingSource.metadata) : existingSource.metadata;
        ingestStageDecision(ctx, {
          decision: "skip-duplicate",
          rule: "exact-duplicate",
          reason: skipped.reason!,
          duplicate_of_path: String((meta as { source_path?: string } | null)?.source_path ?? `source ${existingSource.id}`),
          duplicate_of_source_id: existingSource.id,
          supersedes: parentSourceId ? null : ctx.triageDecisionId ?? null,
        });
      } else {
        await recordNotIngested(tx, ctx, skipped, "duplicate", existingSource.id);
      }
      return skipped;
    }

    // Ingested in workspace but not linked to this investigation -> link via SourceInstance.
    // An include of a skipped duplicate (D103) links the same way: the copy is recorded as another
    // acquisition of the source, not stored or indexed a second time.
    const acqId = randomUUID();
    await tx`
      INSERT INTO acquisition_records (
        id, tenant_id, source_id, origin, custodian, acquisition_method,
        obtained_at, declared_by, created_by
      )
      VALUES (
        ${acqId}, ${resolvedTenantId}, ${existingSource.id},
        ${isBucketSource ? "GCS Bucket Import" : "CLI Folder Import"},
        ${isBucketSource ? "GCS Ingestion Operator" : "Local Ingestion Operator"},
        'folder_import',
        NOW(), ${actorId}, ${actorId}
      );
    `;

    const instId = randomUUID();
    await tx`
      INSERT INTO source_instances (
        id, tenant_id, source_id, acquisition_record_id, investigation_id, created_by
      )
      VALUES (
        ${instId}, ${resolvedTenantId}, ${existingSource.id}, ${acqId}, ${investigationId}, ${actorId}
      );
    `;

    if (instanceRows.length > 0) {
      // Only an include gets here (see above): its own source.reinclude audit row records it.
      return {
        filename: fileName,
        filePath: sourcePath,
        byteSize,
        sha256,
        status: "skipped",
        reason: `linked as another copy of source ${existingSource.id} (same bytes; indexed once)`,
        sourceId: existingSource.id,
        linkedCopyOf: existingSource.id,
      };
    }
    const linked: IngestFileResult = {
      filename: fileName,
      filePath: sourcePath,
      byteSize,
      sha256,
      status: "skipped",
      reason: "deduplicated (linked to existing source)",
      sourceId: existingSource.id,
    };
    await recordNotIngested(tx, ctx, linked, "duplicate", existingSource.id);
    return linked;
  }
  return null;
}

/**
 * BIGDATA-4: step 1 of processSingleItem for a planned item, from the sequencer's decision: a
 * duplicate of a copy that comes before it in reading order (skipped, naming that copy's source), a
 * link to a source of another investigation, or new (null: store, parse and index it). The rows are
 * exactly the ones existingSourceOutcome writes for the same case.
 */
export async function plannedExistingOutcome(tx: Tx, ctx: IngestItemContext): Promise<IngestFileResult | null> {
  const { resolvedTenantId, investigationId, actorId, fileName, sourcePath, byteSize, sha256, isBucketSource, parentSourceId } = ctx;
  const d = ctx.plan?.decision;
  if (!d) throw new Error(`no decision for ${sourcePath}: the item was not sequenced`);
  if (d.decision === "ingest") return null;
  if (d.decision === "skip-duplicate") {
    const skipped: IngestFileResult = { filename: fileName, filePath: sourcePath, byteSize, sha256, status: "skipped", reason: "already ingested in investigation", ...(d.duplicateOfSourceId ? { sourceId: d.duplicateOfSourceId } : {}) };
    ingestStageDecision(ctx, {
      decision: "skip-duplicate",
      rule: "exact-duplicate",
      reason: skipped.reason!,
      duplicate_of_path: d.duplicateOfPath ?? `source ${d.duplicateOfSourceId}`,
      duplicate_of_source_id: d.duplicateOfSourceId,
      supersedes: parentSourceId ? null : ctx.triageDecisionId ?? null,
    });
    return skipped;
  }
  if (d.decision === "link" && d.sourceId) {
    const acqId = randomUUID();
    await tx`
      INSERT INTO acquisition_records (id, tenant_id, source_id, origin, custodian, acquisition_method, obtained_at, declared_by, created_by)
      VALUES (${acqId}, ${resolvedTenantId}, ${d.sourceId}, ${isBucketSource ? "GCS Bucket Import" : "CLI Folder Import"},
              ${isBucketSource ? "GCS Ingestion Operator" : "Local Ingestion Operator"}, 'folder_import', NOW(), ${actorId}, ${actorId})`;
    await tx`
      INSERT INTO source_instances (id, tenant_id, source_id, acquisition_record_id, investigation_id, created_by)
      VALUES (${randomUUID()}, ${resolvedTenantId}, ${d.sourceId}, ${acqId}, ${investigationId}, ${actorId})`;
    const linked: IngestFileResult = { filename: fileName, filePath: sourcePath, byteSize, sha256, status: "skipped", reason: "deduplicated (linked to existing source)", sourceId: d.sourceId };
    await recordNotIngested(tx, ctx, linked, "duplicate", d.sourceId);
    return linked;
  }
  throw new Error(`the decision for ${sourcePath} is ${d.decision}: it cannot be written`);
}

export type FileFormat = "text" | "pdf" | "docx" | "doc" | "spreadsheet" | "html" | "rtf" | "email" | "zip" | "other";

/** Which branch of parseAndIndex a file goes to (its extension; a PDF also by its first bytes). */
export function formatOf(fileName: string, fileBytes: Buffer): FileFormat {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".txt" || ext === ".md") return "text";
  if (ext === ".pdf" || (fileBytes.length >= 4 && fileBytes.subarray(0, 4).toString("utf-8") === "%PDF")) return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".doc") return "doc";
  if (ext === ".xlsx" || ext === ".xls" || ext === ".csv" || ext === ".tsv") return "spreadsheet";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".rtf") return "rtf";
  if (ext === ".eml" || ext === ".msg") return "email";
  if (ext === ".zip") return "zip";
  return "other";
}

/** A zip's entries: from the plan (read at discovery), or read now. A zip bomb throws the same error either way. */
async function zipEntriesOf(ctx: IngestItemContext): Promise<{ entries: NonNullable<PlanNode["zip"]>["entries"] }> {
  const plan = ctx.plan;
  if (plan) {
    if (plan.zipError !== undefined) throw plan.zipError;
    if (plan.zipFailed !== undefined) throw new Error(plan.zipFailed);
    if (plan.zip) {
      if (plan.children.length !== plan.zip.entries.length) throw new Error(`${ctx.sourcePath}: the plan has ${plan.children.length} entries, the zip ${plan.zip.entries.length}`);
      return plan.zip;
    }
  }
  return extractZipArchive(ctx.fileBytes, ctx.zipOptions);
}

/** An email's parse: from the plan (parsed at discovery), a mailbox message's own, or parsed now. */
async function emailOf(ctx: IngestItemContext, isEml: boolean): Promise<ParsedEmailResult> {
  const plan = ctx.plan;
  if (plan?.emailFailed !== undefined) throw new Error(plan.emailFailed);
  const parsed = plan?.email ?? ctx.preParsedEmail ?? (isEml ? await parseEml(ctx.fileBytes) : await parseMsg(ctx.fileBytes));
  if (plan && plan.children.length !== parsed.attachments.length) throw new Error(`${ctx.sourcePath}: the plan has ${plan.children.length} attachments, the email ${parsed.attachments.length}`);
  return parsed;
}

/** Steps 2-6 of processSingleItem: store, parse and index a file whose bytes are new. */
async function parseAndIndex(tx: Tx, ctx: IngestItemContext): Promise<IngestFileResult> {
  const {
    resolvedTenantId,
    workspaceId,
    investigationId,
    actorId,
    fileName,
    sourcePath,
    fileBytes,
    byteSize,
    sha256,
    isBucketSource,
    bucketSources,
    parentSourceId,
    parentArtifactId,
    sourceMetadata,
  } = ctx;

  // 2. Format Identification (formatOf: the same rule BIGDATA-4's discovery uses)
  const mimeType = getMimeType(fileName);
  const ext = extname(fileName).toLowerCase();
  const format = formatOf(fileName, fileBytes);

  const isText = format === "text";
  const isPdf = format === "pdf";
  const isDocx = format === "docx";
  const isDoc = format === "doc";
  const isSpreadsheet = format === "spreadsheet";
  const isHtml = format === "html";
  const isRtf = format === "rtf";
  const isEml = format === "email" && ext === ".eml";
  const isEmail = format === "email";
  const isZip = format === "zip";

  const isSupported = format !== "other";

  let sourceClass = "primary_record";
  if (isEmail) {
    sourceClass = "communication";
  }

  let storageUri: string;
  if (isBucketSource) {
    storageUri = sourcePath;
  } else {
    const storageKey = createSourceStorageKey(resolvedTenantId, investigationId, sha256);
    await getObjectStore().put(storageKey, fileBytes, {
      contentType: mimeType,
      metadata: { filename: fileName },
    });
    storageUri = `gcs://${bucketSources}/${storageKey}`;
  }

  const combinedMetadata = {
    source_path: sourcePath,
    ...(parentSourceId ? { parent_file_id: parentSourceId } : {}),
    ...(sourceMetadata || {}),
  };

  let finalStatus: IngestFileResult["status"];
  let parseFailureReason: string | undefined;
  const sourceId = ctx.plan?.decision?.sourceId ?? randomUUID();

  // 3. Insert sources record (initially 'processing')
  await tx`
    INSERT INTO sources (
      id, tenant_id, workspace_id, investigation_id, filename,
      mime_type, byte_size, sha256, storage_uri, status,
      source_class, metadata, is_encrypted, created_by
    )
    VALUES (
      ${sourceId}, ${resolvedTenantId}, ${workspaceId}, ${investigationId},
      ${fileName}, ${mimeType}, ${byteSize}, ${sha256}, ${storageUri},
      'processing', ${sourceClass}, ${jsonb(tx, combinedMetadata)},
      false, ${actorId}
    );
  `;

  // 4. Insert acquisition_records and source_instances
  const acqId = randomUUID();
  await tx`
    INSERT INTO acquisition_records (
      id, tenant_id, source_id, origin, custodian, acquisition_method,
      obtained_at, declared_by, created_by
    )
    VALUES (
      ${acqId}, ${resolvedTenantId}, ${sourceId},
      ${isBucketSource ? "GCS Bucket Import" : "CLI Folder Import"},
      ${isBucketSource ? "GCS Ingestion Operator" : "Local Ingestion Operator"},
      'folder_import',
      NOW(), ${actorId}, ${actorId}
    );
  `;

  const instId = randomUUID();
  await tx`
    INSERT INTO source_instances (
      id, tenant_id, source_id, acquisition_record_id, investigation_id, created_by
    )
    VALUES (
      ${instId}, ${resolvedTenantId}, ${sourceId}, ${acqId}, ${investigationId}, ${actorId}
    );
  `;

  const childResults: IngestFileResult[] = [];

  // 5. Parse Document & Index
  if (isText) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'native', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    const rawText = fileBytes.toString("utf-8");
    const contentDocId = randomUUID();
    await tx`
      INSERT INTO content_documents (
        id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
      )
      VALUES (
        ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'document', 1.0,
        ${fullTextToStore(rawText, [{ char_start: 0, char_end: rawText.length, text: rawText }])}, ${actorId}
      );
    `;

    const blockId = randomUUID();
    await tx`
      INSERT INTO content_blocks (
        id, tenant_id, content_document_id, sequence, block_type, section_path, page, char_start, char_end, text, language, created_by
      )
      VALUES (
        ${blockId}, ${resolvedTenantId}, ${contentDocId}, 1, 'paragraph', 'Document Body', null, 0, ${rawText.length}, ${rawText}, 'en', ${actorId}
      );
    `;

    const chunkId = randomUUID();
    const header = `Document '${fileName}', Section: Document Body`;
    await tx`
      INSERT INTO chunks (
        id, tenant_id, investigation_id, content_document_id, block_ids, char_start, char_end, text, contextual_header, token_count, doc_type, created_by
      )
      VALUES (
        ${chunkId}, ${resolvedTenantId}, ${investigationId}, ${contentDocId},
        ARRAY[${blockId}]::uuid[], 0, ${rawText.length}, null,
        ${header}, ${Math.max(1, Math.round(rawText.length / 4))}, 'document', ${actorId}
      );
    `;
    fingerprintDocument(ctx, sourceId, contentDocId, [{ block_type: "paragraph", text: rawText }]);
    finalStatus = "indexed";
  } else if (isPdf) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'pdf_structure', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    // A PDF the parser cannot read is 'unprocessable': not indexed, not stored_unparsed,
    // counted as failed. parsePdfStructure has no fallback (Fix 3, 2026-09-04).
    const pdfResult = await parsePdfStructure(fileBytes).catch((pdfErr: unknown) => {
      parseFailureReason = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      return null;
    });

    if (!pdfResult) {
      finalStatus = "unprocessable";
      await tx`
        UPDATE artifacts
        SET status = 'failed', updated_at = NOW()
        WHERE id = ${artifactId} AND tenant_id = ${resolvedTenantId};
      `;
    } else if ((pdfResult.fullText || "").trim().length > 20 && pdfResult.blocks.length > 0) {
      finalStatus = "indexed";
      const contentDocId = randomUUID();
      await tx`
        INSERT INTO content_documents (
          id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
        )
        VALUES (
          ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'pdf_document',
          ${pdfResult.layout_confidence ?? 1.0}, ${fullTextToStore(pdfResult.fullText, pdfResult.blocks)}, ${actorId}
        );
      `;

      await insertDocumentBlocksAndChunks(
        tx,
        ctx,
        sourceId,
        contentDocId,
        fileName,
        "pdf_document",
        pdfResult.blocks
      );
    } else {
      // Scanned PDF with 0 extractable characters -> needs_ocr
      finalStatus = "needs_ocr";
      const contentDocId = randomUUID();
      await tx`
        INSERT INTO content_documents (
          id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
        )
        VALUES (
          ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'scanned_pdf',
          0.0, '', ${actorId}
        );
      `;
      // 0 blocks and 0 chunks created for needs_ocr
    }
  } else if (isDocx) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'docx_parser', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    try {
      const docxResult = await parseDocx(fileBytes);
      if (docxResult.blocks.length > 0 && docxResult.fullText.trim().length > 0) {
        const contentDocId = randomUUID();
        await tx`
          INSERT INTO content_documents (
            id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
          )
          VALUES (
            ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'word_document',
            ${docxResult.layout_confidence}, ${fullTextToStore(docxResult.fullText, docxResult.blocks)}, ${actorId}
          );
        `;

        await insertDocumentBlocksAndChunks(
          tx,
          ctx,
          sourceId,
          contentDocId,
          fileName,
          "word_document",
          docxResult.blocks
        );
        finalStatus = "indexed";
      } else {
        finalStatus = "stored_unparsed";
      }
    } catch {
      finalStatus = "stored_unparsed";
    }
  } else if (isDoc) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'doc_parser', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    try {
      const docResult = await parseDoc(fileBytes);
      if (docResult.blocks.length > 0 && docResult.fullText.trim().length > 0) {
        const contentDocId = randomUUID();
        await tx`
          INSERT INTO content_documents (
            id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
          )
          VALUES (
            ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'word_legacy_document',
            ${docResult.layout_confidence}, ${fullTextToStore(docResult.fullText, docResult.blocks)}, ${actorId}
          );
        `;

        await insertDocumentBlocksAndChunks(
          tx,
          ctx,
          sourceId,
          contentDocId,
          fileName,
          "word_legacy_document",
          docResult.blocks
        );
        finalStatus = "indexed";
      } else {
        finalStatus = "stored_unparsed";
      }
    } catch {
      finalStatus = "stored_unparsed";
    }
  } else if (isSpreadsheet) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'spreadsheet_parser', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    try {
      const sheetResult = await parseSpreadsheet(fileBytes, ext);
      if (sheetResult.blocks.length > 0 && sheetResult.fullText.trim().length > 0) {
        const contentDocId = randomUUID();
        await tx`
          INSERT INTO content_documents (
            id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
          )
          VALUES (
            ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'spreadsheet',
            ${sheetResult.layout_confidence}, ${fullTextToStore(sheetResult.fullText, sheetResult.blocks)}, ${actorId}
          );
        `;

        await insertDocumentBlocksAndChunks(
          tx,
          ctx,
          sourceId,
          contentDocId,
          fileName,
          "spreadsheet",
          sheetResult.blocks
        );
        finalStatus = "indexed";
      } else {
        finalStatus = "stored_unparsed";
      }
    } catch {
      finalStatus = "stored_unparsed";
    }
  } else if (isHtml) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'html_parser', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    try {
      const htmlResult = await parseHtml(fileBytes);
      if (htmlResult.blocks.length > 0 && htmlResult.fullText.trim().length > 0) {
        const contentDocId = randomUUID();
        await tx`
          INSERT INTO content_documents (
            id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
          )
          VALUES (
            ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'html_document',
            ${htmlResult.layout_confidence}, ${fullTextToStore(htmlResult.fullText, htmlResult.blocks)}, ${actorId}
          );
        `;

        await insertDocumentBlocksAndChunks(
          tx,
          ctx,
          sourceId,
          contentDocId,
          fileName,
          "html_document",
          htmlResult.blocks
        );
        finalStatus = "indexed";
      } else {
        finalStatus = "stored_unparsed";
      }
    } catch {
      finalStatus = "stored_unparsed";
    }
  } else if (isRtf) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'rtf_parser', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    try {
      const rtfResult = await parseRtf(fileBytes);
      if (rtfResult.blocks.length > 0 && rtfResult.fullText.trim().length > 0) {
        const contentDocId = randomUUID();
        await tx`
          INSERT INTO content_documents (
            id, tenant_id, artifact_id, normalizer_version, language, doc_type, layout_confidence, full_text, created_by
          )
          VALUES (
            ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'rtf_document',
            ${rtfResult.layout_confidence}, ${fullTextToStore(rtfResult.fullText, rtfResult.blocks)}, ${actorId}
          );
        `;

        await insertDocumentBlocksAndChunks(
          tx,
          ctx,
          sourceId,
          contentDocId,
          fileName,
          "rtf_document",
          rtfResult.blocks
        );
        finalStatus = "indexed";
      } else {
        finalStatus = "stored_unparsed";
      }
    } catch {
      finalStatus = "stored_unparsed";
    }
  } else if (isEmail) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', ${isEml ? "eml_parser" : "msg_parser"}, '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    try {
      const emailResult = await emailOf(ctx, isEml);
      const contentDocId = randomUUID();
      await tx`
        INSERT INTO content_documents (
          id, tenant_id, artifact_id, normalizer_version, language, doc_type, doc_date, layout_confidence, full_text, created_by
        )
        VALUES (
          ${contentDocId}, ${resolvedTenantId}, ${artifactId}, '1.0.0', 'en', 'email_message',
          ${emailResult.headers.date ? new Date(emailResult.headers.date) : null},
          1.0, ${fullTextToStore(emailResult.fullText, emailResult.blocks)}, ${actorId}
        );
      `;

      await insertDocumentBlocksAndChunks(
        tx,
        ctx,
        sourceId,
        contentDocId,
        fileName,
        "email_message",
        emailResult.blocks
      );

      // Ingest email attachments as child sources
      for (const [i, att] of emailResult.attachments.entries()) {
        const attSha = computeSha256(att.content);
        const childRes = await processSingleItem(tx, {
          ...ctx,
          fileName: att.filename,
          sourcePath: `${sourcePath}#attachment:${att.filename}`,
          fileBytes: att.content,
          byteSize: att.byteSize,
          sha256: attSha,
          isBucketSource: false,
          parentSourceId: sourceId,
          parentArtifactId: artifactId,
          triageDecisionId: undefined,
          reinclude: false,
          entryModified: null,
          preParsedEmail: undefined,
          triagedByCaller: false,
          plan: ctx.plan ? ctx.plan.children[i] : undefined,
          sourceMetadata: {
            parent_email_id: sourceId,
            parent_email_subject: emailResult.headers.subject,
            is_email_attachment: true,
          },
        });
        childResults.push(childRes);
      }
      finalStatus = "indexed";
    } catch {
      finalStatus = "stored_unparsed";
    }
  } else if (isZip) {
    const artifactId = randomUUID();
    // No byte-identical copy (F3, D95): the primary artifact is the source file itself.
    const artifactStorageUri = storageUri;

    await tx`
      INSERT INTO artifacts (
        id, tenant_id, source_id, parent_artifact_id, kind, parser, parser_version, status, storage_uri, created_by
      )
      VALUES (
        ${artifactId}, ${resolvedTenantId}, ${sourceId}, ${parentArtifactId || null}, 'primary', 'zip_archive_parser', '1.0.0', 'ready', ${artifactStorageUri}, ${actorId}
      );
    `;

    try {
      const zipResult = await zipEntriesOf(ctx);

      for (const [i, entry] of zipResult.entries.entries()) {
        const entrySha = computeSha256(entry.content);
        const childRes = await processSingleItem(tx, {
          ...ctx,
          fileName: entry.filename,
          sourcePath: `${sourcePath}#${entry.path}`,
          fileBytes: entry.content,
          byteSize: entry.byteSize,
          sha256: entrySha,
          isBucketSource: false,
          parentSourceId: sourceId,
          parentArtifactId: artifactId,
          triageDecisionId: undefined,
          reinclude: false,
          entryModified: entry.modified ?? null,
          preParsedEmail: undefined,
          triagedByCaller: false,
          plan: ctx.plan ? ctx.plan.children[i] : undefined,
          sourceMetadata: {
            parent_archive_id: sourceId,
            parent_archive_path: sourcePath,
            archive_entry_path: entry.path,
            nesting_depth: entry.depth,
          },
        });
        childResults.push(childRes);
      }
      finalStatus = "indexed";
    } catch (zipErr) {
      if (zipErr instanceof ZipBombError) {
        throw zipErr;
      }
      finalStatus = "stored_unparsed";
    }
  } else {
    // Unparsed admitted format
    finalStatus = "stored_unparsed";
  }

  // Update source final status
  await tx`
    UPDATE sources
    SET status = ${finalStatus}, updated_at = NOW()
    WHERE id = ${sourceId} AND tenant_id = ${resolvedTenantId};
  `;

  // 6. Emit Audit Event
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
      filename: fileName,
      sha256,
      status: finalStatus,
      is_supported: isSupported,
      ...(parseFailureReason ? { parse_error: parseFailureReason } : {}),
    },
    outcome: finalStatus === "unprocessable" ? "failure" : "success",
    requestId: randomUUID(),
  });

  return {
    filename: fileName,
    filePath: sourcePath,
    byteSize,
    sha256,
    status: finalStatus,
    ...(parseFailureReason ? { reason: parseFailureReason } : {}),
    sourceId,
    childResults: childResults.length > 0 ? childResults : undefined,
  };
}

/** Adds one top-level result to the summary's counters. */
function countResult(summary: IngestBatchSummary, result: IngestFileResult): void {
  if (result.status === "indexed") {
    summary.admitted++;
    summary.parsed++;
  } else if (result.status === "needs_ocr") {
    summary.admitted++;
    summary.needsOcr++;
  } else if (result.status === "stored_unparsed") {
    summary.admitted++;
    summary.storedUnparsed++;
  } else if (result.status === "skipped") {
    summary.skipped++;
  } else if (result.status === "unprocessable") {
    // Parser failure: the source row exists with status 'unprocessable' but it is
    // a failed ingest, not an admission.
    summary.failed++;
  }
}

function emptySummary(): IngestBatchSummary {
  return {
    totalFiles: 0,
    admitted: 0,
    parsed: 0,
    needsOcr: 0,
    storedUnparsed: 0,
    skipped: 0,
    skippedSidecars: 0,
    failed: 0,
    results: [],
    runId: "",
    triage: { objects: 0, objectsHashed: 0, objectsReadForFilters: 0, counts: {}, ms: 0 },
    timings: { triageMs: 0, nearDuplicateMs: 0 },
    nearDuplicates: 0,
    mailboxes: [],
  };
}

/** The listed result of an object triage set aside: skipped, with the decision's reason. */
function triageSkipResult(item: TriageItem): IngestFileResult {
  return {
    filename: item.fileName,
    filePath: item.path,
    byteSize: item.byteSize,
    sha256: item.sha256 ?? "not read",
    status: "skipped",
    reason: item.reason ?? item.decision,
  };
}

/** Adds a mailbox's result to the summary's list of mailboxes. */
function noteMailbox(summary: IngestBatchSummary, result: IngestFileResult): void {
  if (result.mailbox) summary.mailboxes.push({ path: result.filePath, ...result.mailbox });
}

function requireTenant(explicit?: string): string {
  // Tenant is bound by the matter environment (MATTER_TENANT_ID). Library callers may
  // pass tenantId explicitly (tests provisioning their own tenant); the CLI never does.
  const tenantId = explicit || process.env.MATTER_TENANT_ID;
  if (!tenantId) {
    throw new Error("Tenant ID is required: set MATTER_TENANT_ID in the matter environment. No other source is accepted.");
  }
  return tenantId;
}

function storageDriver(): string | undefined {
  const rawDriver = process.env.STORAGE_DRIVER;
  return rawDriver ? rawDriver.split("#")[0]?.trim() : "memory";
}

/** Refuses to start a run while another run of the investigation is queued and not finished (one run at a time). */
async function assertNoUnfinishedRun(db: ReturnType<typeof postgres>, rec: RecordContext): Promise<void> {
  const open = await withTenant(rec.resolvedTenantId, (tx) => tx<{ id: string }[]>`
    SELECT id FROM ingest_runs WHERE tenant_id = ${rec.resolvedTenantId} AND investigation_id = ${rec.investigationId}
      AND kind = 'ingest' AND queued_at IS NOT NULL AND finished_at IS NULL
    ORDER BY started_at LIMIT 1`, db);
  if (open[0]) {
    throw new Error(`run ${open[0].id} of this investigation is not finished: take it up again with pnpm ingest:resume --run ${open[0].id} (a new run would decide the same objects a second time while it is open)`);
  }
}

/** The settings every worker of the run reads (ingest_runs.options), and the queue. */
async function queueRun(db: ReturnType<typeof postgres>, rec: RecordContext, runId: string, o: { maxParseBytes?: number | undefined; zipOptions?: ZipGuardOptions | undefined; mailboxParts?: MailboxPartOptions | undefined }): Promise<number> {
  const options: RunOptions = {
    max_parse_bytes: o.maxParseBytes ?? DEFAULT_MAX_PARSE_BYTES,
    ...(o.zipOptions ? { zip: o.zipOptions } : {}),
    pst_part_messages: o.mailboxParts?.pstMessages ?? DEFAULT_PST_PART_MESSAGES,
    mbox_part_bytes: o.mailboxParts?.mboxBytes ?? DEFAULT_MBOX_PART_BYTES,
  };
  await withTenant(rec.resolvedTenantId, (tx) => tx`UPDATE ingest_runs SET options = ${tx.json(JSON.parse(JSON.stringify(options)))} WHERE id = ${runId} AND tenant_id = ${rec.resolvedTenantId}`, db);
  return (await enqueueRun(db, rec, runId)).total;
}

export interface QueuedRun {
  runId: string;
  triage: TriageStats;
  /** Every object triage decided, in the run's order (the summary lists them all). */
  items: TriageItem[];
  /** Work items queued (one per object to ingest). */
  queued: number;
}

/**
 * BIGDATA-4, directory mode: triage (every file the walk finds gets a decision, recorded under a new
 * run before anything is parsed), then the run's queue: one item per file decided "ingest". Workers
 * (runWorker, `pnpm ingest:worker`) then read, decide and write the items.
 */
export async function enqueueDirectory(options: IngestOptions): Promise<QueuedRun> {
  const dbUrl = options.dbUrl || getDbUrl();
  const tenantId = requireTenant(options.tenantId);
  const driver = storageDriver();
  const bucketSources = process.env.GCS_BUCKET_SOURCES;
  if (driver === "gcs" && (!bucketSources || bucketSources.includes("CHANGEME"))) {
    throw new Error("Missing required environment variable: GCS_BUCKET_SOURCES");
  }
  const bucketArtifacts = process.env.GCS_BUCKET_ARTIFACTS;
  if (driver === "gcs" && (!bucketArtifacts || bucketArtifacts.includes("CHANGEME"))) {
    throw new Error("Missing required environment variable: GCS_BUCKET_ARTIFACTS");
  }
  const db = postgres(dbUrl, { max: 2 });
  try {
    const walked = collectFiles(options.dir);
    const maxParseBytes = options.maxParseBytes ?? DEFAULT_MAX_PARSE_BYTES;
    const rec = await resolveRecordContext(db, tenantId, options.investigationId, options.userId);
    await assertNoUnfinishedRun(db, rec);
    const tri = await triageDirectory(db, rec, options.dir, walked, { filters: options.filters ?? {}, includeSidecars: options.includeSidecars, maxReadBytes: maxParseBytes });
    const queued = await queueRun(db, rec, tri.runId, { maxParseBytes, zipOptions: options.zipOptions, mailboxParts: options.mailboxParts });
    return { runId: tri.runId, triage: tri.triage, items: tri.items, queued };
  } finally {
    await db.end();
  }
}

/** BIGDATA-4, bucket mode: triage from the listing, then the queue, as enqueueDirectory. */
export async function enqueueBucket(options: IngestBucketOptions): Promise<QueuedRun> {
  const dbUrl = options.dbUrl || getDbUrl();
  const tenantId = requireTenant(options.tenantId);
  const driver = storageDriver();
  const bucketArtifacts = process.env.GCS_BUCKET_ARTIFACTS;
  if (driver === "gcs" && (!bucketArtifacts || bucketArtifacts.includes("CHANGEME"))) {
    throw new Error("Missing required environment variable: GCS_BUCKET_ARTIFACTS");
  }
  // Fix 5: refuse any bucket that is not bound to this matter before touching it.
  assertBucketBoundToMatter(options.bucket);
  const db = postgres(dbUrl, { max: 2 });
  try {
    const maxParseBytes = options.maxParseBytes ?? DEFAULT_MAX_PARSE_BYTES;
    const rec = await resolveRecordContext(db, tenantId, options.investigationId, options.userId);
    await assertNoUnfinishedRun(db, rec);
    const tri = await triageBucketObjects(db, rec, options.bucket, options.prefix, { filters: options.filters ?? {}, includeSidecars: options.includeSidecars, maxReadBytes: maxParseBytes });
    const queued = await queueRun(db, rec, tri.runId, { maxParseBytes, zipOptions: options.zipOptions, mailboxParts: options.mailboxParts });
    return { runId: tri.runId, triage: tri.triage, items: tri.items, queued };
  } finally {
    await db.end();
  }
}

/**
 * Works a queued run with `workers` worker loops in this process (default 1: the ingest as it has
 * always run, one item after another; more are concurrent on the database, e.g. in tests), and
 * returns the summary of every object, in the run's order.
 */
export async function runQueuedInProcess(q: QueuedRun, options: { tenantId?: string | undefined; dbUrl?: string | undefined; workers?: number | undefined; workerHooks?: WorkerHooks | undefined; leaseSeconds?: number | undefined; onFileResult?: ((r: IngestFileResult) => void) | undefined; onMailboxProgress?: ((path: string, n: number) => void) | undefined }): Promise<IngestBatchSummary> {
  const tenantId = requireTenant(options.tenantId);
  const results = new Map<number, IngestFileResult>();
  const n = Math.max(1, options.workers ?? 1);
  const reports = await Promise.all(Array.from({ length: n }, (_, i) => runWorker({
    runId: q.runId, tenantId, dbUrl: options.dbUrl, name: n === 1 ? "in-process" : `in-process-${i + 1}`, hooks: options.workerHooks,
    leaseSeconds: options.leaseSeconds, results, onMailboxProgress: options.onMailboxProgress,
  })));
  const summary = emptySummary();
  summary.runId = q.runId;
  summary.triage = q.triage;
  summary.totalFiles = q.items.length;
  let seq = 0;
  for (const item of q.items) {
    let result: IngestFileResult;
    if (item.decision !== "ingest") {
      summary.skipped++;
      if (item.rule === "pipeline-sidecar") summary.skippedSidecars++;
      result = triageSkipResult(item);
    } else {
      result = results.get(seq) ?? { filename: item.fileName, filePath: item.path, byteSize: item.byteSize, sha256: item.sha256 ?? "unknown", status: "failed", reason: "not finished: the run's workers stopped before this object was written" };
      seq++;
      if (result.status === "failed") summary.failed++;
      noteMailbox(summary, result);
      countResult(summary, result);
    }
    summary.results.push(result);
    options.onFileResult?.(result);
  }
  const db = postgres(options.dbUrl || getDbUrl(), { max: 1 });
  try {
    const counts = await withTenant(tenantId, (tx) => tx<{ near: number }[]>`
      SELECT count(*)::int AS near FROM document_fingerprints WHERE tenant_id = ${tenantId} AND run_id = ${q.runId} AND near_duplicate_of IS NOT NULL`, db);
    summary.nearDuplicates = counts[0]?.near ?? 0;
  } finally {
    await db.end();
  }
  summary.timings = { triageMs: q.triage.ms, nearDuplicateMs: reports.reduce((s, r) => s + r.nearDuplicateMs, 0) };
  return summary;
}

/**
 * Directory mode: triage, the queue, and the workers (options.workers, default 1, in this process).
 * The same rows as the one-process ingest: the copy first in reading order is kept, whatever the
 * number of workers (plan section 16).
 */
export async function ingestDirectory(options: IngestOptions): Promise<IngestBatchSummary> {
  const q = await enqueueDirectory(options);
  return runQueuedInProcess(q, options);
}

/**
 * Bucket mode: triage from the listing (size, CRC32C, generation, no download unless two objects
 * could be the same), the queue, and the workers. The objects stay where they are: their source rows
 * point at them.
 */
export async function ingestBucket(options: IngestBucketOptions): Promise<IngestBatchSummary> {
  const q = await enqueueBucket(options);
  return runQueuedInProcess(q, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI execution
// ─────────────────────────────────────────────────────────────────────────────
function printTriage(t: TriageStats): void {
  console.log(`  Triage (before parsing): ${t.objects} objects, ${t.objectsHashed} hashed to compare, ${t.objectsReadForFilters} emails read for a filter, ${(t.ms / 1000).toFixed(1)} s`);
  for (const [k, v] of Object.entries(t.counts).sort()) if (k.includes(":")) console.log(`    ${String(v).padStart(6)}  ${k.replace(":", "  rule ")}`);
  console.log(`    ${String(t.counts.ingest ?? 0).padStart(6)}  ingest`);
}

/** BIGDATA-3B: one block per mailbox file: messages read, admitted, set aside by rule, unreadable, where reading stopped. */
function printMailboxes(summary: IngestBatchSummary): void {
  if (summary.mailboxes.length === 0) return;
  console.log(`  Mailboxes (${summary.mailboxes.length}), read message by message:`);
  for (const m of summary.mailboxes) {
    console.log(`    ${m.path}  [${m.format}, ${m.status}${m.reason ? `: ${m.reason}` : ""}]`);
    if (m.status === "stored_unparsed") continue;
    const skipped = Object.entries(m.messages_skipped).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
    console.log(`      ${m.messages_read} messages read: ${m.messages_admitted} admitted, skipped ${skipped}; ${m.failed} unreadable; attachments ${m.attachments.admitted} admitted, ${m.attachments.skipped} skipped, ${m.attachments.failed} failed; ${m.near_duplicates} near-duplicates; ${m.seconds.toFixed(1)} s`);
    if (m.stopped_at) console.log(`      stopped: ${m.stopped_at}`);
  }
}

async function runCli() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const bucket = (args["bucket"] || args["b"] || "") as string;
  const prefix = (args["prefix"] || args["p"] || "") as string;
  const dir = (args["dir"] || args["d"] || "") as string;
  const investigationId = (args["investigation"] || args["i"] || process.env.CASEFILE_INVESTIGATION_ID || process.env.MATTER_INVESTIGATION_ID || "") as string;
  const includeSidecars = Boolean(args["include-sidecars"] || args["includeSidecars"]);
  const triageOnlyRun = Boolean(args["triage-only"]);
  // BIGDATA-4: --workers N starts N worker processes on this machine; --enqueue-only triages and
  // builds the queue for workers started elsewhere (Cloud Run job tasks, pnpm ingest:worker).
  const workers = Math.max(1, Number(args["workers"] ?? process.env.INGEST_WORKERS ?? 1) || 1);
  const enqueueOnly = Boolean(args["enqueue-only"]);

  // The tenant is bound by MATTER_TENANT_ID and cannot be chosen on the command line.
  if (args["tenant"] !== undefined || args["t"] !== undefined) {
    console.error("Error: --tenant is not accepted. The tenant is bound by MATTER_TENANT_ID in the matter environment.");
    process.exit(1);
  }
  const tenantId = process.env.MATTER_TENANT_ID || "";

  let filters: TriageFilters;
  try {
    filters = parseFilterArgs(argv);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}. Nothing was recorded.`);
    process.exit(1);
  }

  if ((!dir && !bucket) || !investigationId || !tenantId) {
    console.error("Error: Either --bucket <name> or --dir <folder> is required along with --investigation <id>, and MATTER_TENANT_ID must be set.");
    console.error("Usage:");
    console.error("  pnpm ingest --bucket <bucket-name> [--prefix <prefix>] --investigation <id> [--include-sidecars] [filters] [--triage-only | --enqueue-only] [--workers N]");
    console.error("  pnpm ingest --dir <folder> --investigation <id> [--include-sidecars] [filters] [--triage-only | --enqueue-only] [--workers N]");
    console.error("  --workers N      N worker processes on this machine share the run's queue (default 1)");
    console.error("  --enqueue-only   triage and queue the run; workers are started elsewhere (pnpm ingest:worker --run <id>, Cloud Run job tasks)");
    console.error("  filters (chosen by the case owner for this run; default none):");
    console.error("    --email-date-from YYYY-MM-DD  --email-date-to YYYY-MM-DD   emails, by their Date header");
    console.error("    --file-date-from YYYY-MM-DD   --file-date-to YYYY-MM-DD    other files, by their file date");
    console.error("    --person <text> (repeatable)          keep only emails with it in From, To, Cc or Bcc");
    console.error("    --exclude-person <text> (repeatable)  skip emails with it in From, To, Cc or Bcc");
    console.error(`  --bucket must be one of this matter's buckets: ${allowedIngestBuckets().join(", ")}`);
    process.exit(1);
  }

  console.log("================================================================================");
  if (bucket) {
    console.log(`Ingesting documents from GCS Bucket: gs://${bucket}${prefix ? `/${prefix}` : ""}`);
  } else {
    console.log(`Ingesting documents from local directory: ${resolve(process.cwd(), dir)}`);
  }
  console.log(`Investigation ID:                    ${investigationId}`);
  if (includeSidecars) {
    console.log(`Pipeline Sidecars:                   INCLUDED (--include-sidecars)`);
  } else {
    console.log(`Pipeline Sidecars:                   EXCLUDED (results/ sidecars skipped)`);
  }
  const recorded = filtersToRecord(filters);
  console.log(`Filters (case owner, this run):      ${Object.keys(recorded).length ? JSON.stringify(recorded) : "none"}`);
  if (triageOnlyRun) console.log(`Mode:                                TRIAGE ONLY (decisions recorded, nothing ingested)`);
  else if (enqueueOnly) console.log(`Mode:                                ENQUEUE ONLY (triage and the queue; workers are started elsewhere)`);
  else console.log(`Workers:                             ${workers}${workers > 1 ? " (processes on this machine, sharing the run's queue)" : ""}`);
  console.log("────────────────────────────────────────────────────────────────────────────────");

  if (triageOnlyRun) {
    try {
      const t = await triageOnly({
        ...(bucket ? { bucket, ...(prefix ? { prefix } : {}) } : { dir: resolve(process.cwd(), dir) }),
        investigationId,
        tenantId,
        filters,
        includeSidecars,
      });
      console.log(`Run: ${t.runId}`);
      printTriage(t.triage);
      console.log(`Report: pnpm ingest:report --run ${t.runId}`);
      return;
    } catch (err: unknown) {
      console.error("Triage failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  const onMailboxProgress = (path: string, n: number) => {
    if (n % 1000 === 0) console.log(`  ... ${basename(path)}: ${n.toLocaleString("en-US")} messages read`);
  };
  const onFileResult = (res: IngestFileResult) => {
    const padName = res.filename.padEnd(32);
    const padBytes = `${res.byteSize.toLocaleString()} B`.padStart(12);
    const shortSha = res.sha256.slice(0, 12);

    if (res.status === "indexed") {
      console.log(`${padName} ${padBytes}  sha256:${shortSha}  status: indexed (parsed)`);
    } else if (res.status === "needs_ocr") {
      console.log(`${padName} ${padBytes}  sha256:${shortSha}  status: needs_ocr (scanned, no text layer)`);
    } else if (res.status === "stored_unparsed") {
      console.log(`${padName} ${padBytes}  sha256:${shortSha}  status: stored_unparsed (${res.reason || "unsupported format"})`);
    } else if (res.status === "skipped") {
      console.log(`${padName} ${padBytes}  sha256:${shortSha}  status: skipped (${res.reason || "already ingested"})`);
    } else if (res.status === "unprocessable") {
      console.log(`${padName} ${padBytes}  sha256:${shortSha}  status: UNPROCESSABLE - ${res.reason || "parser failed"}`);
    } else {
      console.log(`${padName} ${padBytes}  sha256:${shortSha}  status: FAILED - ${res.reason || "unknown error"}`);
    }
  };

  if (enqueueOnly || workers > 1) {
    try {
      const q = bucket
        ? await enqueueBucket({ bucket, prefix: prefix || undefined, investigationId, tenantId, includeSidecars, filters })
        : await enqueueDirectory({ dir: resolve(process.cwd(), dir), investigationId, tenantId, includeSidecars, filters });
      console.log(`Run: ${q.runId}   (${q.queued} items queued)`);
      printTriage(q.triage);
      if (enqueueOnly) {
        console.log(`Start workers: pnpm ingest:worker --run ${q.runId}   (or: pnpm ingest:resume --run ${q.runId} --workers N)`);
        console.log(`Watch it:      pnpm ingest:status --run ${q.runId}`);
        return;
      }
      const code = await startWorkerProcesses(q.runId, workers);
      console.log(formatRunStatus(await getRunStatus({ runId: q.runId, tenantId })));
      console.log(`  Report (every decision, CSV of every skipped object): pnpm ingest:report --run ${q.runId}`);
      if (code !== 0) process.exit(1);
    } catch (err: unknown) {
      console.error("Ingestion failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  try {
    let summary: IngestBatchSummary;
    if (bucket) {
      summary = await ingestBucket({
        bucket,
        prefix: prefix || undefined,
        investigationId,
        tenantId,
        includeSidecars,
        filters,
        onFileResult,
        onMailboxProgress,
      });
    } else {
      const targetDir = resolve(process.cwd(), dir);
      summary = await ingestDirectory({
        dir: targetDir,
        investigationId,
        tenantId,
        includeSidecars,
        filters,
        onFileResult,
        onMailboxProgress,
      });
    }

    console.log("────────────────────────────────────────────────────────────────────────────────");
    console.log("Ingestion Summary:");
    console.log(`  Run:                ${summary.runId}`);
    console.log(`  Total files found:  ${summary.totalFiles}`);
    console.log(`  Admitted:           ${summary.admitted}`);
    console.log(`  Parsed (indexed):   ${summary.parsed}`);
    console.log(`  Needs OCR:          ${summary.needsOcr}`);
    console.log(`  Stored-unparsed:    ${summary.storedUnparsed}`);
    console.log(`  Skipped/Existing:   ${summary.skipped} (${summary.skippedSidecars} sidecars excluded)`);
    console.log(`  Failed:             ${summary.failed}`);
    console.log(`  Near-duplicates:    ${summary.nearDuplicates} documents grouped under a first document (all indexed)`);
    printTriage(summary.triage);
    printMailboxes(summary);
    // F1 (D90): what was not ingested, by reason. Each skip is also an ingest_decisions row with a
    // source.skip audit row; each failure a source.ingest_failed audit row.
    const notIngested: Record<string, number> = {};
    const tally = (r: IngestFileResult) => {
      if (r.status === "skipped" || r.status === "failed") notIngested[`${r.status}: ${r.reason}`] = (notIngested[`${r.status}: ${r.reason}`] ?? 0) + 1;
      r.childResults?.forEach(tally);
    };
    summary.results.forEach(tally);
    if (Object.keys(notIngested).length > 0) {
      console.log("  Not ingested, by reason (incl. zip entries and attachments; each is in the audit log):");
      for (const [k, v] of Object.entries(notIngested).sort()) console.log(`    ${String(v).padStart(6)}  ${k}`);
    }
    console.log(`  Report (every decision, CSV of every skipped object): pnpm ingest:report --run ${summary.runId}`);
    console.log("────────────────────────────────────────────────────────────────────────────────");

    if (summary.failed > 0) {
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error("Ingestion failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/**
 * BIGDATA-4: starts `count` worker processes for a run (tools/ingest-cli/src/worker.ts), each its own
 * Node process with its own database connections, and prints the run's progress every 10 s until they
 * have all stopped. Resolves with 0 when every worker ended normally.
 */
export async function startWorkerProcesses(runId: string, count: number): Promise<number> {
  const worker = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
  const tenantId = process.env.MATTER_TENANT_ID || "";
  const children = Array.from({ length: count }, (_, i) =>
    spawn(process.execPath, ["--import", "tsx", worker, "--run", runId, "--name", `worker-${i + 1}`], { stdio: "inherit", env: process.env }));
  const timer = setInterval(() => {
    void getRunStatus({ runId, tenantId }).then((s) => console.log(`  [${new Date().toISOString()}] ${s.top.done} of ${s.top.total} done, ${s.failed.length} failed, ${s.workers.filter((w) => w.alive).length} workers alive`)).catch(() => undefined);
  }, 10_000);
  const codes = await Promise.all(children.map((c) => new Promise<number>((r) => c.once("exit", (code) => r(code ?? 1)))));
  clearInterval(timer);
  return codes.every((c) => c === 0) ? 0 : 1;
}

// Only when run as the command itself (`pnpm ingest`): report.ts and include.ts import this module.
if (/^ingest\.(ts|js)$/.test(basename(process.argv[1] ?? ""))) {
  runCli();
}
