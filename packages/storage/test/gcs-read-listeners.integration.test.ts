import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import {
  GcsObjectStore,
  createTenantScopedKey,
  downloadBucketObject,
  ensureEmulatorBucket,
  getGcsStorageClient,
  sha256OfBucketObject,
} from "../src/index.js";

/**
 * BIGDATA-2B, item C (D96): reading an object from the bucket raised
 * "MaxListenersExceededWarning: 11 error listeners added to [PassThrough]" on every download,
 * whatever its size: node-fetch, teeny-request and @google-cloud/storage each put their own
 * listeners on the one response body stream (4 + 4 + 3), one over Node's default of 10. It is
 * per request, not per chunk or per retry (captures/bigdata2b/maxlisteners-probe.txt). Every read
 * path of the storage package must now read without the warning.
 * Local fake-gcs emulator only.
 */
describe("packages/storage — bucket reads raise no MaxListenersExceededWarning (BIGDATA-2B)", () => {
  const bucket = process.env.GCS_BUCKET_SOURCES!;
  const key = createTenantScopedKey("00000000-0000-4000-8000-00000000b2b0", `listener-probe/${Date.now()}.bin`);
  const bytes = randomBytes(3 * 1024 * 1024);
  const warnings: string[] = [];
  const onWarning = (w: Error) => {
    if (w.name === "MaxListenersExceededWarning") warnings.push(w.message);
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));

  beforeAll(async () => {
    await ensureEmulatorBucket(bucket);
    const gcs = await getGcsStorageClient();
    await gcs.bucket(bucket).file(key).save(bytes, { resumable: false });
    process.on("warning", onWarning);
  });
  afterAll(() => {
    process.off("warning", onWarning);
  });

  it("GcsObjectStore.get", async () => {
    const got = await new GcsObjectStore({ bucket }).get(key);
    await settle();
    expect(Buffer.from(got).equals(bytes)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("downloadBucketObject (bucket-mode ingest)", async () => {
    const got = await downloadBucketObject(bucket, key);
    await settle();
    expect(got.equals(bytes)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("sha256OfBucketObject (bucket-mode ingest of a file too large to parse)", async () => {
    const sha = await sha256OfBucketObject(bucket, key);
    await settle();
    expect(sha).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(warnings).toEqual([]);
  });
});
