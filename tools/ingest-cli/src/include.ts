import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, getDbUrl } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import { computeSha256, downloadBucketObject, sha256OfBucketObject, sha256OfFile, bucketObjectReadStream, downloadBucketObjectToFile } from "@casefile/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailboxFormatByName, messageIdentity, readOneMessage } from "./mailbox.js";
import { messageMetadata } from "./mailbox-ingest.js";
import { messageFileName, parseMessageSegment } from "./mailbox-paths.js";
import { extractZipArchive, parseEml, parseMsg } from "../../../apps/api/src/services/document-parsers.js";
import { parseArgs, loadEnv } from "./args.js";
import { assertBucketBoundToMatter, finishRun, recordDecisions, resolveRecordContext, startRun, type DecisionRow } from "./triage.js";
import { RULE_VERSIONS } from "./triage-rules.js";
import { DEFAULT_MAX_PARSE_BYTES, ingestInTransaction, openRunState, type IngestFileResult } from "./ingest.js";
import { advanceNearDuplicates } from "./near-duplicate-pass.js";

loadEnv();

/**
 * `pnpm ingest:include --run <id> (--path <p> | --rule <rule>) [--dry-run]` (BIGDATA-3, D103).
 *
 * Ingests objects a run skipped: one object by the path the report lists, or every object one
 * rule skipped. The skip decision is never changed. The include is its own run (kind 'include',
 * pointing at the run it re-includes from) and writes, per object, a new decision (stage
 * 'include', rule 'reinclude') that supersedes the skip, and a source.reinclude audit row, in the
 * same transaction as the object's admission. With --dry-run it lists what it would ingest and
 * writes nothing.
 *
 * A re-included duplicate is not stored or indexed a second time: its bytes are already a source,
 * so it is recorded as another acquisition (another copy) of that source. An item inside a zip or
 * an email is read out of its container again. The include reads objects; it never writes to,
 * moves, copies or deletes anything in a bucket (guardrails/bucket-deletion.spec.ts); only the
 * ingest it calls stores a new object for an item that came out of a container, as ingest does.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SelectedDecision {
  id: string;
  path: string;
  byte_size: string;
  sha256: string | null;
  decision: string;
  rule: string;
  reason: string | null;
  stage: string;
}

export interface IncludeResult {
  path: string;
  previousDecision: string;
  previousRule: string;
  status: IngestFileResult["status"] | "linked";
  reason?: string | undefined;
  sourceId?: string | undefined;
  decisionId?: string | undefined;
}

export interface IncludeOutcome {
  includeRunId: string | null;
  selected: SelectedDecision[];
  results: IncludeResult[];
}

const parseGcs = (p: string) => {
  const m = /^gcs:\/\/([^/]+)\/(.+)$/.exec(p);
  return m ? { bucket: m[1]!, key: m[2]! } : null;
};

/** The bytes of a top-level object (a file, or a bucket object), read only. */
async function readTopLevel(path: string): Promise<Buffer> {
  const g = parseGcs(path);
  if (g) {
    assertBucketBoundToMatter(g.bucket);
    return downloadBucketObject(g.bucket, g.key);
  }
  return readFileSync(path);
}

/**
 * BIGDATA-3B: a message of a mailbox, by its `mailbox:<folder>/<locator>` segment: read again out
 * of the mailbox file (an MBOX from the message's offset; a PST by node id, from a temporary copy
 * in bucket mode), with the metadata the ingest gives a message.
 */
async function readMailboxMessage(container: string, segment: string): Promise<{ bytes: Buffer; fileName: string; metadata: Record<string, unknown> }> {
  const loc = parseMessageSegment(segment);
  const format = mailboxFormatByName(basename(parseGcs(container)?.key ?? container));
  if (!loc || !format) throw new Error(`"${segment}" is not a message of a mailbox file`);
  const g = parseGcs(container);
  let tempDir: string | null = null;
  try {
    let source: { path: string } | { streamFromOffset: () => AsyncIterable<Buffer> };
    if (!g) source = { path: container };
    else {
      assertBucketBoundToMatter(g.bucket);
      if (format === "mbox") {
        const stream = await bucketObjectReadStream(g.bucket, g.key, { start: loc.locator.kind === "offset" ? loc.locator.offset : 0 });
        source = { streamFromOffset: () => stream };
      } else {
        tempDir = mkdtempSync(join(tmpdir(), "casefile-include-"));
        const p = join(tempDir, basename(g.key));
        await downloadBucketObjectToFile(g.bucket, g.key, p);
        source = { path: p };
      }
    }
    const one = await readOneMessage(format, source, loc.locator, { maxMessageBytes: DEFAULT_MAX_PARSE_BYTES });
    const parsed = await parseEml(one.bytes);
    const hash = await messageIdentity(parsed);
    const locator = segment.split("/").pop()!;
    const metadata = messageMetadata({ fileName: basename(g?.key ?? container), path: container, format }, loc.folder, locator, parsed, hash, one.rendered, one.meta);
    return { bytes: one.bytes, fileName: messageFileName(parsed.headers.subject ?? ""), metadata };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * An item inside a container, by the path the ingest recorded: `<container>#<zip entry path>`,
 * `<email>#attachment:<file name>` or (BIGDATA-3B) `<mailbox>#mailbox:<folder>/<locator>`, one
 * level per '#'. The container is read again and the item taken out of it.
 */
async function readInsideContainer(path: string): Promise<{ bytes: Buffer; fileName: string; container: string; metadata?: Record<string, unknown> }> {
  const [container, ...segments] = path.split("#");
  let bytes: Buffer;
  let name: string;
  let metadata: Record<string, unknown> | undefined;
  if (segments[0]?.startsWith("mailbox:")) {
    const m = await readMailboxMessage(container!, segments.shift()!);
    bytes = m.bytes;
    name = m.fileName;
    if (segments.length === 0) metadata = m.metadata;
  } else {
    bytes = await readTopLevel(container!);
    name = basename(parseGcs(container!)?.key ?? container!);
  }
  for (const seg of segments) {
    if (seg.startsWith("attachment:")) {
      const want = seg.slice("attachment:".length);
      const email = name.toLowerCase().endsWith(".msg") ? await parseMsg(bytes) : await parseEml(bytes);
      const att = email.attachments.find((a) => a.filename === want);
      if (!att) throw new Error(`attachment "${want}" is no longer in ${name}`);
      bytes = att.content;
      name = att.filename;
    } else {
      const entry = (await extractZipArchive(bytes)).entries.find((e) => e.path === seg);
      if (!entry) throw new Error(`entry "${seg}" is no longer in ${name}`);
      bytes = entry.content;
      name = entry.filename;
    }
  }
  return { bytes, fileName: name, container: container!, ...(metadata ? { metadata } : {}) };
}

export async function includeSkipped(options: {
  runId: string;
  path?: string | undefined;
  rule?: string | undefined;
  dryRun?: boolean | undefined;
  tenantId?: string | undefined;
  dbUrl?: string | undefined;
  userId?: string | undefined;
}): Promise<IncludeOutcome> {
  const tenantId = options.tenantId || process.env.MATTER_TENANT_ID;
  if (!tenantId) throw new Error("Tenant ID is required: set MATTER_TENANT_ID in the matter environment.");
  if (Boolean(options.path) === Boolean(options.rule)) throw new Error("Give exactly one of --path <path> or --rule <rule>.");
  if (!UUID.test(options.runId)) throw new Error(`Run ${options.runId} not found in this matter (not a run id)`);

  const db = postgres(options.dbUrl || getDbUrl(), { max: 2 });
  try {
    const { run, selected } = await withTenant(tenantId, async (tx) => {
      const runs = await tx<{ id: string; investigation_id: string; source_kind: "folder" | "bucket"; source: string }[]>`
        SELECT id, investigation_id, source_kind, source FROM ingest_runs WHERE id = ${options.runId} AND tenant_id = ${tenantId}`;
      if (!runs[0]) throw new Error(`Run ${options.runId} not found in this matter`);
      // Skips of this run that no later decision has superseded, in the run's order.
      const rows = await tx<SelectedDecision[]>`
        SELECT d.id, d.path, d.byte_size, d.sha256, d.decision, d.rule, d.reason, d.stage FROM ingest_decisions d
        WHERE d.tenant_id = ${tenantId} AND d.run_id = ${options.runId} AND d.decision <> 'ingest'
          AND (${options.path ?? null}::text IS NULL OR d.path = ${options.path ?? null})
          AND (${options.rule ?? null}::text IS NULL OR d.rule = ${options.rule ?? null})
          AND NOT EXISTS (SELECT 1 FROM ingest_decisions s WHERE s.tenant_id = ${tenantId} AND s.supersedes = d.id AND s.stage = 'include')
        ORDER BY d.seq`;
      return { run: runs[0], selected: rows };
    }, db);
    if (selected.length === 0) {
      throw new Error(`no skipped object in run ${options.runId} matches ${options.path ? `--path ${options.path}` : `--rule ${options.rule}`} (or it was re-included already)`);
    }
    if (options.dryRun) return { includeRunId: null, selected, results: [] };

    const rec = await resolveRecordContext(db, tenantId, run.investigation_id, options.userId);
    const includeRunId = await startRun(db, rec, { kind: "include", sourceKind: run.source_kind, source: run.source, filters: {}, includeOfRun: run.id });
    const state = await openRunState(db, rec, includeRunId, {}, 0);
    const bucketSourcesEnv = process.env.GCS_BUCKET_SOURCES || "sources";
    const results: IncludeResult[] = [];

    for (const d of selected) {
      const base: IncludeResult = { path: d.path, previousDecision: d.decision, previousRule: d.rule, status: "failed" };
      try {
        const inContainer = d.path.includes("#");
        const g = inContainer ? null : parseGcs(d.path);
        let fileName: string;
        let fileBytes: Buffer;
        let byteSize: number;
        let sha256: string;
        let tooLargeToParse: { limitBytes: number; localPath?: string } | undefined;
        let sourceMetadata: Record<string, unknown> | undefined;
        if (inContainer) {
          const item = await readInsideContainer(d.path);
          fileName = item.fileName;
          fileBytes = item.bytes;
          byteSize = item.bytes.length;
          sha256 = computeSha256(item.bytes);
          sourceMetadata = { reincluded_from_container: item.container, ...(item.metadata ?? {}) };
        } else {
          fileName = basename(g?.key ?? d.path);
          const size = g ? Number(d.byte_size) : statSync(d.path).size;
          if (size > DEFAULT_MAX_PARSE_BYTES) {
            if (g) assertBucketBoundToMatter(g.bucket);
            sha256 = g ? await sha256OfBucketObject(g.bucket, g.key) : await sha256OfFile(d.path);
            fileBytes = Buffer.alloc(0);
            byteSize = size;
            tooLargeToParse = g ? { limitBytes: DEFAULT_MAX_PARSE_BYTES } : { limitBytes: DEFAULT_MAX_PARSE_BYTES, localPath: d.path };
          } else {
            fileBytes = await readTopLevel(d.path);
            byteSize = fileBytes.length;
            sha256 = computeSha256(fileBytes);
          }
        }
        const decisionId = randomUUID();
        const result = await ingestInTransaction(
          db,
          {
            resolvedTenantId: tenantId,
            workspaceId: rec.workspaceId,
            investigationId: rec.investigationId,
            actorId: rec.actorId,
            fileName,
            sourcePath: d.path,
            fileBytes,
            byteSize,
            sha256,
            isBucketSource: Boolean(g),
            bucketSources: g ? g.bucket : bucketSourcesEnv,
            bucketArtifacts: process.env.GCS_BUCKET_ARTIFACTS || "artifacts",
            tooLargeToParse,
            ...(sourceMetadata ? { sourceMetadata } : {}),
            run: state,
            reinclude: true,
          },
          async (tx, r) => {
            const row: DecisionRow = {
              id: decisionId, tenant_id: tenantId, investigation_id: rec.investigationId, run_id: includeRunId, stage: "include",
              path: d.path, byte_size: byteSize, sha256, crc32c: null, generation: null, decision: "ingest", rule: "reinclude",
              rule_version: RULE_VERSIONS.reinclude, reason: `re-included by the operator (was ${d.decision}, rule ${d.rule})`,
              duplicate_of_path: null, duplicate_of_decision_id: null, duplicate_of_source_id: null, filter: null, supersedes: d.id, created_by: rec.actorId,
            };
            await recordDecisions(tx, rec, [row]);
            await writeAuditEvent(tx, {
              tenantId,
              workspaceId: rec.workspaceId,
              investigationId: rec.investigationId,
              actorType: "user",
              actorId: rec.actorId,
              actorDisplay: "Ingest CLI (include)",
              action: "source.reinclude",
              objectType: "ingest_decision",
              objectId: decisionId,
              objectDisplay: fileName,
              after: {
                path: d.path,
                supersedes: d.id,
                previous_decision: d.decision,
                previous_rule: d.rule,
                previous_reason: d.reason,
                run_id: includeRunId,
                include_of_run: run.id,
                status: r.linkedCopyOf ? "linked" : r.status,
                ...(r.sourceId ? { source_id: r.sourceId } : {}),
                ...(r.linkedCopyOf ? { linked_as_copy_of: r.linkedCopyOf } : {}),
              },
              outcome: "success",
              requestId: randomUUID(),
            });
          },
        );
        results.push({ ...base, status: result.linkedCopyOf ? "linked" : result.status, reason: result.reason, sourceId: result.sourceId, decisionId });
      } catch (err: unknown) {
        results.push({ ...base, status: "failed", reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // BIGDATA-4: the included documents are grouped with the matter's near-duplicates in the order
    // they were written (the ordered pass, the index in the database).
    await advanceNearDuplicates(db, rec, includeRunId);
    const count = (s: string) => results.filter((r) => r.status === s).length;
    await finishRun(db, rec, includeRunId, {
      include: { selected: selected.length, indexed: count("indexed"), needs_ocr: count("needs_ocr"), stored_unparsed: count("stored_unparsed"), linked: count("linked"), skipped: count("skipped"), unprocessable: count("unprocessable"), failed: count("failed") },
    });
    return { includeRunId, selected, results };
  } finally {
    await db.end();
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const runId = typeof args["run"] === "string" ? args["run"] : "";
  const path = typeof args["path"] === "string" ? args["path"] : undefined;
  const rule = typeof args["rule"] === "string" ? args["rule"] : undefined;
  const dryRun = Boolean(args["dry-run"]);
  if (!runId || Boolean(path) === Boolean(rule)) {
    console.error("Usage: pnpm ingest:include --run <run id> (--path <path> | --rule <rule>) [--dry-run]");
    console.error("  exactly one of --path (as ingest:report lists it) or --rule (junk-name, junk-empty, exact-duplicate, message-duplicate, email-date, file-date, person, exclude-person, pipeline-sidecar, not-a-file)");
    process.exit(1);
  }
  try {
    const out = await includeSkipped({ runId, path, rule, dryRun });
    console.log("================================================================================");
    if (dryRun) {
      console.log("DRY RUN: nothing was written");
      console.log(`Would include ${out.selected.length} object(s) skipped by run ${runId}:`);
      for (const d of out.selected) console.log(`  ${d.decision.padEnd(15)} ${d.rule.padEnd(16)} ${d.path}  (${d.reason ?? ""})`);
    } else {
      console.log(`Include run ${out.includeRunId} (re-includes from run ${runId})`);
      for (const r of out.results) console.log(`  ${r.status.padEnd(15)} ${r.path}  (was ${r.previousDecision}, rule ${r.previousRule}${r.reason ? `; ${r.reason}` : ""})`);
      const failed = out.results.filter((r) => r.status === "failed").length;
      console.log(`Included ${out.results.length - failed} object(s); ${failed} failed. Each one has a source.reinclude audit row.`);
      if (failed > 0) process.exitCode = 1;
    }
    console.log("================================================================================");
  } catch (err: unknown) {
    console.error(`ingest:include failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (/^include\.(ts|js)$/.test(basename(process.argv[1] ?? ""))) {
  runCli();
}
