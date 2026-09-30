import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GcsObjectStore, ensureEmulatorBucket, getGcsStorageClient, computeSha256, createTenantScopedKey, ObjectAlreadyStoredDifferentlyError } from "../src/index.js";

/**
 * BIGDATA-4 (plan section 16, idempotency): a source object is written once. The key is the
 * object's SHA-256, and the write is create-only (ifGenerationMatch: 0), so a second write of the
 * same key (an item done twice by two workers, or retried after a crash) creates no second object
 * generation: it is refused by the bucket and taken as "already stored" once the stored object's
 * SHA-256 is checked. Different bytes under an existing key are never written over.
 * Runs against the local fake-gcs emulator (it honours the precondition, like GCS).
 */
const bucket = process.env.GCS_BUCKET_SOURCES!;
const TMP = join(process.cwd(), ".tmp-test-fixtures", `create-only_${Date.now()}`);

async function generations(key: string): Promise<string[]> {
  const storage = await getGcsStorageClient();
  const [files] = await storage.bucket(bucket).getFiles({ prefix: key, versions: true });
  return files.filter((f) => f.name === key).map((f) => String(f.metadata.generation));
}

describe("packages/storage — create-only source objects", () => {
  beforeAll(async () => {
    expect(bucket).toMatch(/^casefile-localtest-/);
    await ensureEmulatorBucket(bucket);
    mkdirSync(TMP, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("put: the second write of the same key keeps the first object (one generation)", async () => {
    const store = new GcsObjectStore({ bucket });
    const bytes = Buffer.from(`fake evidence bytes ${Date.now()}`);
    const key = createTenantScopedKey("00000000-0000-4000-8000-00000000b4b4", `create-only/${computeSha256(bytes)}`);
    const first = await store.put(key, bytes, { contentType: "text/plain" });
    const gens = await generations(key);
    expect(gens).toHaveLength(1);
    const second = await store.put(key, bytes, { contentType: "text/plain" });
    expect(second).toEqual({ ...first, alreadyStored: true });
    expect(await generations(key)).toEqual(gens);
  });

  it("putFile: the second streamed write of the same key keeps the first object", async () => {
    const store = new GcsObjectStore({ bucket });
    const bytes = Buffer.from(`fake streamed evidence ${Date.now()}`);
    const path = join(TMP, "streamed.bin");
    writeFileSync(path, bytes);
    const sha256 = computeSha256(bytes);
    const key = createTenantScopedKey("00000000-0000-4000-8000-00000000b4b4", `create-only/${sha256}`);
    await store.putFile(key, path, { sha256, contentType: "application/octet-stream" });
    const gens = await generations(key);
    const again = await store.putFile(key, path, { sha256, contentType: "application/octet-stream" });
    expect(again.alreadyStored).toBe(true);
    expect(await generations(key)).toEqual(gens);
    rmSync(path);
  });

  it("different bytes under a key that exists are refused, never written over", async () => {
    const store = new GcsObjectStore({ bucket });
    const bytes = Buffer.from(`fake original ${Date.now()}`);
    const key = createTenantScopedKey("00000000-0000-4000-8000-00000000b4b4", `create-only/${computeSha256(bytes)}-collision`);
    await store.put(key, bytes, { contentType: "text/plain" });
    const gens = await generations(key);
    await expect(store.put(key, Buffer.from("fake other bytes"), { contentType: "text/plain" })).rejects.toBeInstanceOf(ObjectAlreadyStoredDifferentlyError);
    expect(await generations(key)).toEqual(gens);
  });
});
