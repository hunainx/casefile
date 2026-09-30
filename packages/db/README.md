# packages/db

Schema, plain-SQL migrations, RLS policies, and the tenant-context helper.

**Read `docs/PLATFORM.md` before touching anything here.** Three rules from it govern this
package, and each closes a way invariant I7 dies silently on a managed platform:

- **D44** — tenant context is `SET LOCAL` inside a transaction. `withTenant()` in
  `src/tenant.ts` is the only way a query reaches Postgres.
- **D45** — the Supabase secret key carries `BYPASSRLS`. It is used by `migrate/` and
  nowhere else. `guardrails/tenancy.spec.ts` enforces that by grepping the repository.
- **D46** — persistent servers use the direct connection on 5432.

## Migrations

Plain, reviewable SQL. No ORM generates them (D33). Every migration that creates a
tenant-scoped table must, in the same file:

1. add `tenant_id UUID NOT NULL`,
2. `ENABLE` **and** `FORCE` row level security,
3. create the `tenant_isolation` policy,
4. grant `casefile_app` the minimum — and for `audit_events`, `SELECT, INSERT` only (I8).

`FORCE` is not optional: without it the table owner bypasses the policy, and migrations run
as the owner.

The schema-snapshot test fails on any tenant-scoped table missing `FORCE ROW LEVEL
SECURITY` or a policy, so a table cannot quietly ship without isolation.

## The two CHECK constraints

I2 is a schema property, not an application convention (D4). The `assertions` table carries
constraints that reject `Verified` and `Refuted` from a `model` or `deterministic` asserter.
`guardrails/epistemic-authority.spec.ts` proves them by bypassing the service and writing
raw SQL — if the constraint is missing, that test writes the row and goes red.
