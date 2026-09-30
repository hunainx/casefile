import { readFile } from "node:fs/promises";
import {
  type ObjectStore,
  type TenantScopedKey,
  type ObjectRef,
  type ObjectMeta,
  type PutOptions,
  computeSha256,
  ObjectAlreadyStoredDifferentlyError,
} from "./types.js";

interface StoredEntry {
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  updatedAt: Date;
  metadata?: Record<string, string> | undefined;
}

/**
 * InMemoryObjectStore — Test double for object storage (D43, packages/storage/README.md).
 * Used in all automated testing. No test connects to a live bucket.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly store = new Map<string, StoredEntry>();

  private resolveKey(refOrKey: ObjectRef | TenantScopedKey): string {
    return typeof refOrKey === "string" ? refOrKey : refOrKey.key;
  }

  async put(
    key: TenantScopedKey,
    bytes: Uint8Array,
    opts: PutOptions = {},
  ): Promise<ObjectRef> {
    const sha256 = computeSha256(bytes);
    const contentType = opts.contentType ?? "application/octet-stream";
    // Create-only, as GcsObjectStore (BIGDATA-4): the same bytes again are "already stored"; other bytes are refused.
    const existing = this.store.get(key);
    if (existing) {
      if (existing.sha256 !== sha256) throw new ObjectAlreadyStoredDifferentlyError(key, existing.sha256, sha256);
      return { key, sizeBytes: existing.sizeBytes, sha256: existing.sha256, contentType: existing.contentType, alreadyStored: true };
    }
    const entry: StoredEntry = {
      bytes: new Uint8Array(bytes),
      sizeBytes: bytes.byteLength,
      sha256,
      contentType,
      updatedAt: new Date(),
      metadata: opts.metadata ? { ...opts.metadata } : undefined,
    };

    this.store.set(key, entry);

    return {
      key,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      contentType: entry.contentType,
    };
  }

  /** The test double reads the file into memory; only GcsObjectStore streams it. */
  async putFile(key: TenantScopedKey, filePath: string, opts: PutOptions & { sha256: string }): Promise<ObjectRef> {
    return this.put(key, await readFile(filePath), opts);
  }

  async get(ref: ObjectRef | TenantScopedKey): Promise<Uint8Array> {
    const key = this.resolveKey(ref);
    const entry = this.store.get(key);
    if (!entry) {
      throw new Error(`Object not found: ${key}`);
    }
    return new Uint8Array(entry.bytes);
  }

  async head(ref: ObjectRef | TenantScopedKey): Promise<ObjectMeta> {
    const key = this.resolveKey(ref);
    const entry = this.store.get(key);
    if (!entry) {
      throw new Error(`Object not found: ${key}`);
    }
    return {
      key: key as TenantScopedKey,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      contentType: entry.contentType,
      updatedAt: entry.updatedAt,
      metadata: entry.metadata,
    };
  }

  async signedUrl(
    ref: ObjectRef | TenantScopedKey,
    ttlSeconds: number,
  ): Promise<string> {
    const key = this.resolveKey(ref);
    const entry = this.store.get(key);
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sha = entry ? entry.sha256.slice(0, 16) : "mock_sha256";
    return `mock-storage://${key}?expires=${expires}&signature=mock_sig_${sha}`;
  }
}
