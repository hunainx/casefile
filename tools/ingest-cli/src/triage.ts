import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, getDbUrl, type Tx } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import { writeAuditRow } from "./audit-buffer.js";
import { listBucketObjects, sha256OfFile, sha256OfBucketObject, downloadBucketObject } from "@casefile/storage";
import { parseEml, parseMsg } from "../../../apps/api/src/services/document-parsers.js";
import { matterConfig } from "../../../matter.config.js";
import { insertBatches } from "./batch-insert.js";
import {
  RULE_VERSIONS,
  junkRule,
  emailFilterDecision,
  fileDateDecision,
  filtersToRecord,
  hasEmailFilters,
  isEmailName,
  type DecisionKind,
  type EmailHeaders,
  type TriageFilters,
  type FilterRecord,
} from "./triage-rules.js";
import { NEAR_DUPLICATE_METHOD, LSH_BANDS, LSH_ROWS, NEAR_DUPLICATE_THRESHOLD } from "./near-duplicates.js";
import { mailboxFormatByName, mailboxFormatOfFile } from "./mailbox.js";

/**
 * BIGDATA-3 triage (docs/PLAN-BIG-DATA.md section 2 and section 14; D98-D102).
 *
 * Before anything is parsed, every object a run sees gets one decision: ingest, skip-junk,
 * skip-duplicate or skip-filter, written to ingest_decisions (one row per object) under one
 * ingest_runs row, and every skip also gets a source.skip audit row naming its decision. Triage
 * RECORDS decisions only: it lists and reads objects, and never deletes, moves, copies or
 * overwrites anything, in a bucket or on disk (guardrails/bucket-deletion.spec.ts; the
 * triage-bucket-readonly test checks it at run time). It is deterministic code the operator runs,
 * never an AI tool (PRD §60 Class E is unchanged).
 *
 * The rules, in the order they apply to one object:
 *   1. not a regular file (a link, a device), or a pipeline sidecar  -> skip-filter (fixed filters, from 2A)
 *   2. junk: a listed name, or 0 bytes                               -> skip-junk (answer 3)
 *   3. the owner's filters for this run: email Date/From/To/Cc, file date -> skip-filter (answer 5)
 *   4. exact duplicates among what is left, and of what the matter already holds -> skip-duplicate
 * Near-duplicates need the text, so they are found during the ingest (ingest.ts, near-duplicates.ts).
 */

/** One entry the walk found: a regular file to ingest, or something it will not read, and why. */
export interface WalkEntry {
  path: string;
  skipReason?: string;
}

/**
 * Every entry under `dirPath`, in path order. Nothing is left out (F1, D90): dotfiles, hidden
 * folders and node_modules folders are walked like any other; a symbolic link or junction is not
 * followed, and it, anything that is not a regular file, and a folder that cannot be read are
 * returned with the reason, so they are listed and recorded instead of disappearing.
 */
export function collectFiles(dirPath: string): WalkEntry[] {
  const out: WalkEntry[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err: unknown) {
      out.push({ path: dir, skipReason: `folder could not be read: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) out.push({ path: fullPath, skipReason: "symbolic link or junction: not followed" });
      else if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) out.push({ path: fullPath });
      else out.push({ path: fullPath, skipReason: "not a regular file (device, socket or pipe)" });
    }
  };
  walk(dirPath);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Checks whether a given path is an extraction manifest or sidecar from a prior pipeline run.
 * Skips *.json under results/ or path matching results/(native|ocr|msg|email_attachments)/.
 */
export function isPipelineSidecar(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (
    normalized.includes("results/native/") ||
    normalized.includes("results/ocr/") ||
    normalized.includes("results/msg/") ||
    normalized.includes("results/email_attachments/")
  ) {
    return true;
  }
  if (normalized.startsWith("results/") && normalized.endsWith(".json")) {
    return true;
  }
  return false;
}

/**
 * The only buckets bucket-mode ingest may read from: this matter's own buckets plus any
 * bucket deliberately listed in matterConfig.ingestBuckets. Nothing else, ever.
 */
export function allowedIngestBuckets(): string[] {
  return [matterConfig.buckets.sources, matterConfig.buckets.artifacts, matterConfig.buckets.exports, ...matterConfig.ingestBuckets];
}

export function assertBucketBoundToMatter(bucket: string): void {
  const allowed = allowedIngestBuckets();
  if (!allowed.includes(bucket)) {
    throw new Error(
      `Bucket binding violation: --bucket '${bucket}' is not a bucket of matter '${matterConfig.matterSlug}'. ` +
        `Allowed buckets: ${allowed.join(", ")}. ` +
        `If this matter is meant to ingest from '${bucket}', add it to matterConfig.ingestBuckets in matter.config.ts deliberately.`,
    );
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

/** Who and where: the matter's tenant, workspace, investigation, and the operator's user. */
export interface RecordContext {
  resolvedTenantId: string;
  workspaceId: string;
  investigationId: string;
  actorId: string;
}

export interface DecisionRow {
  id: string;
  tenant_id: string;
  investigation_id: string;
  run_id: string;
  stage: "triage" | "ingest" | "include";
  path: string;
  byte_size: number;
  sha256: string | null;
  crc32c: string | null;
  generation: string | null;
  decision: DecisionKind;
  rule: string | null;
  rule_version: number | null;
  reason: string | null;
  duplicate_of_path: string | null;
  duplicate_of_decision_id: string | null;
  duplicate_of_source_id: string | null;
  filter: FilterRecord | null;
  supersedes: string | null;
  created_by: string | null;
}

const DECISION_COLUMNS = [
  "id", "tenant_id", "investigation_id", "run_id", "stage", "path", "byte_size", "sha256", "crc32c", "generation",
  "decision", "rule", "rule_version", "reason", "duplicate_of_path", "duplicate_of_decision_id", "duplicate_of_source_id",
  "filter", "supersedes", "created_by",
] as const satisfies readonly (keyof DecisionRow)[];

/**
 * Writes decisions (multi-row INSERTs, D89) and one source.skip audit row per skip, naming the
 * decision, in the caller's transaction. The audit row carries the path, the reason and the rule,
 * as 2A's source.skip rows did (D90), so the audit log still lists every skipped object.
 */
export async function recordDecisions(tx: Tx, ctx: RecordContext, rows: readonly DecisionRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (const batch of insertBatches(rows, (r) => Buffer.byteLength(r.path) * 2 + Buffer.byteLength(r.reason ?? "") + 512)) {
    await tx`INSERT INTO ingest_decisions ${tx(batch as DecisionRow[], ...DECISION_COLUMNS)}`;
  }
  for (const r of rows) {
    if (r.decision === "ingest") continue;
    await writeAuditRow(tx, {
      tenantId: ctx.resolvedTenantId,
      workspaceId: ctx.workspaceId,
      investigationId: ctx.investigationId,
      actorType: "user",
      actorId: ctx.actorId,
      actorDisplay: "Ingest CLI",
      action: "source.skip",
      objectType: "ingest_decision",
      objectId: r.id,
      objectDisplay: basename(r.path.split("#").pop() ?? r.path),
      after: {
        path: r.path,
        reason: r.reason,
        decision: r.decision,
        rule: r.rule,
        rule_version: r.rule_version,
        decision_id: r.id,
        run_id: r.run_id,
        stage: r.stage,
        byte_size: r.byte_size,
        ...(r.sha256 ? { sha256: r.sha256 } : {}),
        ...(r.duplicate_of_path ? { duplicate_of_path: r.duplicate_of_path } : {}),
        ...(r.duplicate_of_source_id ? { duplicate_of_source_id: r.duplicate_of_source_id } : {}),
        ...(r.filter ? { filter: r.filter } : {}),
      },
      outcome: "success",
      requestId: randomUUID(),
    });
  }
}

/** The versions recorded on the run: every rule's, and the near-duplicate method's parameters. */
export function runRuleVersions(): Record<string, number | string> {
  return { ...RULE_VERSIONS, "near-duplicate-method": `${NEAR_DUPLICATE_METHOD}, LSH ${LSH_BANDS} bands x ${LSH_ROWS}, threshold ${NEAR_DUPLICATE_THRESHOLD}` };
}

export async function startRun(
  db: postgres.Sql,
  ctx: RecordContext,
  run: { kind: "ingest" | "include"; sourceKind: "folder" | "bucket"; source: string; filters: TriageFilters; includeOfRun?: string },
): Promise<string> {
  const id = randomUUID();
  await withTenant(ctx.resolvedTenantId, async (tx) => {
    await tx`
      INSERT INTO ingest_runs (id, tenant_id, investigation_id, kind, source_kind, source, filters, rule_versions, include_of_run, started_by)
      VALUES (${id}, ${ctx.resolvedTenantId}, ${ctx.investigationId}, ${run.kind}, ${run.sourceKind}, ${run.source},
              ${tx.json(filtersToRecord(run.filters))}, ${tx.json(runRuleVersions())}, ${run.includeOfRun ?? null}, ${ctx.actorId})`;
  }, db);
  return id;
}

export async function finishRun(db: postgres.Sql, ctx: RecordContext, runId: string, counters: Record<string, unknown>): Promise<void> {
  await withTenant(ctx.resolvedTenantId, async (tx) => {
    await tx`UPDATE ingest_runs SET finished_at = NOW(), counters = counters || ${tx.json(counters as postgres.JSONValue)} WHERE id = ${runId} AND tenant_id = ${ctx.resolvedTenantId}`;
  }, db);
}

// ── Triage ───────────────────────────────────────────────────────────────────

/** One object, as triage decided it. `id` is its decision's id. */
export interface TriageItem {
  id: string;
  path: string;
  fileName: string;
  byteSize: number;
  /** Bucket mode: the object's name in the bucket. */
  objectKey?: string;
  crc32c: string | null;
  generation: string | null;
  sha256: string | null;
  fileDate: Date | null;
  decision: DecisionKind;
  rule: string | null;
  ruleVersion: number | null;
  reason: string | null;
  duplicateOfPath: string | null;
  duplicateOfDecisionId: string | null;
  duplicateOfSourceId: string | null;
  filter: FilterRecord | null;
}

export interface TriageStats {
  objects: number;
  /** Objects whose SHA-256 triage computed (in bucket mode: downloaded to hash them). */
  objectsHashed: number;
  /** Emails read to judge an email filter. */
  objectsReadForFilters: number;
  counts: Record<string, number>;
  ms: number;
}

export interface TriageResult {
  runId: string;
  items: TriageItem[];
  triage: TriageStats;
}

interface ExistingSource {
  id: string;
  sha256: string;
  path: string;
}

/** What the matter's investigation already holds, for the exact-duplicate rule (scope: the matter). */
interface MatterIndex {
  bySize: Map<number, ExistingSource[]>;
  /** Bucket mode: path -> generation and SHA-256 recorded by an earlier run's decision or source. */
  byObject: Map<string, { generation: string; sha256: string }>;
}

const parseMeta = (m: unknown): Record<string, unknown> => {
  const v = typeof m === "string" ? JSON.parse(m) : m; // rows written before FIXES-1 hold the JSON as text (DEV-031)
  return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
};

/**
 * The sources already in this investigation (by size), and, for bucket mode, the generation and
 * SHA-256 of every object an earlier run of it decided. A copy of a file that is only in ANOTHER
 * investigation of the matter is not a duplicate here: the ingest links it, as before.
 */
async function loadMatterIndex(db: postgres.Sql, ctx: RecordContext, bucketMode: boolean): Promise<MatterIndex> {
  const idx: MatterIndex = { bySize: new Map(), byObject: new Map() };
  const shaByUri = new Map<string, string>();
  await withTenant(ctx.resolvedTenantId, async (tx) => {
    await tx<{ id: string; byte_size: string; sha256: string; storage_uri: string; metadata: unknown }[]>`
      SELECT s.id, s.byte_size, s.sha256, s.storage_uri, s.metadata FROM sources s
      WHERE s.tenant_id = ${ctx.resolvedTenantId} AND s.deleted_at IS NULL AND s.status NOT IN ('purged', 'quarantined')
        AND EXISTS (SELECT 1 FROM source_instances si WHERE si.source_id = s.id AND si.investigation_id = ${ctx.investigationId} AND si.tenant_id = ${ctx.resolvedTenantId})
      ORDER BY s.created_at, s.id`.cursor(2000, (rows) => {
      for (const r of rows) {
        const size = Number(r.byte_size);
        const path = String(parseMeta(r.metadata).source_path ?? r.storage_uri);
        const list = idx.bySize.get(size);
        const e = { id: r.id, sha256: r.sha256, path };
        if (list) list.push(e);
        else idx.bySize.set(size, [e]);
        shaByUri.set(r.storage_uri, r.sha256);
      }
    });
    if (bucketMode) {
      await tx<{ path: string; generation: string; sha256: string | null }[]>`
        SELECT DISTINCT ON (path) path, generation, sha256 FROM ingest_decisions
        WHERE tenant_id = ${ctx.resolvedTenantId} AND investigation_id = ${ctx.investigationId} AND generation IS NOT NULL
        ORDER BY path, seq DESC`.cursor(2000, (rows) => {
        for (const r of rows) {
          const sha = r.sha256 ?? shaByUri.get(r.path);
          if (sha) idx.byObject.set(r.path, { generation: r.generation, sha256: sha });
        }
      });
    }
  }, db);
  return idx;
}

function newItem(path: string, fileName: string, byteSize: number, extra: Partial<TriageItem> = {}): TriageItem {
  return {
    id: randomUUID(), path, fileName, byteSize, crc32c: null, generation: null, sha256: null, fileDate: null,
    decision: "ingest", rule: null, ruleVersion: null, reason: null, duplicateOfPath: null, duplicateOfDecisionId: null,
    duplicateOfSourceId: null, filter: null, ...extra,
  };
}

function skip(item: TriageItem, decision: DecisionKind, rule: keyof typeof RULE_VERSIONS, reason: string, filter: FilterRecord | null = null): void {
  Object.assign(item, { decision, rule, ruleVersion: RULE_VERSIONS[rule], reason, filter });
}

/** The From, To, Cc and Date of an email, reading only its header section for .eml. */
export async function readEmailHeaders(fileName: string, bytes: Buffer): Promise<EmailHeaders> {
  if (fileName.toLowerCase().endsWith(".msg")) return (await parseMsg(bytes)).headers;
  let end = bytes.indexOf("\r\n\r\n");
  if (end < 0) end = bytes.indexOf("\n\n");
  const head = end < 0 ? bytes : Buffer.concat([bytes.subarray(0, end), Buffer.from("\r\n\r\n")]);
  return (await parseEml(head)).headers;
}

interface TriageSource {
  kind: "folder" | "bucket";
  bucket?: string;
  readBytes: (item: TriageItem) => Promise<Buffer>;
  hash: (item: TriageItem) => Promise<string>;
}

/** Rules 2 and 3 (junk, then the owner's filters) for one object that rule 1 let through. */
async function applyJunkAndFilters(item: TriageItem, filters: TriageFilters, src: TriageSource, stats: TriageStats, maxReadBytes: number, isMailbox = false): Promise<void> {
  const junk = junkRule(item.fileName, item.byteSize);
  if (junk) return skip(item, "skip-junk", junk.rule, junk.reason);
  // BIGDATA-3B: a mailbox (PST, OST, MBOX) is judged message by message when it is read, by each
  // message's headers; the file's own date says nothing about its messages.
  if (isMailbox) return;
  if (isEmailName(item.fileName)) {
    if (!hasEmailFilters(filters)) return;
    let headers: EmailHeaders;
    try {
      if (item.byteSize > maxReadBytes) throw new Error("too large to read in this version");
      stats.objectsReadForFilters++;
      headers = await readEmailHeaders(item.fileName, await src.readBytes(item));
    } catch (err: unknown) {
      item.reason = `email headers could not be read (${err instanceof Error ? err.message : String(err)}): kept`;
      return;
    }
    const d = emailFilterDecision(headers, filters);
    if (d.skip) skip(item, "skip-filter", d.rule, d.reason, d.filter);
    else if (d.reason) item.reason = d.reason;
    return;
  }
  const d = fileDateDecision(item.fileDate, filters);
  if (d.skip) skip(item, "skip-filter", d.rule, d.reason, d.filter);
  else if (d.reason) item.reason = d.reason;
}

/**
 * Rule 4, exact duplicates, among the objects still to ingest. Only objects that share a size
 * with another one (or with a source the investigation already holds) can be duplicates, so
 * only those are hashed. In bucket mode the listing's CRC32C narrows it further: two objects of
 * one size are downloaded to hash them only if their CRC32C are equal too (or one is missing), or
 * the investigation holds a source of that size; and an object an earlier run already decided,
 * at the same path and generation, is not downloaded at all (its SHA-256 is on record).
 * The original is the earlier source, or else the first of the copies in path order.
 */
async function applyExactDuplicates(items: TriageItem[], idx: MatterIndex, src: TriageSource, stats: TriageStats): Promise<void> {
  const bySize = new Map<number, TriageItem[]>();
  for (const it of items) {
    if (it.decision !== "ingest") continue;
    const list = bySize.get(it.byteSize);
    if (list) list.push(it);
    else bySize.set(it.byteSize, [it]);
  }
  for (const [size, members] of bySize) {
    const existing = idx.bySize.get(size) ?? [];
    if (members.length < 2 && existing.length === 0) continue;
    const sameObject = new Set<TriageItem>();
    if (src.kind === "bucket") {
      for (const m of members) {
        const prev = idx.byObject.get(m.path);
        if (prev && m.generation !== null && prev.generation === m.generation) {
          m.sha256 = prev.sha256;
          sameObject.add(m);
        }
      }
    }
    const crcCount = new Map<string, number>();
    for (const m of members) if (m.crc32c) crcCount.set(m.crc32c, (crcCount.get(m.crc32c) ?? 0) + 1);
    const noCrc = members.filter((m) => !m.crc32c).length;
    for (const m of members) {
      if (m.sha256) continue;
      const needs =
        src.kind === "folder" ||
        existing.length > 0 ||
        !m.crc32c ||
        (crcCount.get(m.crc32c) ?? 0) >= 2 ||
        noCrc > 0;
      if (!needs) continue;
      try {
        m.sha256 = await src.hash(m);
        stats.objectsHashed++;
      } catch {
        // Unreadable now: left to the ingest, which reads it again and records the failure.
      }
    }
    const firstBySha = new Map<string, TriageItem>();
    for (const m of members) {
      if (!m.sha256) continue;
      const ex = existing.find((e) => e.sha256 === m.sha256);
      if (ex) {
        const why = sameObject.has(m)
          ? `already ingested: same object (same path and generation) as source ${ex.id}`
          : `exact duplicate of source ${ex.id} (${ex.path}), already ingested`;
        skip(m, "skip-duplicate", "exact-duplicate", why);
        m.duplicateOfPath = ex.path;
        m.duplicateOfSourceId = ex.id;
        continue;
      }
      const first = firstBySha.get(m.sha256);
      if (first) {
        skip(m, "skip-duplicate", "exact-duplicate", `exact duplicate of ${first.path}`);
        m.duplicateOfPath = first.path;
        m.duplicateOfDecisionId = first.id;
      } else {
        firstBySha.set(m.sha256, m);
      }
    }
  }
}

function toRow(ctx: RecordContext, runId: string, it: TriageItem): DecisionRow {
  return {
    id: it.id, tenant_id: ctx.resolvedTenantId, investigation_id: ctx.investigationId, run_id: runId, stage: "triage",
    path: it.path, byte_size: it.byteSize, sha256: it.sha256, crc32c: it.crc32c, generation: it.generation,
    decision: it.decision, rule: it.rule, rule_version: it.ruleVersion, reason: it.reason,
    duplicate_of_path: it.duplicateOfPath, duplicate_of_decision_id: it.duplicateOfDecisionId, duplicate_of_source_id: it.duplicateOfSourceId,
    filter: it.filter, supersedes: null, created_by: ctx.actorId,
  };
}

const DECISIONS_PER_TRANSACTION = 1000;

/**
 * Writes a run's triage decisions (in transactions of 1,000, each with its skips' audit rows),
 * then the run's ingest.triaged audit row with the counts, and marks the run triaged.
 */
async function recordTriage(db: postgres.Sql, ctx: RecordContext, runId: string, source: string, filters: TriageFilters, items: TriageItem[], stats: TriageStats): Promise<void> {
  for (let i = 0; i < items.length; i += DECISIONS_PER_TRANSACTION) {
    const rows = items.slice(i, i + DECISIONS_PER_TRANSACTION).map((it) => toRow(ctx, runId, it));
    await withTenant(ctx.resolvedTenantId, (tx) => recordDecisions(tx, ctx, rows), db);
  }
  await withTenant(ctx.resolvedTenantId, async (tx) => {
    await writeAuditEvent(tx, {
      tenantId: ctx.resolvedTenantId,
      workspaceId: ctx.workspaceId,
      investigationId: ctx.investigationId,
      actorType: "user",
      actorId: ctx.actorId,
      actorDisplay: "Ingest CLI",
      action: "ingest.triaged",
      objectType: "ingest_run",
      objectId: runId,
      objectDisplay: source,
      after: { run_id: runId, source, filters: filtersToRecord(filters), counts: stats.counts, objects: stats.objects, objects_hashed: stats.objectsHashed, objects_read_for_filters: stats.objectsReadForFilters },
      outcome: "success",
      requestId: randomUUID(),
    });
    await tx`UPDATE ingest_runs SET triaged_at = NOW(), counters = counters || ${tx.json({ triage: { ...stats.counts, objects: stats.objects, objects_hashed: stats.objectsHashed, objects_read_for_filters: stats.objectsReadForFilters, ms: Math.round(stats.ms) } })}
             WHERE id = ${runId} AND tenant_id = ${ctx.resolvedTenantId}`;
  }, db);
}

function countDecisions(items: TriageItem[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const it of items) {
    c[it.decision] = (c[it.decision] ?? 0) + 1;
    if (it.rule) c[`${it.decision}:${it.rule}`] = (c[`${it.decision}:${it.rule}`] ?? 0) + 1;
  }
  return c;
}

export interface TriageOptions {
  filters?: TriageFilters | undefined;
  includeSidecars?: boolean | undefined;
  /** Emails above this size are not read to judge a filter (kept, with the reason). */
  maxReadBytes: number;
}

/** Directory mode: rules 1-4 over the walk, recorded under a new run. */
export async function triageDirectory(db: postgres.Sql, ctx: RecordContext, dir: string, walked: WalkEntry[], opts: TriageOptions): Promise<TriageResult> {
  const t0 = performance.now();
  const filters = opts.filters ?? {};
  const runId = await startRun(db, ctx, { kind: "ingest", sourceKind: "folder", source: dir, filters });
  const stats: TriageStats = { objects: walked.length, objectsHashed: 0, objectsReadForFilters: 0, counts: {}, ms: 0 };
  const idx = await loadMatterIndex(db, ctx, false);
  const src: TriageSource = { kind: "folder", readBytes: async (it) => readFileSync(it.path), hash: (it) => sha256OfFile(it.path) };
  const items: TriageItem[] = [];
  for (const entry of walked) {
    const fileName = basename(entry.path);
    if (entry.skipReason) {
      const it = newItem(entry.path, fileName, 0);
      skip(it, "skip-filter", "not-a-file", entry.skipReason, { fixed: "links and special files are not followed; unreadable folders are listed" });
      items.push(it);
      continue;
    }
    let size = 0;
    let mtime: Date | null = null;
    try {
      const st = statSync(entry.path);
      size = st.size;
      mtime = st.mtime;
    } catch {
      // Left to the ingest, which reads it and records the failure.
    }
    const it = newItem(entry.path, fileName, size, { fileDate: mtime });
    items.push(it);
    if (!opts.includeSidecars && isPipelineSidecar(entry.path)) {
      skip(it, "skip-filter", "pipeline-sidecar", "pipeline sidecar excluded (results/)", { fixed: "pipeline sidecars are excluded unless --include-sidecars" });
      continue;
    }
    let isMailbox = false;
    try {
      isMailbox = size > 0 && mailboxFormatOfFile(entry.path, fileName) !== null;
    } catch {
      // Unreadable now: left to the ingest, which reads it and records the failure.
    }
    await applyJunkAndFilters(it, filters, src, stats, opts.maxReadBytes, isMailbox);
  }
  await applyExactDuplicates(items, idx, src, stats);
  stats.counts = countDecisions(items);
  stats.ms = performance.now() - t0;
  await recordTriage(db, ctx, runId, dir, filters, items, stats);
  stats.ms = performance.now() - t0;
  return { runId, items, triage: stats };
}

/** Bucket mode: rules 1-4 over the bucket listing (size, CRC32C, generation), recorded under a new run. */
export async function triageBucketObjects(db: postgres.Sql, ctx: RecordContext, bucket: string, prefix: string | undefined, opts: TriageOptions): Promise<TriageResult> {
  const t0 = performance.now();
  assertBucketBoundToMatter(bucket);
  const filters = opts.filters ?? {};
  const source = `gs://${bucket}${prefix ? `/${prefix}` : ""}`;
  const objects = await listBucketObjects(bucket, prefix);
  const runId = await startRun(db, ctx, { kind: "ingest", sourceKind: "bucket", source, filters });
  const stats: TriageStats = { objects: objects.length, objectsHashed: 0, objectsReadForFilters: 0, counts: {}, ms: 0 };
  const idx = await loadMatterIndex(db, ctx, true);
  const src: TriageSource = {
    kind: "bucket",
    bucket,
    readBytes: (it) => downloadBucketObject(bucket, it.objectKey!),
    hash: (it) => sha256OfBucketObject(bucket, it.objectKey!),
  };
  const items: TriageItem[] = [];
  for (const o of [...objects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const it = newItem(`gcs://${bucket}/${o.name}`, basename(o.name), o.size, {
      objectKey: o.name,
      crc32c: o.crc32c ?? null,
      generation: o.generation ?? null,
      fileDate: o.fileMtime ?? null,
    });
    items.push(it);
    if (!opts.includeSidecars && isPipelineSidecar(o.name)) {
      skip(it, "skip-filter", "pipeline-sidecar", "pipeline sidecar excluded (results/)", { fixed: "pipeline sidecars are excluded unless --include-sidecars" });
      continue;
    }
    await applyJunkAndFilters(it, filters, src, stats, opts.maxReadBytes, mailboxFormatByName(it.fileName) !== null);
  }
  await applyExactDuplicates(items, idx, src, stats);
  stats.counts = countDecisions(items);
  stats.ms = performance.now() - t0;
  await recordTriage(db, ctx, runId, source, filters, items, stats);
  stats.ms = performance.now() - t0;
  return { runId, items, triage: stats };
}

/** Resolves the matter context (tenant from the environment; investigation; the operator's user). */
export async function resolveRecordContext(db: postgres.Sql, tenantId: string, investigationId: string, userId?: string): Promise<RecordContext> {
  let workspaceId = "";
  let actorId = userId || "";
  await withTenant(tenantId, async (tx) => {
    const inv = await tx<{ workspace_id: string }[]>`
      SELECT workspace_id FROM investigations WHERE id = ${investigationId} AND tenant_id = ${tenantId} AND deleted_at IS NULL LIMIT 1`;
    if (!inv[0]) throw new Error(`Investigation ${investigationId} was not found under tenant ${tenantId}.`);
    workspaceId = inv[0].workspace_id;
    if (!actorId) actorId = (await tx<{ id: string }[]>`SELECT id FROM users WHERE tenant_id = ${tenantId} LIMIT 1`)[0]?.id || randomUUID();
  }, db);
  return { resolvedTenantId: tenantId, workspaceId, investigationId, actorId };
}

/**
 * Triage only: records a run and its decisions, and ingests nothing (`pnpm ingest --triage-only`).
 * The operator can read the report first and ingest after; the ingest then triages again as its
 * own run.
 */
export async function triageOnly(options: {
  dir?: string;
  bucket?: string;
  prefix?: string;
  investigationId: string;
  tenantId?: string;
  dbUrl?: string;
  userId?: string;
  filters?: TriageFilters;
  includeSidecars?: boolean;
  maxReadBytes?: number;
}): Promise<TriageResult> {
  const tenantId = options.tenantId || process.env.MATTER_TENANT_ID;
  if (!tenantId) throw new Error("Tenant ID is required: set MATTER_TENANT_ID in the matter environment. No other source is accepted.");
  if (Boolean(options.dir) === Boolean(options.bucket)) throw new Error("Give exactly one of a folder or a bucket.");
  const db = postgres(options.dbUrl || getDbUrl(), { max: 2 });
  try {
    const ctx = await resolveRecordContext(db, tenantId, options.investigationId, options.userId);
    const opts = { filters: options.filters, includeSidecars: options.includeSidecars, maxReadBytes: options.maxReadBytes ?? 256 * 1024 * 1024 };
    return options.bucket
      ? await triageBucketObjects(db, ctx, options.bucket, options.prefix, opts)
      : await triageDirectory(db, ctx, options.dir!, collectFiles(options.dir!), opts);
  } finally {
    await db.end();
  }
}
