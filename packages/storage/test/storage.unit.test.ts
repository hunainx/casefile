import { describe, it, expect } from "vitest";
import {
  createTenantScopedKey,
  createSourceStorageKey,
  createArtifactStorageKey,
  createExportStorageKey,
  InMemoryObjectStore,
  GcsObjectStore,
  computeSha256,
  type ObjectStore,
} from "../src/index.js";

describe("packages/storage — Unit Tests (D43, packages/storage/README.md)", () => {
  const tenantA = "11111111-1111-1111-1111-111111111111";
  const tenantB = "22222222-2222-2222-2222-222222222222";
  const invId = "33333333-3333-3333-3333-333333333333";

  it("same bytes produce the exact same content-addressed key (AC-ING-02 dedup)", () => {
    const bytes1 = new TextEncoder().encode("Contract Agreement Version 1.0");
    const bytes2 = new TextEncoder().encode("Contract Agreement Version 1.0");
    const differentBytes = new TextEncoder().encode("Contract Agreement Version 2.0");

    const key1 = createSourceStorageKey(tenantA, invId, bytes1);
    const key2 = createSourceStorageKey(tenantA, invId, bytes2);
    const keyDiff = createSourceStorageKey(tenantA, invId, differentBytes);

    expect(key1).toBe(key2);
    expect(key1).not.toBe(keyDiff);

    const expectedSha = computeSha256(bytes1);
    expect(key1).toBe(`${tenantA}/${invId}/sources/${expectedSha}`);
  });

  it("keys are strictly prefixed by tenant ID and cannot be coerced across tenants", () => {
    const keyA = createTenantScopedKey(tenantA, "artifacts/report.pdf");
    const keyB = createTenantScopedKey(tenantB, "artifacts/report.pdf");

    expect(keyA.startsWith(`${tenantA}/`)).toBe(true);
    expect(keyB.startsWith(`${tenantB}/`)).toBe(true);
    expect(keyA).not.toBe(keyB);

    // Invalid tenant IDs or path traversal are rejected
    expect(() => createTenantScopedKey("", "path")).toThrow();
    expect(() => createTenantScopedKey("tenant/extra", "path")).toThrow();
    expect(() => createTenantScopedKey("../tenant", "path")).toThrow();
    expect(() => createTenantScopedKey(tenantA, "../traversal.txt")).toThrow();
    expect(() => createTenantScopedKey(tenantA, "path/../../traversal.txt")).toThrow();
  });

  it("generates correct storage keys for artifacts and exports", () => {
    const artKey = createArtifactStorageKey(tenantA, invId, "art_123", "extracted text.txt");
    expect(artKey).toBe(`${tenantA}/${invId}/artifacts/art_123/extracted_text.txt`);

    const expKey = createExportStorageKey(tenantA, invId, "exp_999");
    expect(expKey).toBe(`${tenantA}/${invId}/exports/exp_999.zip`);
  });

  it("interface and implementations contain NO permitted delete method (T7 WORM protection & D62)", async () => {
    const memStore = new InMemoryObjectStore();
    const gcsStore = new GcsObjectStore({ bucket: "casefile-test-bucket" });

    // Assert memStore has no delete method
    expect("delete" in memStore).toBe(false);
    expect(Object.getOwnPropertyNames(InMemoryObjectStore.prototype)).not.toContain("delete");

    // Assert gcsStore delete methods throw "deletion is not permitted" (D62)
    await expect(gcsStore.delete()).rejects.toThrow(/deletion is not permitted/);
    await expect(gcsStore.deleteFiles()).rejects.toThrow(/deletion is not permitted/);
  });

  it("InMemoryObjectStore stores, retrieves, and heads objects correctly", async () => {
    const store: ObjectStore = new InMemoryObjectStore();
    const payload = new TextEncoder().encode("Confidential Evidence Data");
    const key = createTenantScopedKey(tenantA, `${invId}/sources/data.bin`);

    // Put
    const ref = await store.put(key, payload, {
      contentType: "application/octet-stream",
      metadata: { sourceName: "evidence.bin" },
    });
    expect(ref.key).toBe(key);
    expect(ref.sizeBytes).toBe(payload.byteLength);
    expect(ref.sha256).toBe(computeSha256(payload));

    // Get
    const fetched = await store.get(ref);
    expect(new TextDecoder().decode(fetched)).toBe("Confidential Evidence Data");

    // Head
    const meta = await store.head(ref);
    expect(meta.sizeBytes).toBe(payload.byteLength);
    expect(meta.contentType).toBe("application/octet-stream");
    expect(meta.metadata?.sourceName).toBe("evidence.bin");

    // Signed URL
    const url = await store.signedUrl(ref, 3600);
    expect(url.startsWith("mock-storage://")).toBe(true);
    expect(url).toContain(key);
  });
});
