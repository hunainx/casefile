import { InMemoryObjectStore } from "./memory.js";
import { GcsObjectStore, type GcsStoreOptions } from "./gcs.js";
import type { ObjectStore } from "./types.js";

export * from "./types.js";
export * from "./memory.js";
export * from "./gcs.js";

let defaultStore: ObjectStore | null = null;
const storesByBucket = new Map<string, ObjectStore>();

/**
 * Returns the configured ObjectStore instance.
 *
 * Loud failure policy:
 * - If STORAGE_DRIVER='gcs', attempts to initialize GcsObjectStore for the specified bucket or GCS_BUCKET_SOURCES.
 * - If credentials or bucket are missing, throws immediately. Never silently downgrades to memory.
 * - If STORAGE_DRIVER is unset or 'memory', uses InMemoryObjectStore (used for unit tests and hermetic CI).
 */
export function getObjectStore(bucketName?: string): ObjectStore {
  const rawDriver = process.env.STORAGE_DRIVER;
  const driver = rawDriver ? rawDriver.split("#")[0]?.trim() : "memory";

  if (driver === "memory" || !driver) {
    if (!defaultStore) {
      defaultStore = new InMemoryObjectStore();
    }
    return defaultStore;
  }

  if (driver === "gcs") {
    const bucket = bucketName || process.env.GCS_BUCKET_SOURCES;
    if (!bucket || bucket.includes("CHANGEME")) {
      throw new Error(
        "STORAGE_DRIVER is set to 'gcs' but GCS_BUCKET_SOURCES is not configured. Failing loudly per D43.",
      );
    }

    let store = storesByBucket.get(bucket);
    if (!store) {
      const opts: GcsStoreOptions = {
        bucket,
      };
      const projectId = process.env.GCP_PROJECT_ID;
      if (projectId && !projectId.includes("CHANGEME")) {
        opts.projectId = projectId;
      }
      const saEmail =
        process.env.GCS_SERVICE_ACCOUNT_EMAIL || process.env.GCP_SERVICE_ACCOUNT_EMAIL;
      if (saEmail && !saEmail.includes("CHANGEME")) {
        opts.serviceAccountEmail = saEmail;
      }
      store = new GcsObjectStore(opts);
      storesByBucket.set(bucket, store);
    }
    return store;
  }

  throw new Error(`Unknown STORAGE_DRIVER: '${driver}'. Must be 'gcs' or 'memory'.`);
}

export function setObjectStore(store: ObjectStore | null): void {
  defaultStore = store;
  storesByBucket.clear();
}
