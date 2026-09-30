import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory, type IngestBatchSummary, type IngestFileResult } from "../src/ingest.js";

/**
 * BIGDATA-3 near-duplicates (answer 4; D101). After parsing: normalised text, MinHash of word
 * shingles, and a similarity of at least 0.9 to the first document of a group puts a document in
 * that group. Both are indexed (answer 4): the later one is only linked to the first, in
 * document_fingerprints. Emails are compared without their Date and Message-ID (a message sent
 * again is the same message). The first document of a group can come from an earlier run.
 */
const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `near_dup_${Date.now()}`);
const DIR2 = `${TEST_DIR}-run2`;
const ENV_DIR = `${TEST_DIR}-env`;

// Deterministic invented words and text.
let seed = 42;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const syll = ["ka", "lo", "mer", "tin", "vo", "sa", "rel", "du", "ne", "bri", "qua", "fen", "oth", "ul", "zar"];
const word = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => syll[Math.floor(rnd() * syll.length)]).join("");
const words = (n: number) => Array.from({ length: n }, word);
const BASE = words(400);
const change = (ws: string[], every: number) => ws.map((w, i) => (i % every === every - 1 ? `${w}x${i}` : w));
const text = (ws: string[]) => ws.reduce((acc, w, i) => acc + (i === 0 ? "" : i % 12 === 0 ? ".\n\n" : " ") + w, "") + ".";
const eml = (date: string, id: string, body: string) =>
  [`From: Pim Olvar <pim@near.example>`, `To: Rue Sandt <rue@near.example>`, `Date: ${date}`, `Subject: Fake quarterly barge figures`, `Message-ID: <${id}@near.example>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");

type Fp = { source_id: string; near_duplicate_of: string | null; similarity: string | null; method: string; rule_version: number; shingle_count: number; signature: Buffer };

describe("tools/ingest-cli — BIGDATA-3 near-duplicates", () => {
  let tenantId: string;
  let investigationId: string;
  let run1: IngestBatchSummary;
  let run2: IngestBatchSummary;
  const flat: IngestFileResult[] = [];
  const rel = (p: string) => relative(TEST_DIR, p).replace(/\\/g, "/");
  const src = (r: string) => flat.find((x) => rel(x.filePath) === r)!;

  const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };
  const fp = async (sourceId: string) => (await q((tx) => tx<Fp[]>`SELECT * FROM document_fingerprints WHERE source_id = ${sourceId}`))[0];

  beforeAll(async () => {
    mkdirSync(join(TEST_DIR, "mail"), { recursive: true });
    mkdirSync(DIR2, { recursive: true });
    mkdirSync(ENV_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "a-report.txt"), text(BASE));
    writeFileSync(join(TEST_DIR, "b-report-two-words-changed.txt"), text(BASE.map((w, i) => (i === 100 || i === 300 ? `${w}q` : w))));
    writeFileSync(join(TEST_DIR, "c-report-same-words-new-layout.txt"), BASE.join("\n").toUpperCase());
    writeFileSync(join(TEST_DIR, "d-report-rewritten.txt"), text(change(BASE, 4))); // one word in four changed
    writeFileSync(join(TEST_DIR, "e-unrelated.txt"), text(words(400)));
    const body = text(words(120));
    writeFileSync(join(TEST_DIR, "mail", "first.eml"), eml("Mon, 06 Mar 2023 09:00:00 +0000", "first-send", body));
    writeFileSync(join(TEST_DIR, "mail", "sent-again.eml"), eml("Thu, 09 Mar 2023 16:45:00 +0000", "second-send", body));
    writeFileSync(join(DIR2, "f-report-next-run.txt"), text(BASE.map((w, i) => (i === 200 ? `${w}z` : w))));

    const boot = await bootstrap({
      name: `BIGDATA-3 near-dup WS ${Date.now()}`,
      investigationName: "BIGDATA-3 near-dup",
      email: `bigdata3-neardup-${Date.now()}@casefile.test`,
      matter: `bigdata3-neardup-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    tenantId = boot.tenantId;
    investigationId = boot.investigationId;
    run1 = await ingestDirectory({ dir: TEST_DIR, investigationId, tenantId, dbUrl: getDbUrl() });
    run1.results.forEach((r) => flat.push(r));
    run2 = await ingestDirectory({ dir: DIR2, investigationId, tenantId, dbUrl: getDbUrl() });
  }, 180_000);

  afterAll(() => {
    for (const d of [TEST_DIR, DIR2, ENV_DIR]) rmSync(d, { recursive: true, force: true });
  });

  it("every indexed document gets a fingerprint: MinHash, 256 values of 32 bits", async () => {
    const rows = await q((tx) => tx<Fp[]>`SELECT * FROM document_fingerprints WHERE investigation_id = ${investigationId}`);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r).toMatchObject({ method: "minhash-w5-k256", rule_version: 1 });
      expect(r.signature.length).toBe(1024);
      expect(r.shingle_count).toBeGreaterThan(0);
    }
  });

  it("two words changed in 400, or the same words in a new layout and case: grouped under the first document, similarity >= 0.9", async () => {
    const a = src("a-report.txt").sourceId!;
    expect(await fp(a)).toMatchObject({ near_duplicate_of: null, similarity: null });
    for (const r of ["b-report-two-words-changed.txt", "c-report-same-words-new-layout.txt"]) {
      const f = (await fp(src(r).sourceId!))!;
      expect(f.near_duplicate_of, r).toBe(a);
      expect(Number(f.similarity), r).toBeGreaterThanOrEqual(0.9);
    }
    expect(Number((await fp(src("c-report-same-words-new-layout.txt").sourceId!))!.similarity)).toBe(1);
  });

  it("one word in four changed, or unrelated text: not grouped", async () => {
    for (const r of ["d-report-rewritten.txt", "e-unrelated.txt"]) {
      expect(await fp(src(r).sourceId!), r).toMatchObject({ near_duplicate_of: null, similarity: null });
    }
  });

  it("an email sent again (new Date and Message-ID, same text) is grouped under the first send", async () => {
    const f = (await fp(src("mail/sent-again.eml").sourceId!))!;
    expect(f.near_duplicate_of).toBe(src("mail/first.eml").sourceId);
    expect(Number(f.similarity)).toBe(1);
  });

  it("both documents of a group stay indexed, with their own blocks and chunks", async () => {
    for (const r of ["a-report.txt", "b-report-two-words-changed.txt", "c-report-same-words-new-layout.txt", "mail/first.eml", "mail/sent-again.eml"]) {
      expect(src(r).status, r).toBe("indexed");
      const n = await q((tx) => tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chunks c JOIN content_documents cd ON cd.id = c.content_document_id JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${src(r).sourceId!}`);
      expect(n[0]!.n, r).toBeGreaterThan(0);
    }
  });

  it("a near-copy ingested in a later run is grouped under the first document of the earlier run", async () => {
    const f = (await fp(run2.results[0]!.sourceId!))!;
    expect(run2.results[0]!.status).toBe("indexed");
    expect(f.near_duplicate_of).toBe(src("a-report.txt").sourceId);
    expect(run2.timings.nearDuplicateMs).toBeGreaterThan(0);
  });
});
