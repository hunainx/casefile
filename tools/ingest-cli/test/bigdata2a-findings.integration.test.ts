import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import AdmZip from "adm-zip";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { getObjectStore, createSourceStorageKey } from "@casefile/storage";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory, type IngestBatchSummary, type IngestFileResult } from "../src/ingest.js";

/**
 * BIGDATA-2A findings from the BIGDATA-1 baseline (docs/PLAN-BIG-DATA.md §0), each shown red
 * against the BIGDATA-1 code first:
 *   F1 (D90) nothing the walk finds is silently dropped: dotfiles, hidden and node_modules folders
 *      are ingested; a symbolic link, a pipeline sidecar, a duplicate or a failed file is listed
 *      with its reason in the ingest output AND in the database (a source.skip or
 *      source.ingest_failed audit row; no migration);
 *   F2 (D91) an empty file is admitted and listed, but gets no text rows: stored_unparsed, reason
 *      "empty file"; BIGDATA-3 (D99) replaced this: an empty file is now a skip-junk decision,
 *      still listed, and .DS_Store (a listed junk name) likewise;
 *   F6 (D92, the ingest CLI's half) no content block claims an OCR confidence (was 1.0);
 *   F5 (D93) a file above the parse size limit is hashed and stored by streaming and listed as
 *      too large to parse in this version, never dropped.
 */
const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `bigdata2a_${Date.now()}`);
const ENV_DIR = `${TEST_DIR}-env`;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("tools/ingest-cli — BIGDATA-2A findings F1, F2, F5, F6", () => {
  let tenantId: string;
  let investigationId: string;
  let summary: IngestBatchSummary;
  const flat: IngestFileResult[] = [];
  const rel = (p: string) => relative(TEST_DIR, p.split("#")[0]!).replace(/\\/g, "/") + (p.includes("#") ? `#${p.split("#").slice(1).join("#")}` : "");
  const byRel = (r: string) => flat.find((x) => rel(x.filePath) === r);
  let junction = false;
  const LIMIT = 250_000; // above every fixture here (the largest, text-transcript.pdf, is 204,784 bytes)
  const big = Buffer.alloc(LIMIT + 1, "B");
  const atLimit = Buffer.alloc(LIMIT, "L");

  const db = () => createDbClient(getDbUrl(), { max: 1 });
  const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = db();
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    mkdirSync(ENV_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, ".hidden"), { recursive: true });
    mkdirSync(join(TEST_DIR, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(TEST_DIR, "results", "native"), { recursive: true });
    writeFileSync(join(TEST_DIR, "normal.txt"), "Fake normal note about a fake shipment.");
    writeFileSync(join(TEST_DIR, "copy of normal.txt"), "Fake normal note about a fake shipment.");
    writeFileSync(join(TEST_DIR, ".DS_Store"), Buffer.from("\0\0\0\u0001Bud1 fake finder metadata"));
    writeFileSync(join(TEST_DIR, ".hidden", "inside.txt"), "Fake text in a hidden folder.");
    writeFileSync(join(TEST_DIR, "node_modules", "pkg", "readme.txt"), "Fake readme in a node_modules folder.");
    writeFileSync(join(TEST_DIR, "results", "native", "sidecar.json"), '{"fake":"pipeline sidecar"}');
    writeFileSync(join(TEST_DIR, "empty.txt"), "");
    copyFileSync(join(process.cwd(), "test-corpus", "text-transcript.pdf"), join(TEST_DIR, "transcript.pdf"));
    copyFileSync(join(process.cwd(), "test-corpus", "summary.docx"), join(TEST_DIR, "summary.docx"));
    writeFileSync(join(TEST_DIR, "big.txt"), big);
    writeFileSync(join(TEST_DIR, "at-limit.txt"), atLimit);
    const zip = new AdmZip();
    for (const n of ["a.txt", "b.txt", "c.txt"]) zip.addFile(n, Buffer.from(`fake entry ${n}`));
    zip.writeZip(join(TEST_DIR, "three-entries.zip"));
    try {
      // A directory junction needs no special rights on Windows; elsewhere it is a symlink.
      symlinkSync(join(TEST_DIR, ".hidden"), join(TEST_DIR, "linked-folder"), "junction");
      junction = true;
    } catch {
      junction = false;
    }

    const boot = await bootstrap({
      name: `BIGDATA-2A findings WS ${Date.now()}`,
      investigationName: "BIGDATA-2A findings",
      email: `bigdata2a-${Date.now()}@casefile.test`,
      matter: `bigdata2a-${Date.now()}`,
      envDir: ENV_DIR, // outside the ingested folder: the walk now ingests .env files like any other file
      dbUrl: getDbUrl(),
    });
    tenantId = boot.tenantId;
    investigationId = boot.investigationId;

    summary = await ingestDirectory({
      dir: TEST_DIR,
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
      zipOptions: { maxFileCount: 2 },
      maxParseBytes: LIMIT,
    });
    const walk = (r: IngestFileResult) => { flat.push(r); r.childResults?.forEach(walk); };
    summary.results.forEach(walk);
  }, 120_000);

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(ENV_DIR, { recursive: true, force: true });
  });

  it("F1: dotfiles and files in hidden and node_modules folders are ingested, not dropped", () => {
    for (const r of [".DS_Store", ".hidden/inside.txt", "node_modules/pkg/readme.txt"]) {
      expect(byRel(r), `${r} is missing from the ingest results`).toBeDefined();
    }
    // BIGDATA-3 (D99): .DS_Store is a listed junk name, so it is now listed as skipped (skip-junk), not stored.
    expect(byRel(".DS_Store")).toMatchObject({ status: "skipped", reason: "junk file name (.DS_Store)" });
    expect(byRel(".hidden/inside.txt")!.status).toBe("indexed");
    expect(byRel("node_modules/pkg/readme.txt")!.status).toBe("indexed");
  });

  it("F1: every file the walk finds has a result; every skip and failure has a reason", () => {
    const top = summary.results.map((r) => rel(r.filePath)).sort();
    const expected = [
      ".DS_Store", ".hidden/inside.txt", "at-limit.txt", "big.txt", "copy of normal.txt", "empty.txt",
      "node_modules/pkg/readme.txt", "normal.txt", "results/native/sidecar.json", "summary.docx", "three-entries.zip", "transcript.pdf",
      ...(junction ? ["linked-folder"] : []),
    ].sort();
    expect(top).toEqual(expected);
    expect(summary.totalFiles).toBe(expected.length);
    for (const r of flat.filter((x) => x.status === "skipped" || x.status === "failed")) {
      expect(r.reason, `${rel(r.filePath)} has no reason`).toBeTruthy();
    }
    if (junction) {
      expect(byRel("linked-folder")).toMatchObject({ status: "skipped", reason: "symbolic link or junction: not followed" });
    }
  });

  it("F1: every skipped or failed file is also in the database, with its path and reason", async () => {
    const rows = await q((tx) => tx<{ action: string; outcome: string; object_type: string; after: unknown }[]>`
      SELECT action, outcome, object_type, after FROM audit_events
      WHERE investigation_id = ${investigationId} AND action IN ('source.skip', 'source.ingest_failed') ORDER BY seq`);
    const recorded = rows.map((r) => {
      const after = (typeof r.after === "string" ? JSON.parse(r.after) : r.after) as { path: string; reason: string };
      return { action: r.action, outcome: r.outcome, path: rel(after.path), reason: after.reason };
    });
    const expectedSkips = flat.filter((x) => x.status === "skipped" || x.status === "failed");
    expect(expectedSkips.length).toBeGreaterThanOrEqual(junction ? 4 : 3);
    for (const r of expectedSkips) {
      expect(recorded, `${rel(r.filePath)} (${r.status}: ${r.reason}) has no audit row`).toContainEqual({
        action: r.status === "failed" ? "source.ingest_failed" : "source.skip",
        outcome: r.status === "failed" ? "failure" : "success",
        path: rel(r.filePath),
        reason: r.reason,
      });
    }
    // The walk is in path order, so "copy of normal.txt" is the first copy and "normal.txt" the duplicate.
    expect(byRel("copy of normal.txt")).toMatchObject({ status: "indexed" });
    expect(byRel("normal.txt")).toMatchObject({ status: "skipped", reason: `exact duplicate of ${join(TEST_DIR, "copy of normal.txt")}` });
    expect(byRel("results/native/sidecar.json")).toMatchObject({ status: "skipped", reason: "pipeline sidecar excluded (results/)" });
    expect(byRel("three-entries.zip")!.status).toBe("failed");
  });

  it("F2 (D91, replaced by D99 in BIGDATA-3): an empty file is listed as a skip-junk decision, with no source and no text rows", async () => {
    expect(byRel("empty.txt")).toMatchObject({ status: "skipped", reason: "empty file (0 bytes)", byteSize: 0 });
    expect(byRel("empty.txt")!.sourceId).toBeUndefined();
    const r = await q(async (tx) => ({
      sources: await tx`SELECT id FROM sources WHERE investigation_id = ${investigationId} AND filename = 'empty.txt'`,
      decisions: await tx<{ decision: string; rule: string; byte_size: string }[]>`
        SELECT decision, rule, byte_size FROM ingest_decisions WHERE run_id = ${summary.runId} AND path = ${join(TEST_DIR, "empty.txt")}`,
    }));
    expect(r.sources).toEqual([]);
    expect(r.decisions).toEqual([{ decision: "skip-junk", rule: "junk-empty", byte_size: "0" }]);
  });

  it("F6: no content block written by the ingest claims an OCR confidence", async () => {
    expect(byRel("transcript.pdf")!.status).toBe("indexed");
    expect(byRel("summary.docx")!.status).toBe("indexed");
    const parsed = await q((tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM content_blocks b JOIN content_documents cd ON cd.id = b.content_document_id
      JOIN artifacts a ON a.id = cd.artifact_id WHERE a.source_id = ANY(${[byRel("transcript.pdf")!.sourceId!, byRel("summary.docx")!.sourceId!]})`);
    expect(parsed[0]!.n, "the PDF and Word file must have blocks, or this test proves nothing").toBeGreaterThan(1);
    const rows = await q((tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM content_blocks b JOIN content_documents cd ON cd.id = b.content_document_id
      JOIN artifacts a ON a.id = cd.artifact_id JOIN sources s ON s.id = a.source_id
      WHERE s.investigation_id = ${investigationId} AND b.ocr_confidence IS NOT NULL`);
    expect(rows[0]!.n).toBe(0);
  });

  it("F5: a file above the parse size limit is hashed, stored whole and listed as too large to parse", async () => {
    expect(byRel("big.txt")).toMatchObject({
      status: "stored_unparsed",
      sha256: sha(big),
      byteSize: LIMIT + 1,
      reason: "too large to parse in this version (250,001 bytes; the limit is 250,000 bytes)",
    });
    expect(byRel("at-limit.txt")!.status).toBe("indexed");
    const id = byRel("big.txt")!.sourceId!;
    const r = await q(async (tx) => ({
      source: await tx<{ status: string; sha256: string; storage_uri: string }[]>`SELECT status, sha256, storage_uri FROM sources WHERE id = ${id}`,
      artifacts: await tx`SELECT id FROM artifacts WHERE source_id = ${id}`,
    }));
    expect(r.source[0]).toMatchObject({ status: "stored_unparsed", sha256: sha(big) });
    expect(r.artifacts).toEqual([]);
    const stored = await getObjectStore().get(createSourceStorageKey(tenantId, investigationId, sha(big)));
    expect(Buffer.from(stored).equals(big)).toBe(true);
  });
});
