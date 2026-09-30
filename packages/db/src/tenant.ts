import { getDb } from "./client.js";
import type { Sql, TransactionSql } from "postgres";

export type Tx = TransactionSql;

/**
 * withTenant() — the ONLY way a query reaches Postgres.
 *
 * Scopes execution to a specific tenant using SET LOCAL (is_local = true)
 * inside a database transaction (D44).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  customDb?: Sql
): Promise<T> {
  const db = customDb || getDb();
  return (await db.begin(async (tx) => {
    // One statement (BIGDATA-4: it was three, each a round trip, in every transaction):
    //  - drop privileges to casefile_app (NOBYPASSRLS, NOSUPERUSER) if the session may, as the DO
    //    block before did (the same test, the same set_config);
    //  - set_config(..., true) === SET LOCAL: scoped to THIS transaction, discarded on commit or
    //    rollback. A pooled connection therefore cannot carry one request's tenant into the next
    //    request that borrows it.
    // The role is switched first: the select list is evaluated left to right.
    await tx`
      SELECT
        CASE WHEN SESSION_USER <> 'casefile_app' AND pg_has_role(SESSION_USER, 'casefile_app', 'MEMBER')
             THEN set_config('role', 'casefile_app', true) END,
        set_config('app.tenant_id', ${tenantId}, true),
        set_config('search_path', 'public, extensions', true)`;
    return fn(tx);
  })) as T;
}
