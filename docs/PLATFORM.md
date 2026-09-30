# PLATFORM — Supabase and Google Cloud Storage

Decisions **D42–D47**. Read this before writing any code that touches the database or
object storage. Most of it exists because a managed platform gives you two or three very
specific ways to disable invariant **I7** without any test going red, and this document is
where those are named and closed.

---

## 1. The one thing that will break tenant isolation

Supabase's **secret key** (`sb_secret_...`, and the legacy `service_role` JWT it replaces)
carries the Postgres `BYPASSRLS` attribute. Supabase's own documentation is explicit: it
"skips any and all Row Level Security policies you attach."

A single connection made with that key inside a request path disables tenant isolation
across the entire product — and every test still passes, because the tests are written
against a database that is no longer enforcing anything. This is exactly the failure mode
D26 was written to prevent, arriving through a convenience rather than through a design
decision.

**The rule (D45).** The secret key is used by:

- database migrations,
- a named, explicitly-invoked admin CLI,
- and nothing else, ever.

`apps/api` and every worker that serves a request connect as `casefile_app`: a role that is
**not** a superuser, **not** the table owner, and has `NOBYPASSRLS`. `guardrails/tenancy.spec.ts`
greps the repository for the key's environment variable name and fails if it appears
anywhere outside the two permitted locations. Do not add to that allowlist.

```
SUPABASE_SECRET_KEY        → packages/db (migrations) and tools/admin-cli only
DATABASE_URL               → casefile_app, NOBYPASSRLS  ← everything that serves a request
```

---

## 2. Tenant context: `SET LOCAL`, inside a transaction, always

**The rule (D44).** Every request opens a transaction, sets the tenant, does its work, and
commits. Tenant context is never set at session level and never configured as a connection
default.

```ts
// packages/db/src/tenant.ts — the ONLY way a query reaches Postgres.
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) === SET LOCAL: scoped to THIS transaction, discarded on
    // commit or rollback. A pooled connection therefore cannot carry one request's
    // tenant into the next request that borrows it.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

Why not session-level `SET`: a pooler hands the same physical connection to the next
caller. Session state outlives the request. On a transaction-mode pooler it is worse still,
because the connection can be reassigned between statements. `SET LOCAL` is correct on the
direct connection and on both pooler modes, so the application never has to know which is
in use.

Why not JWT claims in the policy (`auth.jwt() ->> 'tenant_id'`): that works for PostgREST,
but Casefile's API is Fastify talking to Postgres directly and its background workers have
no JWT at all. One mechanism for both, or the workers end up with a second path that has
no policy on it.

The policy on every tenant-scoped table:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY tenant_isolation ON <t>
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`FORCE` matters. Without it the table owner silently bypasses the policy, and migrations
run as the owner. The `true` second argument to `current_setting` makes an unset variable
return NULL rather than raising — which means **zero rows**, the correct fail-closed
behaviour. A query that forgot to open a tenant context returns nothing, loudly, rather
than returning everything.

---

## 3. Connections

| Use | Endpoint | Port | Notes |
|---|---|---|---|
| `apps/api`, workers | **Direct connection** | 5432 | Supabase's documented choice for persistent servers. Prepared statements work. |
| Session pooler | Supavisor session mode | 5432 | IPv4-only; use if the direct connection is unreachable from the runtime. |
| Short-lived / serverless | Transaction pooler | 6543 | **Does not support prepared statements** — disable them in the driver or you get intermittent failures under load, not a clean error. |

Casefile's API is a long-lived server, so **D46**: direct connection.

---

## 4. Extensions

Enable on the project: `vector`, `pg_trgm`, `pgcrypto`, `uuid-ossp`.

The pgvector extension is named **`vector`**, not `pgvector`. Both HNSW and IVFFlat index
types are available.

### The pgvector trap that breaks I10 (D47)

pgvector's documented behaviour: if you use an HNSW or IVFFlat index and then naively
filter the results on another column, **you get fewer rows back than you asked for** —
sometimes far fewer.

That is not a performance note. It is two invariant failures at once:

- **I10** says results the user cannot see are filtered *before* scoring, never after.
  Post-filtering an ANN result set is precisely "after".
- **T17 — silent recall failure**, rated High/High, is the threat where search misses
  material and the investigator concludes absence. A post-filtered ANN query fails exactly
  this way, and it fails invisibly: the result set looks like a normal result set.

So tenant and permission scoping must be expressed such that the index only ever searches
rows the caller may see. Partial indexes per tenant, a composite index the planner can use
for pre-filtering, or an iterative scan — whichever E6 measures best. **Recall@20 is
measured with the filter in place. A recall number obtained without it is a number about a
product nobody is shipping.**

`guardrails/tenancy.spec.ts` asserts that a hidden document cannot be detected through
result counts or facet counts, which is what catches this if it regresses.

---

## 5. Migrations

Plain, reviewable SQL owned by `packages/db` (**D33, unchanged**). Supabase's migration
directory is where they live; it is not a replacement for owning them, and no ORM
generates them.

```
packages/db/migrations/0001_tenancy.sql
packages/db/migrations/0002_rls_policies.sql
...
supabase/migrations/  →  symlink or copy step in CI; the SQL is authored once
```

Every migration that creates a tenant-scoped table must, in the same migration:

1. add `tenant_id UUID NOT NULL`,
2. `ENABLE` **and** `FORCE` row level security,
3. create the `tenant_isolation` policy,
4. grant `casefile_app` only what it needs — and for `audit_events`, `SELECT, INSERT` and
   nothing else (**I8**).

A migration that adds a table without its policy is a hole that opens the moment the table
has rows in it. The schema-snapshot test in E1 fails on any tenant-scoped table lacking
`FORCE ROW LEVEL SECURITY` or a policy, so this cannot be forgotten quietly.

---

## 6. Google Cloud Storage (D43)

### Buckets

| Bucket | Holds | Versioning | Retention |
|---|---|---|---|
| `casefile-sources-<env>` | Original uploaded bytes | on | locked to the retention floor |
| `casefile-artifacts-<env>` | Parser and OCR output, renders | on | none |
| `casefile-exports-<env>` | Evidence packages, reports | on | short lifecycle delete |

### Why a *locked* retention policy, not just versioning

T7 is evidence tampering by an insider with legitimate credentials. Object Versioning alone
does not stop them: a noncurrent version can be permanently deleted by anyone who can name
its generation number. A **locked** bucket retention policy is what actually prevents it —
GCS documents locking as irreversible, and the period as impossible to reduce afterwards.

That irreversibility cuts both ways, so decide before locking:

- The retention period can be *increased* later, never shortened, and never removed.
- The bucket cannot be deleted until every object in it has aged past the period.
- Set it too long and you cannot delete a customer's data on request within that window —
  which collides with §50 retention and with the customer's own obligations.

Settle the workspace retention floor with the user before locking anything. **Locking is a
one-way door.**

Legal hold (§50) is per-object **Object Retention Lock**, not a bucket-wide change.

### Keys and access

```
<tenant_id>/<investigation_id>/sources/<sha256>
<tenant_id>/<investigation_id>/artifacts/<artifact_id>/<name>
```

Tenant-prefixed, content-addressed on the source bytes (which is what makes AC-ING-02
byte-identical deduplication work). Signed URLs are scoped to a single object and a short
TTL; the guardrail suite asserts that a signed URL issued to tenant A cannot be used to
traverse into tenant B's prefix.

Access is via workload identity, not a downloaded key file. The parser sandbox (§40.6) has
**no** storage credentials at all — bytes are handed to it and results are taken from it by
the caller, because a sandbox that can reach the bucket is not a sandbox.

### Local and CI

Neither the test suite nor CI touches a real bucket. `packages/storage` defines the adapter
interface and ships an in-memory implementation used by every test; `fake-gcs-server`
covers the cases that need real HTTP semantics. Same rule as the mock model provider — the
suite runs offline and deterministically or it is not a suite.

---

## 7. What did **not** change

Worth stating plainly, because a platform switch invites over-correction:

- All ten invariants. Postgres is Postgres; RLS is RLS.
- D12 (Postgres for relational + FTS + vector + graph at MVP).
- D26 (tenant boundary enforced at the data layer with a continuous probe suite).
- The Assertion Service as the only write path, and the DB CHECK constraints behind it.
- Plain-SQL migrations owned by `packages/db`.
- The mock model provider, and the rule that no test reaches a real model provider.
- Every §61.3 threshold and all three hard gates.

Supabase Auth is **not** adopted by default. The §55 AUTH stories, §38 roles, and the
ethical-wall rules in §38.6 are more specific than a generic auth product, and routing them
through one adds a second identity model to reconcile with `workspace_members` and
`investigation_members`. If it is adopted later, that is a decision with its own number and
its own migration — not a convenience taken mid-epic.
