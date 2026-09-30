import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import postgres from "postgres";
import { withTenant, getDbUrl } from "@casefile/db";
import { parseArgs, loadEnv } from "./args.js";

loadEnv();

/**
 * `pnpm ingest:report --run <id> [--csv <file>] [--near-duplicates-csv <file>]` (BIGDATA-3, D98).
 *
 * What a run decided: the owner's filters and the rule versions it ran with, the number of
 * decisions per stage, decision and rule, and a CSV of every object it skipped, with the reason,
 * what it duplicates, the filter that caught it, and the decision that re-included it later (if
 * one did). It only reads the matter's database; it reads and writes no bucket.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportRun {
  id: string;
  kind: string;
  source_kind: string;
  source: string;
  filters: Record<string, unknown>;
  rule_versions: Record<string, unknown>;
  counters: Record<string, unknown>;
  include_of_run: string | null;
  started_at: Date;
  triaged_at: Date | null;
  finished_at: Date | null;
}

export interface SkippedRow {
  path: string;
  byte_size: string;
  decision: string;
  rule: string;
  rule_version: number;
  reason: string | null;
  duplicate_of_path: string | null;
  duplicate_of_source_id: string | null;
  filter: Record<string, unknown> | null;
  sha256: string | null;
  stage: string;
  decision_id: string;
  re_included_by: string | null;
}

export interface NearDuplicateRow {
  source_id: string;
  path: string;
  near_duplicate_of: string;
  near_duplicate_of_path: string;
  similarity: string;
}

export interface IngestReport {
  run: ReportRun;
  counts: Array<{ stage: string; decision: string; rule: string | null; rule_version: number | null; n: number }>;
  skipped: SkippedRow[];
  nearDuplicates: NearDuplicateRow[];
  nearDuplicateGroups: number;
  /** BIGDATA-4: the run's work items that failed (after their attempts), with their last error. */
  failedItems: Array<{ path: string; kind: string; part_no: number; attempts: number; last_error: string | null }>;
}

const sourcePath = (metadata: unknown, fallback: string): string => {
  const m = typeof metadata === "string" ? JSON.parse(metadata) : metadata; // rows written before FIXES-1 hold the JSON as text (DEV-031)
  return String((m as { source_path?: string } | null)?.source_path ?? fallback);
};

export async function buildIngestReport(options: { runId: string; tenantId?: string; dbUrl?: string }): Promise<IngestReport> {
  const tenantId = options.tenantId || process.env.MATTER_TENANT_ID;
  if (!tenantId) throw new Error("Tenant ID is required: set MATTER_TENANT_ID in the matter environment.");
  if (!UUID.test(options.runId)) throw new Error(`Run ${options.runId} not found in this matter (not a run id)`);
  const db = postgres(options.dbUrl || getDbUrl(), { max: 1 });
  try {
    return await withTenant(tenantId, async (tx) => {
      const runs = await tx<ReportRun[]>`SELECT * FROM ingest_runs WHERE id = ${options.runId} AND tenant_id = ${tenantId}`;
      const run = runs[0];
      if (!run) throw new Error(`Run ${options.runId} not found in this matter`);
      const counts = await tx<Array<{ stage: string; decision: string; rule: string | null; rule_version: number | null; n: number }>>`
        SELECT stage, decision, rule, rule_version, count(*)::int AS n FROM ingest_decisions
        WHERE tenant_id = ${tenantId} AND run_id = ${run.id}
        GROUP BY stage, decision, rule, rule_version
        ORDER BY CASE stage WHEN 'triage' THEN 0 WHEN 'ingest' THEN 1 ELSE 2 END, decision, rule NULLS FIRST`;
      const skipped = await tx<SkippedRow[]>`
        SELECT d.path, d.byte_size, d.decision, d.rule, d.rule_version, d.reason, d.duplicate_of_path, d.duplicate_of_source_id,
               d.filter, d.sha256, d.stage, d.id AS decision_id,
               (SELECT s.id FROM ingest_decisions s WHERE s.tenant_id = ${tenantId} AND s.supersedes = d.id ORDER BY s.seq LIMIT 1) AS re_included_by
        FROM ingest_decisions d
        WHERE d.tenant_id = ${tenantId} AND d.run_id = ${run.id} AND d.decision <> 'ingest'
        ORDER BY d.seq`;
      const near = await tx<Array<{ source_id: string; meta: unknown; uri: string; near_duplicate_of: string; of_meta: unknown; of_uri: string; similarity: string }>>`
        SELECT f.source_id, s.metadata AS meta, s.storage_uri AS uri, f.near_duplicate_of, o.metadata AS of_meta, o.storage_uri AS of_uri, f.similarity
        FROM document_fingerprints f
        JOIN sources s ON s.id = f.source_id AND s.tenant_id = f.tenant_id
        JOIN sources o ON o.id = f.near_duplicate_of AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = ${tenantId} AND f.run_id = ${run.id} AND f.near_duplicate_of IS NOT NULL
        ORDER BY f.created_at, f.id`;
      const nearDuplicates = near.map((r) => ({
        source_id: r.source_id,
        path: sourcePath(r.meta, r.uri),
        near_duplicate_of: r.near_duplicate_of,
        near_duplicate_of_path: sourcePath(r.of_meta, r.of_uri),
        similarity: String(r.similarity),
      }));
      const failedItems = await tx<IngestReport["failedItems"]>`
        SELECT path, kind, part_no, attempts, last_error FROM ingest_work
        WHERE tenant_id = ${tenantId} AND run_id = ${run.id} AND state = 'failed' ORDER BY top_seq, part_no`;
      return { run, counts, skipped, nearDuplicates, nearDuplicateGroups: new Set(nearDuplicates.map((n) => n.near_duplicate_of)).size, failedItems };
    }, db);
  } finally {
    await db.end();
  }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SKIPPED_CSV_COLUMNS = [
  "path", "byte_size", "decision", "rule", "rule_version", "reason", "duplicate_of_path", "duplicate_of_source_id",
  "filter", "sha256", "stage", "decision_id", "re_included_by",
] as const satisfies readonly (keyof SkippedRow)[];

export function skippedCsv(rows: readonly SkippedRow[]): string {
  return [SKIPPED_CSV_COLUMNS.join(","), ...rows.map((r) => SKIPPED_CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

export function nearDuplicatesCsv(rows: readonly NearDuplicateRow[]): string {
  const cols = ["path", "source_id", "near_duplicate_of_path", "near_duplicate_of", "similarity"] as const;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

export function formatReport(r: IngestReport, csvPath: string, nearCsvPath: string | null): string {
  const ts = (d: Date | null) => (d ? d.toISOString() : "not yet");
  const lines = [
    "================================================================================",
    `Run ${r.run.id}`,
    `  ${r.run.kind} run, ${r.run.source_kind} ${r.run.source}${r.run.include_of_run ? ` (re-includes from run ${r.run.include_of_run})` : ""}`,
    `  started ${ts(r.run.started_at)}, triaged ${ts(r.run.triaged_at)}, finished ${ts(r.run.finished_at)}`,
    `Filters chosen for this run: ${Object.keys(r.run.filters).length ? JSON.stringify(r.run.filters) : "none"}`,
    `Rule versions: ${JSON.stringify(r.run.rule_versions)}`,
    "────────────────────────────────────────────────────────────────────────────────",
    "Decisions (stage, decision, rule and version, count):",
    ...r.counts.map((c) => `  ${c.stage.padEnd(8)} ${c.decision.padEnd(16)} ${(c.rule ? `${c.rule} v${c.rule_version}` : "-").padEnd(24)} ${c.n}`),
    "────────────────────────────────────────────────────────────────────────────────",
    `Skipped objects: ${r.skipped.length}, written to ${csvPath}`,
    `  Re-included later: ${r.skipped.filter((s) => s.re_included_by).length}`,
    `  Still skipped: ${r.skipped.filter((s) => !s.re_included_by).length}`,
    `  To re-include: pnpm ingest:include --run ${r.run.id} --path <path from the CSV>   or   --rule <rule>   (add --dry-run to see first)`,
    `Near-duplicates found in this run: ${r.nearDuplicates.length} documents in ${r.nearDuplicateGroups} groups (every one of them is indexed)${nearCsvPath ? `, written to ${nearCsvPath}` : " (--near-duplicates-csv <file> to list them)"}`,
    ...mailboxLines(r.run.counters.mailboxes),
    ...(r.failedItems.length
      ? [
          "────────────────────────────────────────────────────────────────────────────────",
          `Failed items: ${r.failedItems.length} (each has a source.ingest_failed audit row; pnpm ingest:retry --run ${r.run.id} puts them back)`,
          ...r.failedItems.map((f) => `  ${f.path}${f.kind === "mailbox-part" ? ` (part ${f.part_no})` : ""}: ${f.last_error ?? ""} (${f.attempts} attempts)`),
        ]
      : []),
    `Outcomes: ${JSON.stringify({ ...r.run.counters, mailboxes: undefined })}`,
    "================================================================================",
  ];
  return lines.join("\n");
}

/**
 * BIGDATA-3B: one block per mailbox file of the run (ingest_runs.counters.mailboxes): its format
 * and status (a mailbox that could not be read says why), the messages read, admitted and set
 * aside by rule (every one of those is a row of the CSV above), the messages and folders that
 * could not be read (the first of them by path), and where reading stopped short, if it did.
 */
function mailboxLines(mailboxes: unknown): string[] {
  if (!Array.isArray(mailboxes) || mailboxes.length === 0) return [];
  const out = ["────────────────────────────────────────────────────────────────────────────────", `Mailboxes: ${mailboxes.length} (PST, OST and MBOX files, read message by message)`];
  for (const raw of mailboxes) {
    const m = raw as Record<string, unknown>;
    out.push(`  ${String(m.path)}`);
    // BIGDATA-4 (answer 1): a PST whose store had a password is read, and says so.
    out.push(`    ${String(m.format)}, ${String(m.status)}${m.password_protected ? ", had a password (read: a PST password is a check, not encryption)" : ""}${m.reason ? `: ${String(m.reason)}` : ""}`);
    if (m.status !== "stored_unparsed") {
      const skipped = Object.entries((m.messages_skipped as Record<string, number> | undefined) ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
      const att = (m.attachments as Record<string, number> | undefined) ?? {};
      out.push(`    messages read ${String(m.messages_read)}, admitted ${String(m.messages_admitted)}, skipped ${skipped}, unreadable ${String(m.failed)}`);
      out.push(`    attachments admitted ${att.admitted ?? 0}, skipped ${att.skipped ?? 0}, failed ${att.failed ?? 0}; near-duplicates ${String(m.near_duplicates ?? 0)}; folders not read (search folders) ${String(m.folders_skipped ?? 0)}`);
    }
    if (m.stopped_at) out.push(`    stopped: ${String(m.stopped_at)}`);
    const errors = (m.errors as Array<{ path: string; reason: string }> | undefined) ?? [];
    for (const e of errors.slice(0, 5)) out.push(`    unreadable: ${e.path}: ${e.reason}`);
    const att = (m.attachments as Record<string, number> | undefined) ?? {};
    const more = Number(m.failed ?? 0) + Number(att.failed ?? 0) - Math.min(errors.length, 5);
    if (more > 0) out.push(`    ... and ${more} more unreadable (each has a source.ingest_failed audit row with its path)`);
  }
  return out;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const runId = typeof args["run"] === "string" ? args["run"] : "";
  if (!runId) {
    console.error("Usage: pnpm ingest:report --run <run id> [--csv <file>] [--near-duplicates-csv <file>]");
    process.exit(1);
  }
  try {
    const report = await buildIngestReport({ runId });
    const csvPath = resolve(process.cwd(), typeof args["csv"] === "string" ? args["csv"] : `ingest-report-${runId}-skipped.csv`);
    writeFileSync(csvPath, skippedCsv(report.skipped));
    const nearArg = args["near-duplicates-csv"];
    const nearCsvPath = typeof nearArg === "string" ? resolve(process.cwd(), nearArg) : null;
    if (nearCsvPath) writeFileSync(nearCsvPath, nearDuplicatesCsv(report.nearDuplicates));
    console.log(formatReport(report, csvPath, nearCsvPath));
  } catch (err: unknown) {
    console.error(`ingest:report failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (/^report\.(ts|js)$/.test(basename(process.argv[1] ?? ""))) {
  runCli();
}
