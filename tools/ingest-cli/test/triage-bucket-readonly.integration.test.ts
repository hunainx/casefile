import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { Bucket, File } from "@google-cloud/storage";
import { getDbUrl } from "@casefile/db";
import { ensureEmulatorBucket, getGcsStorageClient } from "@casefile/storage";
import { matterConfig } from "../../../matter.config.js";
import { bootstrap } from "../src/bootstrap.js";

/**
 * BIGDATA-3: triage only RECORDS decisions. It never deletes, moves, copies or overwrites anything
 * in a bucket (plan section 8, D62), and neither do the report or a dry-run include. Every method of
 * the storage library that writes to a bucket is wrapped for the whole run and must never be called;
 * the bucket's listing (name, generation, metageneration, size, CRC32C, MD5) must be identical before
 * and after. guardrails/bucket-deletion.spec.ts checks the same code statically.
 */
// The integration config's sandbox bucket on the local emulator (vitest.integration.config.ts).
const BUCKET = process.env.GCS_BUCKET_SOURCES ?? "";
const PREFIX = `triage-readonly-${Date.now()}/`;
const ENV_DIR = `${process.cwd()}/.tmp-test-fixtures/triage_readonly_env_${Date.now()}`;
const FILE_WRITES = ["delete", "move", "copy", "rename", "save", "setMetadata", "createWriteStream", "createResumableUpload", "makePublic", "makePrivate", "setStorageClass", "restore"] as const;
const BUCKET_WRITES = ["deleteFiles", "upload", "combine", "setMetadata", "delete", "setStorageClass", "makePublic", "makePrivate"] as const;

describe("tools/ingest-cli — triage, report and include --dry-run never write to a bucket", () => {
  const calls: string[] = [];
  const restore: Array<() => void> = [];
  let before: string[] = [];
  let after: string[] = [];
  let triageRun = "";
  let dryRun: { selected: unknown[] } = { selected: [] };

  const listing = async () => {
    const [files] = await (await getGcsStorageClient()).bucket(BUCKET).getFiles({ prefix: PREFIX });
    return files.map((f) => JSON.stringify([f.name, f.metadata.generation, f.metadata.metageneration, f.metadata.size, f.metadata.crc32c, f.metadata.md5Hash])).sort();
  };

  beforeAll(async () => {
    mkdirSync(ENV_DIR, { recursive: true });
    expect(BUCKET).toMatch(/^casefile-localtest-/);
    await ensureEmulatorBucket(BUCKET);
    const bucket = (await getGcsStorageClient()).bucket(BUCKET);
    for (const [name, body] of Object.entries({ "one.txt": "Fake readonly one.", "one copy.txt": "Fake readonly one.", "Thumbs.db": "fake thumbs", "empty.txt": "" })) {
      await bucket.file(`${PREFIX}${name}`).save(Buffer.from(body), { resumable: false });
    }
    matterConfig.ingestBuckets.push(BUCKET);
    before = await listing();

    for (const [proto, names, label] of [[File.prototype, FILE_WRITES, "File"], [Bucket.prototype, BUCKET_WRITES, "Bucket"]] as const) {
      for (const m of names) {
        const orig: unknown = Reflect.get(proto, m);
        if (typeof orig !== "function") continue;
        Reflect.set(proto, m, function (this: { name?: string }, ...a: unknown[]) {
          calls.push(`${label}.${m}(${this.name ?? ""})`);
          return (orig as (...x: unknown[]) => unknown).apply(this, a);
        });
        restore.push(() => Reflect.set(proto, m, orig));
      }
    }

    const boot = await bootstrap({
      name: `BIGDATA-3 readonly WS ${Date.now()}`,
      investigationName: "BIGDATA-3 readonly",
      email: `bigdata3-readonly-${Date.now()}@casefile.test`,
      matter: `bigdata3-readonly-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    const { triageOnly } = await import("../src/triage.js");
    const { buildIngestReport } = await import("../src/report.js");
    const { includeSkipped } = await import("../src/include.js");
    const t = await triageOnly({ bucket: BUCKET, prefix: PREFIX, investigationId: boot.investigationId, tenantId: boot.tenantId, dbUrl: getDbUrl() });
    triageRun = t.runId;
    await buildIngestReport({ runId: triageRun, tenantId: boot.tenantId, dbUrl: getDbUrl() });
    dryRun = await includeSkipped({ runId: triageRun, rule: "junk-name", dryRun: true, tenantId: boot.tenantId, dbUrl: getDbUrl() });
    after = await listing();
  }, 120_000);

  afterAll(() => {
    for (const r of restore) r();
    rmSync(ENV_DIR, { recursive: true, force: true });
    matterConfig.ingestBuckets.splice(matterConfig.ingestBuckets.indexOf(BUCKET), 1);
  });

  it("the wrapped methods are the ones the storage package's client uses", async () => {
    const f = (await getGcsStorageClient()).bucket(BUCKET).file(`${PREFIX}one.txt`);
    expect(f).toBeInstanceOf(File);
    expect(restore.length).toBeGreaterThanOrEqual(12);
    expect(triageRun).toMatch(/^[0-9a-f-]{36}$/);
    expect(dryRun.selected).toHaveLength(1);
  });

  it("no delete, move, copy, rename, save, metadata change or upload was called on any bucket object", () => {
    expect(calls).toEqual([]);
  });

  it("the bucket listing is identical before and after: same objects, generations, metagenerations, sizes and checksums", () => {
    expect(before).toHaveLength(4);
    expect(after).toEqual(before);
  });
});
