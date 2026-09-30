import { Storage, type File } from "@google-cloud/storage";
import { GoogleAuth, Impersonated } from "google-auth-library";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import {
  type ObjectStore,
  type TenantScopedKey,
  type ObjectRef,
  type ObjectMeta,
  type PutOptions,
  computeSha256,
  ObjectAlreadyStoredDifferentlyError,
} from "./types.js";

export interface GcsStoreOptions {
  bucket: string;
  endpoint?: string | undefined;
  projectId?: string | undefined;
  serviceAccountEmail?: string | undefined;
}

let emulatorCredentials: { client_email: string; private_key: string } | null = null;
function getEmulatorCredentials(): { client_email: string; private_key: string } {
  if (!emulatorCredentials) {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    emulatorCredentials = {
      client_email: "casefile-emulator@casefile.local",
      private_key: privateKey,
    };
  }
  return emulatorCredentials;
}

/**
 * Automatically creates the test bucket against the fake-gcs-server emulator if it doesn't already exist.
 */
export async function ensureEmulatorBucket(bucketName: string): Promise<void> {
  const host = process.env.STORAGE_EMULATOR_HOST;
  if (!host) return;
  const baseUrl = host.replace(/\/storage\/v1\/?$/, "");
  try {
    await fetch(`${baseUrl}/storage/v1/b`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: bucketName }),
    });
  } catch {
    // ignore if emulator is not reachable or bucket already exists
  }
}

/**
 * Returns a configured @google-cloud/storage client, handling ADC, impersonation,
 * and keyless service account token creator workflow.
 */
export async function getGcsStorageClient(options?: {
  projectId?: string | undefined;
  endpoint?: string | undefined;
  serviceAccountEmail?: string | undefined;
}): Promise<Storage> {
  const emulatorHost = process.env.STORAGE_EMULATOR_HOST || options?.endpoint;
  if (emulatorHost) {
    const creds = getEmulatorCredentials();
    const cleanEndpoint = emulatorHost.replace(/\/storage\/v1\/?$/, "").replace(/\/+$/, "");
    const savedHost = process.env.STORAGE_EMULATOR_HOST;
    delete process.env.STORAGE_EMULATOR_HOST;
    try {
      return new Storage({
        apiEndpoint: cleanEndpoint,
        projectId: options?.projectId || process.env.GCP_PROJECT_ID || "casefile-emulator-project",
        credentials: creds,
      });
    } finally {
      if (savedHost) process.env.STORAGE_EMULATOR_HOST = savedHost;
    }
  }

  const projectId = options?.projectId || process.env.GCP_PROJECT_ID;
  const authOptions: { projectId?: string; scopes: string[] } = {
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  };
  if (projectId && !projectId.includes("CHANGEME")) {
    authOptions.projectId = projectId;
  }
  const auth = new GoogleAuth(authOptions);
  const client = await auth.getClient();
  const saEmail =
    options?.serviceAccountEmail ||
    process.env.GCS_SERVICE_ACCOUNT_EMAIL ||
    process.env.GCP_SERVICE_ACCOUNT_EMAIL;

  if (client.constructor.name === "UserRefreshClient" && saEmail && !saEmail.includes("CHANGEME")) {
    const impersonated = new Impersonated({
      sourceClient: client,
      targetPrincipal: saEmail,
      targetScopes: [
        "https://www.googleapis.com/auth/devstorage.read_write",
        "https://www.googleapis.com/auth/cloud-platform",
      ],
      lifetime: 3600,
    });
    const storageOptions: { projectId?: string; apiEndpoint?: string; authClient?: unknown } = {
      authClient: impersonated,
    };
    if (projectId && !projectId.includes("CHANGEME")) storageOptions.projectId = projectId;
    if (options?.endpoint) storageOptions.apiEndpoint = options.endpoint;
    return new Storage(storageOptions as ConstructorParameters<typeof Storage>[0]);
  }

  const storageOptions: {
    projectId?: string;
    apiEndpoint?: string;
  } = {};
  if (projectId && !projectId.includes("CHANGEME")) storageOptions.projectId = projectId;
  if (options?.endpoint) storageOptions.apiEndpoint = options.endpoint;

  return new Storage(storageOptions);
}

/**
 * Human-readable description of the identity the GCS client will act as, computed the
 * same way getGcsStorageClient() decides: an impersonated matter service account when
 * running under user ADC with GCS_SERVICE_ACCOUNT_EMAIL set, otherwise the raw ADC.
 * Used only to make permission errors name who was refused.
 */
export async function describeGcsIdentity(): Promise<string> {
  try {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const saEmail = process.env.GCS_SERVICE_ACCOUNT_EMAIL || process.env.GCP_SERVICE_ACCOUNT_EMAIL;
    if (client.constructor.name === "UserRefreshClient" && saEmail && !saEmail.includes("CHANGEME")) {
      return `service account ${saEmail} (impersonated from local user ADC)`;
    }
    const creds = await auth.getCredentials().catch(() => null);
    if (creds?.client_email) {
      return `${creds.client_email} (Application Default Credentials)`;
    }
    return `Application Default Credentials (${client.constructor.name})`;
  } catch {
    return "unknown identity (Application Default Credentials could not be resolved)";
  }
}

function isPermissionDenied(err: unknown): boolean {
  const error = err as { code?: number | string; message?: string };
  if (error?.code === 403 || error?.code === "403") return true;
  const msg = error?.message || "";
  return /permission|denied|forbidden/i.test(msg);
}

/**
 * Builds the loud, non-retrying error raised when the matter identity is refused.
 * There is deliberately NO fallback to another credential: until 2026-09-04 these
 * helpers silently retried with the operator's own ADC on a 403, which let a matter's
 * ingest read any bucket the operator personally could.
 */
async function permissionDeniedError(action: string, bucketName: string, objectOrPrefix: string | undefined, cause: unknown): Promise<Error> {
  const identity = await describeGcsIdentity();
  const target = objectOrPrefix ? `gs://${bucketName}/${objectOrPrefix}` : `gs://${bucketName}`;
  return new Error(
    `Permission denied ${action} ${target} as ${identity}. ` +
      `No credential fallback is attempted. Grant that identity access to the bucket, or fix the matter environment, and retry.`,
    { cause },
  );
}

/**
 * A read stream of a bucket object, for every read in this package (D96).
 *
 * Each download's response body stream carries a fixed 11 "error" and "close" listeners, put
 * there by the three libraries under @google-cloud/storage (node-fetch 4, teeny-request 4,
 * @google-cloud/storage 3), one over Node's default of 10. Node therefore printed
 * "MaxListenersExceededWarning" twice for every object read, whatever its size: per request, not
 * per chunk or per retry (captures/bigdata2b/maxlisteners-probe.txt), so a bucket-mode ingest of
 * 100,000 objects printed 200,000 warnings. It is not a leak. @google-cloud/storage emits
 * "response", with that stream as its argument, before the last of those listeners are added,
 * so the limit is raised there, on that one stream only; no global default is changed.
 */
const RESPONSE_STREAM_MAX_LISTENERS = 16;
export function objectReadStream(file: File, opts?: { start?: number }): Readable {
  const stream = opts?.start ? file.createReadStream({ start: opts.start }) : file.createReadStream();
  stream.once("response", (res: EventEmitter) => res.setMaxListeners(RESPONSE_STREAM_MAX_LISTENERS));
  return stream;
}

/** A bucket object's bytes, read through objectReadStream (in place of file.download()). */
async function readObject(file: File): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of objectReadStream(file)) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

/** One object of a bucket listing: what the listing already says, without reading the object. */
export interface BucketObjectInfo {
  name: string;
  size: number;
  contentType?: string | undefined;
  /** Base64 CRC32C as GCS stores it (BIGDATA-3 triage compares size + CRC32C before hashing). */
  crc32c?: string | undefined;
  /** The object's generation: it changes whenever the object is replaced. */
  generation?: string | undefined;
  /** The file's modification time, if the uploader recorded it (custom metadata goog-reserved-file-mtime). */
  fileMtime?: Date | undefined;
}

/**
 * Lists objects in a GCS bucket under an optional prefix.
 */
export async function listBucketObjects(bucketName: string, prefix?: string): Promise<BucketObjectInfo[]> {
  const options = prefix ? { prefix } : {};
  try {
    const storage = await getGcsStorageClient();
    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles(options);
    return files
      .filter((f) => !f.name.endsWith("/"))
      .map((f) => {
        const mtime = Number((f.metadata?.metadata as Record<string, unknown> | undefined)?.["goog-reserved-file-mtime"]);
        return {
          name: f.name,
          size: Number(f.metadata?.size ?? 0),
          contentType: (f.metadata?.contentType as string) || undefined,
          crc32c: (f.metadata?.crc32c as string) || undefined,
          generation: f.metadata?.generation !== undefined ? String(f.metadata.generation) : undefined,
          fileMtime: Number.isFinite(mtime) && mtime > 0 ? new Date(mtime * 1000) : undefined,
        };
      });
  } catch (err: unknown) {
    if (isPermissionDenied(err)) {
      throw await permissionDeniedError("listing", bucketName, prefix, err);
    }
    throw err;
  }
}

/**
 * Downloads a single object's bytes from a GCS bucket.
 */
export async function downloadBucketObject(
  bucketName: string,
  objectName: string,
): Promise<Buffer> {
  try {
    const storage = await getGcsStorageClient();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectName);
    return await readObject(file);
  } catch (err: unknown) {
    if (isPermissionDenied(err)) {
      throw await permissionDeniedError("downloading", bucketName, objectName, err);
    }
    throw err;
  }
}

/**
 * SHA-256 of a bucket object, read as a stream (D93): bucket-mode ingest of an object too
 * large to parse hashes it without downloading it whole.
 */
export async function sha256OfBucketObject(bucketName: string, objectName: string): Promise<string> {
  try {
    const storage = await getGcsStorageClient();
    const hash = createHash("sha256");
    for await (const chunk of objectReadStream(storage.bucket(bucketName).file(objectName))) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch (err: unknown) {
    if (isPermissionDenied(err)) {
      throw await permissionDeniedError("downloading", bucketName, objectName, err);
    }
    throw err;
  }
}

/**
 * A bucket object as a read stream (BIGDATA-3B): a mailbox is read message by message from it,
 * never downloaded whole into memory.
 */
export async function bucketObjectReadStream(bucketName: string, objectName: string, opts?: { start?: number }): Promise<Readable> {
  try {
    const storage = await getGcsStorageClient();
    return objectReadStream(storage.bucket(bucketName).file(objectName), opts);
  } catch (err: unknown) {
    if (isPermissionDenied(err)) {
      throw await permissionDeniedError("downloading", bucketName, objectName, err);
    }
    throw err;
  }
}

/**
 * A bucket object copied to a local file by streaming (BIGDATA-3B: a PST is read with random
 * access, so bucket mode reads it from a temporary copy). Reads the bucket; writes only `path`.
 */
export async function downloadBucketObjectToFile(bucketName: string, objectName: string, path: string): Promise<void> {
  await pipeline(await bucketObjectReadStream(bucketName, objectName), createWriteStream(path));
}

/** A write refused because its precondition failed: here, the key already holds an object (412). */
function isPreconditionFailed(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
  return code === 412 || code === "412";
}

/**
 * GcsObjectStore — Google Cloud Storage adapter (D43).
 * Connects to real Google Cloud Storage via Application Default Credentials (ADC)
 * or fake-gcs-server endpoint. Supports keyless V4 signed URLs via IAM Credentials API
 * when running locally under user ADC or on Cloud Run under workload identity.
 */
export class GcsObjectStore implements ObjectStore {
  public readonly bucketName: string;
  public readonly endpoint?: string | undefined;
  public readonly projectId?: string | undefined;
  public readonly serviceAccountEmail?: string | undefined;
  private storagePromise: Promise<Storage> | null = null;

  constructor(opts: GcsStoreOptions) {
    if (!opts.bucket) {
      throw new Error("GcsObjectStore requires a valid bucket name.");
    }
    this.bucketName = opts.bucket;
    this.endpoint = opts.endpoint;
    this.projectId = opts.projectId;
    this.serviceAccountEmail = opts.serviceAccountEmail;
  }

  private async getStorage(): Promise<Storage> {
    if (process.env.STORAGE_EMULATOR_HOST) {
      await ensureEmulatorBucket(this.bucketName);
    }
    if (!this.storagePromise) {
      this.storagePromise = getGcsStorageClient({
        projectId: this.projectId,
        endpoint: this.endpoint,
        serviceAccountEmail: this.serviceAccountEmail,
      });
    }
    return this.storagePromise;
  }

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
    const storage = await this.getStorage();
    const bucket = storage.bucket(this.bucketName);
    const file = bucket.file(key);

    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metadata: Record<string, unknown> = {
      contentType,
    };
    if (opts.metadata) {
      metadata.metadata = { ...opts.metadata, sha256 };
    } else {
      metadata.metadata = { sha256 };
    }

    try {
      // Create-only (BIGDATA-4): the write succeeds only if no object has this key yet.
      await file.save(buffer, {
        contentType,
        metadata,
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (err: unknown) {
      if (!isPreconditionFailed(err)) throw err;
      return this.alreadyStored(key, sha256);
    }

    return {
      key,
      sizeBytes: bytes.byteLength,
      sha256,
      contentType,
    };
  }

  /**
   * The key already holds an object (a create-only write was refused with 412): nothing is
   * written. The same SHA-256 is "already stored" (an item done twice, a retry); other bytes are an
   * error, and the stored object stays as it is.
   */
  private async alreadyStored(key: TenantScopedKey, sha256: string): Promise<ObjectRef> {
    const meta = await this.head(key);
    if (meta.sha256 !== sha256) throw new ObjectAlreadyStoredDifferentlyError(key, meta.sha256, sha256);
    return { key, sizeBytes: meta.sizeBytes, sha256, contentType: meta.contentType, alreadyStored: true };
  }

  async putFile(key: TenantScopedKey, filePath: string, opts: PutOptions & { sha256: string }): Promise<ObjectRef> {
    const contentType = opts.contentType ?? "application/octet-stream";
    const { size } = await stat(filePath);
    const storage = await this.getStorage();
    const file = storage.bucket(this.bucketName).file(key);
    // A resumable upload streams the file in pieces, so a multi-GB file never sits in memory.
    // Create-only (BIGDATA-4), as put(): a key that holds an object already is not written again.
    try {
      await pipeline(
        createReadStream(filePath, { highWaterMark: 1024 * 1024 }),
        file.createWriteStream({
          resumable: true,
          contentType,
          metadata: { contentType, metadata: { ...(opts.metadata ?? {}), sha256: opts.sha256 } },
          preconditionOpts: { ifGenerationMatch: 0 },
        }),
      );
    } catch (err: unknown) {
      if (!isPreconditionFailed(err)) throw err;
      return this.alreadyStored(key, opts.sha256);
    }
    return { key, sizeBytes: size, sha256: opts.sha256, contentType };
  }

  async get(ref: ObjectRef | TenantScopedKey): Promise<Uint8Array> {
    const key = this.resolveKey(ref);
    const storage = await this.getStorage();
    const bucket = storage.bucket(this.bucketName);
    const file = bucket.file(key);
    const buffer = await readObject(file);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async head(ref: ObjectRef | TenantScopedKey): Promise<ObjectMeta> {
    const key = this.resolveKey(ref);
    const storage = await this.getStorage();
    const bucket = storage.bucket(this.bucketName);
    const file = bucket.file(key);
    const [metadata] = await file.getMetadata();

    const sizeBytes = Number(metadata.size ?? 0);
    const contentType = (metadata.contentType as string) ?? "application/octet-stream";
    const updatedAt = metadata.updated ? new Date(metadata.updated) : new Date();
    const customMetadata = (metadata.metadata as Record<string, string>) ?? undefined;

    let sha256 = "";
    if (customMetadata?.sha256) {
      sha256 = customMetadata.sha256;
    } else if (typeof ref !== "string" && ref.sha256) {
      sha256 = ref.sha256;
    }

    return {
      key: key as TenantScopedKey,
      sizeBytes,
      sha256,
      contentType,
      updatedAt,
      metadata: customMetadata,
    };
  }

  async signedUrl(
    ref: ObjectRef | TenantScopedKey,
    ttlSeconds: number,
  ): Promise<string> {
    const key = this.resolveKey(ref);
    const storage = await this.getStorage();
    const bucket = storage.bucket(this.bucketName);
    const file = bucket.file(key);
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + ttlSeconds * 1000,
    });
    return url;
  }

  async delete(): Promise<never> {
    throw new Error("deletion is not permitted: GCS bucket objects must never be deleted, overwritten, or moved (D62).");
  }

  async deleteFiles(): Promise<never> {
    throw new Error("deletion is not permitted: GCS bucket objects must never be deleted, overwritten, or moved (D62).");
  }
}

