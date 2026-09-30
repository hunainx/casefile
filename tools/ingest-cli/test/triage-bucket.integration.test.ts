import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { ensureEmulatorBucket, getGcsStorageClient } from "@casefile/storage";
import { matterConfig } from "../../../matter.config.js";
import { bootstrap } from "../src/bootstrap.js";
import { ingestBucket, type IngestBatchSummary } from "../src/ingest.js";

/**
 * BIGDATA-3 triage in bucket mode (D100), on the local fake-gcs emulator's sandbox bucket only.
 * Exact duplicates: objects are compared by the size and CRC32C the bucket listing already gives;
 * only objects that share both are downloaded, to confirm with SHA-256. A second run over the
 * same objects (same path, same generation) needs no download to know they are ingested.
 * The file date of an object is its goog-reserved-file-mtime metadata; without it, it is unknown
 * and the object is kept.
 */
// The integration config's sandbox bucket on the local emulator (vitest.integration.config.ts).
const BUCKET = process.env.GCS_BUCKET_SOURCES ?? "";
const PREFIX = `triage-bucket-${Date.now()}/`;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const X = "Fake bucket original: the fake crate is in the fake shed.";
const Y = "Fake bucket stranger: same length as the original, not it"; // same length as X
const OBJECTS: Record<string, { body: string; mtime?: string }> = {
  "a-original.txt": { body: X },
  "b-copy.txt": { body: X },
  "c-same-size.txt": { body: Y },
  "d-unique.txt": { body: "Fake bucket note whose size no other object here has at all." },
  "Thumbs.db": { body: "fake thumbnail cache bytes" },
  "empty.txt": { body: "" },
  "old.txt": { body: "Fake bucket file with a 2018 file date recorded by the uploader.", mtime: String(Date.parse("2018-06-01T00:00:00Z") / 1000) },
};

type Decision = { path: string; decision: string; rule: string | null; sha256: string | null; crc32c: string | null; generation: string | null; reason: string | null; duplicate_of_path: string | null; duplicate_of_source_id: string | null };

describe("tools/ingest-cli — BIGDATA-3 triage (bucket mode)", () => {
  let tenantId: string;
  let investigationId: string;
  let run1: IngestBatchSummary;
  let run2: IngestBatchSummary;
  let filtered: IngestBatchSummary;
  const ENV_DIR = `${process.cwd()}/.tmp-test-fixtures/triage_bucket_env_${Date.now()}`;
  const uri = (n: string) => `gcs://${BUCKET}/${PREFIX}${n}`;

  const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };
  const decisionsOf = (runId: string) => q((tx) => tx<Decision[]>`SELECT * FROM ingest_decisions WHERE run_id = ${runId} ORDER BY seq`);

  beforeAll(async () => {
    mkdirSync(ENV_DIR, { recursive: true });
    expect(BUCKET).toMatch(/^casefile-localtest-/);
    await ensureEmulatorBucket(BUCKET);
    const bucket = (await getGcsStorageClient()).bucket(BUCKET);
    for (const [name, o] of Object.entries(OBJECTS)) {
      await bucket.file(`${PREFIX}${name}`).save(Buffer.from(o.body), { resumable: false, ...(o.mtime ? { metadata: { metadata: { "goog-reserved-file-mtime": o.mtime } } } : {}) });
    }
    expect(Buffer.byteLength(X)).toBe(Buffer.byteLength(Y));
    // The test binds the sandbox bucket to the matter deliberately, as an operator would in matter.config.ts.
    matterConfig.ingestBuckets.push(BUCKET);

    const boot = await bootstrap({
      name: `BIGDATA-3 bucket WS ${Date.now()}`,
      investigationName: "BIGDATA-3 bucket",
      email: `bigdata3-bucket-${Date.now()}@casefile.test`,
      matter: `bigdata3-bucket-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    tenantId = boot.tenantId;
    investigationId = boot.investigationId;
    run1 = await ingestBucket({ bucket: BUCKET, prefix: PREFIX, investigationId, tenantId, dbUrl: getDbUrl() });
    run2 = await ingestBucket({ bucket: BUCKET, prefix: PREFIX, investigationId, tenantId, dbUrl: getDbUrl() });
    const inv2 = crypto.randomUUID();
    const ws = await q((tx) => tx<{ workspace_id: string }[]>`SELECT workspace_id FROM investigations WHERE id = ${investigationId}`);
    await q((tx) => tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, stage) VALUES (${inv2}, ${tenantId}, ${ws[0]!.workspace_id}, 'BIGDATA-3 bucket file-date', 'collecting')`);
    filtered = await ingestBucket({ bucket: BUCKET, prefix: PREFIX, investigationId: inv2, tenantId, dbUrl: getDbUrl(), filters: { fileDateFrom: "2020-01-01" } });
  }, 180_000);

  afterAll(() => {
    rmSync(ENV_DIR, { recursive: true, force: true });
    matterConfig.ingestBuckets.splice(matterConfig.ingestBuckets.indexOf(BUCKET), 1);
  });

  it("size + CRC32C first: only the two objects that share both are downloaded and hashed; the copy names its original", async () => {
    const ds = await decisionsOf(run1.runId);
    const by = (n: string) => ds.find((x) => x.path === uri(n))!;
    expect(run1.triage.objectsHashed).toBe(2);
    for (const n of Object.keys(OBJECTS)) expect(by(n).crc32c, n).toMatch(/^[A-Za-z0-9+/]{6}==$/);
    expect(by("a-original.txt")).toMatchObject({ decision: "ingest", sha256: sha(X) });
    expect(by("b-copy.txt")).toMatchObject({ decision: "skip-duplicate", rule: "exact-duplicate", sha256: sha(X), duplicate_of_path: uri("a-original.txt") });
    expect(by("c-same-size.txt")).toMatchObject({ decision: "ingest", sha256: null });
    expect(by("c-same-size.txt").crc32c).not.toBe(by("a-original.txt").crc32c);
    expect(by("d-unique.txt")).toMatchObject({ decision: "ingest", sha256: null });
    expect(by("Thumbs.db")).toMatchObject({ decision: "skip-junk", rule: "junk-name" });
    expect(by("empty.txt")).toMatchObject({ decision: "skip-junk", rule: "junk-empty" });
    expect(run1.results.find((r) => r.filePath === uri("a-original.txt"))!.status).toBe("indexed");
  });

  it("a second run over the same objects (same path, same generation) downloads nothing to know they are already ingested", async () => {
    const ds = await decisionsOf(run2.runId);
    expect(run2.triage.objectsHashed).toBe(0);
    expect(run2.admitted).toBe(0);
    const a = ds.find((x) => x.path === uri("a-original.txt"))!;
    expect(a).toMatchObject({ decision: "skip-duplicate", rule: "exact-duplicate", sha256: sha(X) });
    expect(a.duplicate_of_source_id).toBe(run1.results.find((r) => r.filePath === uri("a-original.txt"))!.sourceId);
    expect(a.reason).toContain("same object");
  });

  it("file date in bucket mode: goog-reserved-file-mtime decides; an object without it is kept with the reason", async () => {
    const ds = await decisionsOf(filtered.runId);
    expect(ds.find((x) => x.path === uri("old.txt"))).toMatchObject({ decision: "skip-filter", rule: "file-date" });
    expect(ds.find((x) => x.path === uri("d-unique.txt"))).toMatchObject({ decision: "ingest", reason: "file date unknown: kept" });
  });
});
