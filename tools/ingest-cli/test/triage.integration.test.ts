import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import AdmZip from "adm-zip";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory, type IngestBatchSummary, type IngestFileResult } from "../src/ingest.js";

/**
 * BIGDATA-3 triage in directory mode (docs/PLAN-BIG-DATA.md section 2, answers 3-5; D98-D100).
 * Triage decides, for every object the walk finds and before anything is parsed, one of ingest,
 * skip-junk, skip-duplicate or skip-filter, and records it: one ingest_runs row per run, one
 * ingest_decisions row per object. Nothing is deleted, moved or overwritten, nothing is silently
 * dropped, and every skip also has a source.skip audit row naming its decision.
 *   - junk (answer 3): the listed names and 0-byte files only;
 *   - exact duplicates: size first, then SHA-256 (only files that share a size are hashed), the
 *     decision names the original; scope: the matter;
 *   - inside a zip, the same rules run when the entry is reached (stage 'ingest').
 */
const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `triage_${Date.now()}`);
const ENV_DIR = `${TEST_DIR}-env`;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// Every listed junk name (non-empty, so only the name rule can catch them) ...
const JUNK_NAMES = ["Thumbs.db", "sub/thumbs.DB", ".DS_Store", "sub/Desktop.ini", "~$Budget 2021.docx", "~WRL0001.tmp", "~WRD0042.tmp", "~DF1A2B.tmp", ".~lock.report.odt#"];
// ... and names that only look like them, which must be ingested.
const LOOKALIKES = ["Thumbs.db.txt", "notes.tmp", "desktop.ini.bak", "budget~$.txt", "report~WRL.txt"];
const X = "Fake original note: the fake barge left the fake quay at dawn.";
const Y = "Fake different note with exactly the same length as the other!"; // same length as X, other bytes

type Decision = {
  id: string; run_id: string; stage: string; path: string; byte_size: string; sha256: string | null; crc32c: string | null;
  decision: string; rule: string | null; rule_version: number | null; reason: string | null;
  duplicate_of_path: string | null; duplicate_of_decision_id: string | null; duplicate_of_source_id: string | null; supersedes: string | null;
};

describe("tools/ingest-cli — BIGDATA-3 triage (directory mode)", () => {
  let tenantId: string;
  let investigationId: string;
  let run1: IngestBatchSummary;
  let run2: IngestBatchSummary;
  let decisions1Before: Decision[] = [];
  const flat: IngestFileResult[] = [];
  const rel = (p: string) => relative(TEST_DIR, p.split("#")[0]!).replace(/\\/g, "/") + (p.includes("#") ? `#${p.split("#").slice(1).join("#")}` : "");
  const byRel = (r: string) => flat.find((x) => rel(x.filePath) === r);

  const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };
  const decisionsOf = (runId: string) => q((tx) => tx<Decision[]>`SELECT * FROM ingest_decisions WHERE run_id = ${runId} ORDER BY seq`);
  const decisionFor = (ds: Decision[], r: string) => ds.find((d) => rel(d.path) === r);

  beforeAll(async () => {
    mkdirSync(join(TEST_DIR, "sub"), { recursive: true });
    mkdirSync(ENV_DIR, { recursive: true });
    for (const n of JUNK_NAMES) writeFileSync(join(TEST_DIR, n), `fake junk bytes for ${n}`);
    for (const n of LOOKALIKES) writeFileSync(join(TEST_DIR, n), `fake lookalike content for ${n}, not junk`);
    writeFileSync(join(TEST_DIR, "empty.txt"), "");
    writeFileSync(join(TEST_DIR, "sub", "empty too.txt"), "");
    writeFileSync(join(TEST_DIR, "a-original.txt"), X);
    writeFileSync(join(TEST_DIR, "b-copy.txt"), X);
    writeFileSync(join(TEST_DIR, "c-same-size.txt"), Y);
    writeFileSync(join(TEST_DIR, "d-unique-size.txt"), "Fake note of a length no other file here has, surely.");
    const zip = new AdmZip();
    zip.addFile("inner/.DS_Store", Buffer.from("fake finder junk inside a zip"));
    zip.addFile("inner/copy-of-original.txt", Buffer.from(X));
    zip.addFile("inner/fresh.txt", Buffer.from("Fake fresh note found only inside the zip."));
    zip.writeZip(join(TEST_DIR, "e-bundle.zip"));
    expect(Buffer.byteLength(X)).toBe(Buffer.byteLength(Y));

    const boot = await bootstrap({
      name: `BIGDATA-3 triage WS ${Date.now()}`,
      investigationName: "BIGDATA-3 triage",
      email: `bigdata3-triage-${Date.now()}@casefile.test`,
      matter: `bigdata3-triage-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    tenantId = boot.tenantId;
    investigationId = boot.investigationId;

    run1 = await ingestDirectory({ dir: TEST_DIR, investigationId, tenantId, dbUrl: getDbUrl() });
    const walk = (r: IngestFileResult) => { flat.push(r); r.childResults?.forEach(walk); };
    run1.results.forEach(walk);
    // Guarded only so that, before BIGDATA-3 existed (no runId), each test failed on its own assertion.
    decisions1Before = run1.runId ? await decisionsOf(run1.runId) : [];
    run2 = await ingestDirectory({ dir: TEST_DIR, investigationId, tenantId, dbUrl: getDbUrl() });
  }, 180_000);

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(ENV_DIR, { recursive: true, force: true });
  });

  it("records one run (source, the owner's filters: none by default, the rule versions) and a decision for every object, before any parsing", async () => {
    const runs = await q((tx) => tx<{ id: string; kind: string; source_kind: string; source: string; filters: unknown; filters_type: string; rule_versions: Record<string, number>; triaged_at: Date | null; finished_at: Date | null }[]>`
      SELECT *, jsonb_typeof(filters) AS filters_type FROM ingest_runs WHERE id = ${run1.runId}`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "ingest", source_kind: "folder", source: TEST_DIR, filters: {}, filters_type: "object" });
    expect(runs[0]!.rule_versions).toMatchObject({ "junk-name": 1, "junk-empty": 1, "exact-duplicate": 1, "near-duplicate": 1 });
    expect(runs[0]!.triaged_at).not.toBeNull();
    expect(runs[0]!.finished_at).not.toBeNull();

    const triage = decisions1Before.filter((d) => d.stage === "triage");
    expect(triage.map((d) => rel(d.path)).sort()).toEqual(run1.results.map((r) => rel(r.filePath)).sort());
    expect(triage).toHaveLength(run1.totalFiles);

    // Before any parsing: the run's ingest.triaged audit row comes before every source.admit row.
    const audit = await q((tx) => tx<{ action: string; seq: string }[]>`
      SELECT action, seq FROM audit_events WHERE investigation_id = ${investigationId} AND action IN ('ingest.triaged', 'source.admit') ORDER BY seq`);
    expect(audit[0]!.action).toBe("ingest.triaged");
    expect(audit.filter((a) => a.action === "source.admit").length).toBeGreaterThan(5);
  });

  it("every listed junk name and every empty file is a skip-junk decision and never a source; lookalike names are ingested", async () => {
    for (const n of JUNK_NAMES) {
      expect(byRel(n), n).toMatchObject({ status: "skipped" });
      expect(decisionFor(decisions1Before, n), n).toMatchObject({ decision: "skip-junk", rule: "junk-name", rule_version: 1 });
    }
    for (const n of ["empty.txt", "sub/empty too.txt"]) {
      expect(byRel(n), n).toMatchObject({ status: "skipped", reason: "empty file (0 bytes)" });
      expect(decisionFor(decisions1Before, n), n).toMatchObject({ decision: "skip-junk", rule: "junk-empty", rule_version: 1, byte_size: "0" });
    }
    for (const n of LOOKALIKES) {
      expect(byRel(n)!.status, n).not.toBe("skipped");
      expect(decisionFor(decisions1Before, n), n).toMatchObject({ decision: "ingest", rule: null });
    }
    const names = (await q((tx) => tx<{ filename: string }[]>`SELECT filename FROM sources WHERE investigation_id = ${investigationId}`)).map((s) => s.filename);
    for (const n of [...JUNK_NAMES, "empty.txt", "empty too.txt"]) expect(names, n).not.toContain(n.split("/").pop());
  });

  it("an exact duplicate is found by size, then SHA-256, and names its original; a file of a size no other file has is not hashed by triage", () => {
    const a = decisionFor(decisions1Before, "a-original.txt")!;
    const b = decisionFor(decisions1Before, "b-copy.txt")!;
    const c = decisionFor(decisions1Before, "c-same-size.txt")!;
    const d = decisionFor(decisions1Before, "d-unique-size.txt")!;
    expect(a).toMatchObject({ decision: "ingest", sha256: sha(X) });
    expect(b).toMatchObject({ decision: "skip-duplicate", rule: "exact-duplicate", rule_version: 1, sha256: sha(X), duplicate_of_decision_id: a.id });
    expect(rel(b.duplicate_of_path!)).toBe("a-original.txt");
    expect(byRel("b-copy.txt")).toMatchObject({ status: "skipped" });
    expect(byRel("b-copy.txt")!.reason).toContain("a-original.txt");
    expect(c).toMatchObject({ decision: "ingest", sha256: sha(Y) });
    expect(d).toMatchObject({ decision: "ingest", sha256: null });
    expect(byRel("a-original.txt")!.status).toBe("indexed");
    expect(byRel("c-same-size.txt")!.status).toBe("indexed");
  });

  it("inside a zip, a junk entry and an entry that duplicates an ingested file are decisions of the ingest stage", () => {
    const junk = decisionFor(decisions1Before, "e-bundle.zip#inner/.DS_Store");
    const dup = decisionFor(decisions1Before, "e-bundle.zip#inner/copy-of-original.txt");
    expect(junk).toMatchObject({ stage: "ingest", decision: "skip-junk", rule: "junk-name" });
    expect(dup).toMatchObject({ stage: "ingest", decision: "skip-duplicate", rule: "exact-duplicate", sha256: sha(X), duplicate_of_source_id: byRel("a-original.txt")!.sourceId });
    expect(byRel("e-bundle.zip#inner/.DS_Store")).toMatchObject({ status: "skipped" });
    expect(byRel("e-bundle.zip#inner/fresh.txt")).toMatchObject({ status: "indexed" });
    expect(decisionFor(decisions1Before, "e-bundle.zip#inner/fresh.txt")).toBeUndefined();
  });

  it("every skip decision has a source.skip audit row naming the decision", async () => {
    const skips = decisions1Before.filter((d) => d.decision !== "ingest");
    expect(skips.length).toBe(JUNK_NAMES.length + 2 + 1 + 2);
    const rows = await q((tx) => tx<{ object_type: string; object_id: string; after: unknown }[]>`
      SELECT object_type, object_id, after FROM audit_events WHERE investigation_id = ${investigationId} AND action = 'source.skip'`);
    const named = rows.map((r) => ({ type: r.object_type, id: r.object_id, after: (typeof r.after === "string" ? JSON.parse(r.after) : r.after) as { decision: string; rule: string } }));
    for (const s of skips) {
      expect(named, rel(s.path)).toContainEqual({ type: "ingest_decision", id: s.id, after: expect.objectContaining({ decision: s.decision, rule: s.rule }) });
    }
  });

  it("a second run over the same folder: every file already ingested is a skip-duplicate of its source, junk stays junk, the first run's decisions are unchanged", async () => {
    const ds = await decisionsOf(run2.runId);
    expect(run2.runId).not.toBe(run1.runId);
    expect(run2.admitted).toBe(0);
    const aSource = byRel("a-original.txt")!.sourceId;
    expect(decisionFor(ds, "a-original.txt")).toMatchObject({ decision: "skip-duplicate", duplicate_of_source_id: aSource, sha256: sha(X) });
    expect(decisionFor(ds, "b-copy.txt")).toMatchObject({ decision: "skip-duplicate", duplicate_of_source_id: aSource });
    expect(decisionFor(ds, "Thumbs.db")).toMatchObject({ decision: "skip-junk", rule: "junk-name" });
    expect(ds.filter((d) => d.stage === "triage" && d.decision === "ingest")).toEqual([]);
    expect(await decisionsOf(run1.runId)).toEqual(decisions1Before);
  });

  it("ingest:include re-reads an item out of its zip: the junk entry becomes a source; the skip decision is superseded, not changed", async () => {
    const { includeSkipped } = await import("../src/include.js");
    const junk = decisionFor(decisions1Before, "e-bundle.zip#inner/.DS_Store")!;
    const out = await includeSkipped({ runId: run1.runId, path: junk.path, tenantId, dbUrl: getDbUrl() });
    expect(out.results).toEqual([expect.objectContaining({ status: "stored_unparsed", previousDecision: "skip-junk", previousRule: "junk-name" })]);
    const src = await q((tx) => tx<{ filename: string; status: string; byte_size: string }[]>`SELECT filename, status, byte_size FROM sources WHERE id = ${out.results[0]!.sourceId!}`);
    expect(src).toEqual([{ filename: ".DS_Store", status: "stored_unparsed", byte_size: String(Buffer.byteLength("fake finder junk inside a zip")) }]);
    const sup = await q((tx) => tx<{ stage: string; supersedes: string }[]>`SELECT stage, supersedes FROM ingest_decisions WHERE supersedes = ${junk.id}`);
    expect(sup).toEqual([{ stage: "include", supersedes: junk.id }]);
  });

  it("the decisions are append-only for the application role: no UPDATE, no DELETE", async () => {
    const id = decisions1Before[0]!.id;
    await expect(q((tx) => tx`UPDATE ingest_decisions SET reason = 'changed' WHERE id = ${id}`)).rejects.toThrow(/permission denied/);
    await expect(q((tx) => tx`DELETE FROM ingest_decisions WHERE id = ${id}`)).rejects.toThrow(/permission denied/);
    expect(await decisionsOf(run1.runId)).toEqual(decisions1Before);
  });
});
