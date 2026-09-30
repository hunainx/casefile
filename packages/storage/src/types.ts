import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * TenantScopedKey is a BRANDED type that can only be constructed from a tenant id
 * plus a subpath. A plain string cannot be passed to `put` (D43, packages/storage/README.md).
 */
export type TenantScopedKey = string & { readonly __brand: unique symbol };

/**
 * Validates and creates a TenantScopedKey ensuring it is strictly prefixed by tenantId.
 */
export function createTenantScopedKey(tenantId: string, subpath: string): TenantScopedKey {
  if (!tenantId || typeof tenantId !== "string" || tenantId.includes("/") || tenantId.includes("..")) {
    throw new Error(`Invalid tenant ID: '${tenantId}'`);
  }
  if (!subpath || typeof subpath !== "string") {
    throw new Error("Storage subpath cannot be empty");
  }
  if (subpath.includes("..")) {
    throw new Error("Storage subpath cannot contain path traversal ('..')");
  }
  const cleanSubpath = subpath.replace(/^\/+/, "");
  if (!cleanSubpath) {
    throw new Error("Storage subpath cannot be empty");
  }
  return `${tenantId}/${cleanSubpath}` as TenantScopedKey;
}

/**
 * Computes SHA-256 hex digest of bytes.
 */
export function computeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * SHA-256 hex digest of a file, read as a stream: memory stays flat whatever the file's size
 * (BIGDATA-2A, D93). For files too large to hold in memory; computeSha256 is for bytes in hand.
 */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Layout: <tenant_id>/<investigation_id>/sources/<sha256> (AC-ING-02 content-addressed).
 */
export function createSourceStorageKey(
  tenantId: string,
  investigationId: string,
  bytesOrSha: Uint8Array | string,
): TenantScopedKey {
  const sha = typeof bytesOrSha === "string" ? bytesOrSha : computeSha256(bytesOrSha);
  return createTenantScopedKey(tenantId, `${investigationId}/sources/${sha}`);
}

/**
 * Layout: <tenant_id>/<investigation_id>/artifacts/<artifact_id>/<name>
 */
export function createArtifactStorageKey(
  tenantId: string,
  investigationId: string,
  artifactId: string,
  name: string,
): TenantScopedKey {
  const cleanName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return createTenantScopedKey(tenantId, `${investigationId}/artifacts/${artifactId}/${cleanName}`);
}

/**
 * Layout: <tenant_id>/<investigation_id>/exports/<export_id>.zip
 */
export function createExportStorageKey(
  tenantId: string,
  investigationId: string,
  exportId: string,
): TenantScopedKey {
  return createTenantScopedKey(tenantId, `${investigationId}/exports/${exportId}.zip`);
}

export interface PutOptions {
  contentType?: string | undefined;
  metadata?: Record<string, string> | undefined;
}

export interface ObjectRef {
  key: TenantScopedKey;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  /**
   * BIGDATA-4: set when the object was already stored under this key with the same SHA-256 and
   * nothing was written (writes are create-only; a second write of a key never makes a second object).
   */
  alreadyStored?: true;
}

/**
 * A write to a key that already holds an object with other bytes. Nothing was written: an object in
 * a matter's bucket is never overwritten (D62; BIGDATA-4 made every write create-only).
 */
export class ObjectAlreadyStoredDifferentlyError extends Error {
  constructor(readonly key: string, readonly storedSha256: string, readonly newSha256: string) {
    super(`object ${key} is already stored with SHA-256 ${storedSha256 || "(unknown)"}; refusing to write other bytes (SHA-256 ${newSha256}) over it`);
    this.name = "ObjectAlreadyStoredDifferentlyError";
  }
}

export interface ObjectMeta {
  key: TenantScopedKey;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  updatedAt: Date;
  metadata?: Record<string, string> | undefined;
}

/**
 * ObjectStore Interface (PRD §40.6, D43, packages/storage/README.md)
 * NOTE: There is NO delete() method. Sources are withdrawn, never deleted (T7).
 */
export interface ObjectStore {
  put(key: TenantScopedKey, bytes: Uint8Array, opts?: PutOptions): Promise<ObjectRef>;
  /**
   * Stores a file from disk as a stream, never holding it whole (D93). `sha256` is the file's
   * digest, already computed by the caller with sha256OfFile (the ingest needs it before it
   * decides to store), and is recorded in the object's metadata as put() records it.
   */
  putFile(key: TenantScopedKey, filePath: string, opts: PutOptions & { sha256: string }): Promise<ObjectRef>;
  get(ref: ObjectRef | TenantScopedKey): Promise<Uint8Array>;
  head(ref: ObjectRef | TenantScopedKey): Promise<ObjectMeta>;
  signedUrl(ref: ObjectRef | TenantScopedKey, ttlSeconds: number): Promise<string>;
}
