import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory, type IngestBatchSummary } from "../src/ingest.js";

/**
 * BIGDATA-3 commands (D98, D103):
 *   pnpm ingest:report --run <id>     counts per decision and rule, and a CSV of every skipped object
 *                                     with the reason and what it duplicates
 *   pnpm ingest:include --run <id> (--path <p> | --rule <rule>) [--dry-run]
 *                                     ingests previously skipped objects; every re-include is audited;
 *                                     a dry run shows what it would ingest and writes nothing
 * Both run as the real commands (tsx, as `pnpm` runs them), against the local test database.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX = resolve(REPO, "node_modules/tsx/dist/cli.mjs");
const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `report_include_${Date.now()}`);
const ENV_DIR = `${TEST_DIR}-env`;
const OUT_DIR = `${TEST_DIR}-out`;
const X = "Fake report original: the fake invoice was paid twice.";

describe("tools/ingest-cli — pnpm ingest:report and pnpm ingest:include", () => {
  let tenantId: string;
  let investigationId: string;
  let run: IngestBatchSummary;
  const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };
  const cli = (script: string, args: string[]) => {
    const r = spawnSync(process.execPath, [TSX, `tools/ingest-cli/src/${script}`, ...args], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, MATTER_TENANT_ID: tenantId },
      timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
  };
  const rowCounts = () => q(async (tx) => ({
    runs: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ingest_runs WHERE investigation_id = ${investigationId}`)[0]!.n,
    decisions: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ingest_decisions WHERE investigation_id = ${investigationId}`)[0]!.n,
    sources: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE investigation_id = ${investigationId}`)[0]!.n,
    audit: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_events WHERE investigation_id = ${investigationId}`)[0]!.n,
  }));

  beforeAll(async () => {
    mkdirSync(join(TEST_DIR, "sub"), { recursive: true });
    mkdirSync(ENV_DIR, { recursive: true });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "Thumbs.db"), "fake thumbnail cache");
    writeFileSync(join(TEST_DIR, "sub", "desktop.ini"), "[.ShellClassInfo]\r\n; fake");
    writeFileSync(join(TEST_DIR, "empty.txt"), "");
    writeFileSync(join(TEST_DIR, "original.txt"), X);
    writeFileSync(join(TEST_DIR, "sub", "copy, with a comma.txt"), X);
    writeFileSync(join(TEST_DIR, "old-note.txt"), "Fake note from 2017.");
    utimesSync(join(TEST_DIR, "old-note.txt"), new Date("2017-02-02T00:00:00Z"), new Date("2017-02-02T00:00:00Z"));
    writeFileSync(join(TEST_DIR, "kept.txt"), "Fake note that is simply ingested.");
    const boot = await bootstrap({
      name: `BIGDATA-3 report WS ${Date.now()}`,
      investigationName: "BIGDATA-3 report",
      email: `bigdata3-report-${Date.now()}@casefile.test`,
      matter: `bigdata3-report-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    tenantId = boot.tenantId;
    investigationId = boot.investigationId;
    run = await ingestDirectory({ dir: TEST_DIR, investigationId, tenantId, dbUrl: getDbUrl(), filters: { fileDateFrom: "2020-01-01" } });
  }, 120_000);

  afterAll(() => {
    for (const d of [TEST_DIR, ENV_DIR, OUT_DIR]) rmSync(d, { recursive: true, force: true });
  });

  it("ingest:report prints the counts per decision and rule, and the run's filters", () => {
    const r = cli("report.ts", ["--run", run.runId, "--csv", join(OUT_DIR, "skipped.csv")]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Run ${run.runId}`);
    expect(r.stdout).toContain('Filters chosen for this run: {"file_date_from":"2020-01-01"}');
    expect(r.stdout).toMatch(/ingest\s+-\s+2\n/);
    expect(r.stdout).toMatch(/skip-junk\s+junk-name v1\s+2\n/);
    expect(r.stdout).toMatch(/skip-junk\s+junk-empty v1\s+1\n/);
    expect(r.stdout).toMatch(/skip-duplicate\s+exact-duplicate v1\s+1\n/);
    expect(r.stdout).toMatch(/skip-filter\s+file-date v1\s+1\n/);
    expect(r.stdout).toContain("Skipped objects: 5, written to");
  });

  it("the CSV lists every skipped object once, with the reason and what it duplicates", () => {
    const lines = readFileSync(join(OUT_DIR, "skipped.csv"), "utf8").trimEnd().split(/\r?\n/);
    expect(lines[0]).toBe("path,byte_size,decision,rule,rule_version,reason,duplicate_of_path,duplicate_of_source_id,filter,sha256,stage,decision_id,re_included_by");
    for (const l of lines.slice(1)) expect(l.endsWith(",")).toBe(true); // nothing re-included yet
    expect(lines).toHaveLength(6);
    const body = lines.slice(1).join("\n");
    for (const n of ["Thumbs.db", "sub/desktop.ini", "empty.txt", "old-note.txt"]) expect(body).toContain(join(TEST_DIR, n));
    const dup = lines.find((l) => l.includes("copy, with a comma.txt"))!;
    expect(dup.startsWith(`"${join(TEST_DIR, "sub", "copy, with a comma.txt")}",`)).toBe(true);
    expect(dup).toContain(`,skip-duplicate,exact-duplicate,1,`);
    expect(dup).toContain(join(TEST_DIR, "original.txt"));
    expect(lines.find((l) => l.includes("old-note.txt"))).toContain("file-date");
  });

  it("ingest:include --dry-run lists what it would ingest and writes nothing", async () => {
    const counts = await rowCounts();
    const r = cli("include.ts", ["--run", run.runId, "--rule", "junk-name", "--dry-run"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY RUN: nothing was written");
    expect(r.stdout).toContain("Would include 2 object(s)");
    expect(r.stdout).toContain(join(TEST_DIR, "Thumbs.db"));
    expect(r.stdout).toContain(join(TEST_DIR, "sub", "desktop.ini"));
    expect(await rowCounts()).toEqual(counts);
  });

  it("ingest:include --path ingests one skipped object, records a new decision that supersedes the old one, and audits it", async () => {
    const old = (await q((tx) => tx<{ id: string }[]>`SELECT id FROM ingest_decisions WHERE run_id = ${run.runId} AND path = ${join(TEST_DIR, "old-note.txt")}`))[0]!;
    const r = cli("include.ts", ["--run", run.runId, "--path", join(TEST_DIR, "old-note.txt")]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Included 1 object(s)");
    const now = await q((tx) => tx<{ id: string; run_id: string; stage: string; decision: string; rule: string; supersedes: string }[]>`
      SELECT * FROM ingest_decisions WHERE supersedes = ${old.id}`);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ stage: "include", decision: "ingest", rule: "reinclude" });
    const inc = await q((tx) => tx<{ kind: string; include_of_run: string }[]>`SELECT kind, include_of_run FROM ingest_runs WHERE id = ${now[0]!.run_id}`);
    expect(inc[0]).toMatchObject({ kind: "include", include_of_run: run.runId });
    const src = await q((tx) => tx<{ id: string; status: string }[]>`SELECT id, status FROM sources WHERE investigation_id = ${investigationId} AND filename = 'old-note.txt'`);
    expect(src).toEqual([{ id: expect.any(String), status: "indexed" }]);
    const audit = await q((tx) => tx<{ object_type: string; object_id: string; after: unknown }[]>`
      SELECT object_type, object_id, after FROM audit_events WHERE investigation_id = ${investigationId} AND action = 'source.reinclude'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ object_type: "ingest_decision", object_id: now[0]!.id });
    const after = (typeof audit[0]!.after === "string" ? JSON.parse(audit[0]!.after) : audit[0]!.after) as Record<string, unknown>;
    expect(after).toMatchObject({ path: join(TEST_DIR, "old-note.txt"), supersedes: old.id, previous_decision: "skip-filter", previous_rule: "file-date", source_id: src[0]!.id });
  });

  it("ingest:include --rule re-includes a whole rule; a re-included duplicate is recorded as another copy of the source, not indexed twice", async () => {
    const r = cli("include.ts", ["--run", run.runId, "--rule", "exact-duplicate"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Included 1 object(s)");
    const orig = await q((tx) => tx<{ id: string }[]>`SELECT id FROM sources WHERE investigation_id = ${investigationId} AND filename = 'original.txt'`);
    expect(orig).toHaveLength(1);
    const copies = await q((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM source_instances WHERE source_id = ${orig[0]!.id}`);
    expect(copies[0]!.n).toBe(2);
    expect(await q((tx) => tx`SELECT id FROM sources WHERE filename = 'copy, with a comma.txt'`)).toEqual([]);
    const audit = await q((tx) => tx<{ after: unknown }[]>`SELECT after FROM audit_events WHERE investigation_id = ${investigationId} AND action = 'source.reinclude' ORDER BY seq DESC LIMIT 1`);
    const after = (typeof audit[0]!.after === "string" ? JSON.parse(audit[0]!.after) : audit[0]!.after) as Record<string, unknown>;
    expect(after).toMatchObject({ previous_decision: "skip-duplicate", linked_as_copy_of: orig[0]!.id });
  });

  it("after re-includes, the report still lists every skip, names the decision that re-included each one, and counts what is still skipped", () => {
    const r = cli("report.ts", ["--run", run.runId, "--csv", join(OUT_DIR, "skipped-2.csv")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Skipped objects: 5, written to");
    expect(r.stdout).toMatch(/Re-included later: 2\r?\n/);
    expect(r.stdout).toMatch(/Still skipped: 3\r?\n/);
    const lines = readFileSync(join(OUT_DIR, "skipped-2.csv"), "utf8").trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(6);
    const reIncluded = lines.slice(1).filter((l) => /,[0-9a-f]{8}-[0-9a-f-]{27}$/.test(l));
    expect(reIncluded).toHaveLength(2);
    expect(reIncluded.some((l) => l.includes("old-note.txt"))).toBe(true);
    expect(reIncluded.some((l) => l.includes("copy, with a comma.txt"))).toBe(true);
  });

  it("refuses: no --path or --rule, both, an unknown run, and a path that was not skipped", () => {
    expect(cli("include.ts", ["--run", run.runId]).status).not.toBe(0);
    expect(cli("include.ts", ["--run", run.runId, "--path", "x", "--rule", "junk-name"]).status).not.toBe(0);
    const unknown = cli("include.ts", ["--run", "00000000-0000-4000-8000-000000000000", "--rule", "junk-name"]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("not found");
    const notSkipped = cli("include.ts", ["--run", run.runId, "--path", join(TEST_DIR, "kept.txt")]);
    expect(notSkipped.status).not.toBe(0);
    expect(notSkipped.stderr).toContain("no skipped object");
    expect(existsSync(join(OUT_DIR, "skipped.csv"))).toBe(true);
  });
});
