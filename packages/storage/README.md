# packages/storage

The object-storage adapter. Google Cloud Storage in every deployed environment (D43);
in-memory in tests.

## Why an adapter at all

Two reasons, and neither is "we might switch clouds".

1. **The suite must run offline.** Same rule as the mock model provider: a test that needs
   credentials is a test that gets skipped, and the things this layer protects — evidence
   immutability (T7), tenant-prefixed keys (T3) — are exactly the things you cannot afford
   to have skipped.
2. **The parser sandbox must have no storage credentials at all** (§40.6). Bytes are handed
   to it and results are taken from it by the caller. A sandbox that can reach the bucket
   is not a sandbox, and an interface makes that structurally obvious rather than a rule
   someone has to remember.

## Interface

```ts
interface ObjectStore {
  put(key: TenantScopedKey, bytes: Uint8Array, opts: PutOptions): Promise<ObjectRef>;
  get(ref: ObjectRef): Promise<Uint8Array>;
  head(ref: ObjectRef): Promise<ObjectMeta>;
  signedUrl(ref: ObjectRef, ttlSeconds: number): Promise<string>;
  // No delete(). Sources are withdrawn, never deleted (T7); purge is a separate,
  // permissioned, audited operation that lives behind the retention service.
}
```

`TenantScopedKey` is a branded type that can only be constructed from a tenant id plus a
path. It is not a string. A plain string cannot be passed to `put`, which is what makes
"every key is tenant-prefixed" a compile error rather than a review comment.

## Layout

```
<tenant_id>/<investigation_id>/sources/<sha256>
<tenant_id>/<investigation_id>/artifacts/<artifact_id>/<name>
<tenant_id>/<investigation_id>/exports/<export_id>.zip
```

Source bytes are content-addressed by SHA-256, which is what makes AC-ING-02
(byte-identical deduplication) fall out of the storage layout instead of needing a lookup
table: the same bytes land on the same key, and a second upload creates a new
`SourceInstance` with its own acquisition record rather than new bytes.

## Bucket configuration

See `docs/PLATFORM.md` §6. The one irreversible step: locking the retention policy on the
sources bucket. It cannot be undone and the period cannot be shortened afterwards. Settle
the workspace retention floor with the user first.
