/**
 * GUARDRAIL: audit-immutability — invariant I8 · threat T7 · DEFECT 1 & 2 hardening
 *
 * Asserts that on audit_events and audit_chain_heads:
 * 1. The ONLY privileges held by any role other than postgres, service-role, and table owner
 *    on audit_events are SELECT and INSERT.
 * 2. The ONLY privileges held by any role other than postgres, service-role, and table owner
 *    on audit_chain_heads are SELECT, INSERT, and UPDATE.
 * 3. In particular, UPDATE, DELETE, and TRUNCATE are prohibited for any application or public role.
 * 4. This guardrail MUST FAIL (never skip) when no database is reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { getDbUrl, createDbClient } from "../packages/db/src/index.js";


describe("I8 Hardening — audit table immutability and privilege containment", () => {
  let db: postgres.Sql;

  beforeAll(async () => {
    try {
      db = createDbClient(getDbUrl());
      await db`SELECT 1 as ping`;
    } catch (err: unknown) {
      throw new Error(
        `GUARDRAIL FAILURE: Target database is unreachable at ${getDbUrl()}.\n` +
        `Audit immutability guardrail requires a reachable database and must never be skipped.`,
        { cause: err }
      );
    }
  });

  afterAll(async () => {
    if (db) {
      await db.end();
    }
  });

  it("audit_events permits only SELECT and INSERT for any non-admin role", async () => {
    // Determine table owners to identify administrative / migration owner roles
    const owners = await db<{ tablename: string; tableowner: string }[]>`
      SELECT tablename, tableowner
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'audit_events';
    `;
    const ownerRole = owners[0]?.tableowner;
    const privilegedRoles = await db<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolsuper OR rolbypassrls;
    `;
    const adminRoles = new Set(["postgres", ownerRole, ...privilegedRoles.map((r) => r.rolname)].filter(Boolean));

    // Inspect all granted privileges via aclexplode
    const grants = await db<{ grantee: string; privilege_type: string }[]>`
      SELECT 
        COALESCE(r.rolname, 'PUBLIC') as grantee,
        a.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public'
        AND c.relname = 'audit_events';
    `;

    const nonAdminGrants = grants.filter((g) => !adminRoles.has(g.grantee));

    for (const grant of nonAdminGrants) {
      const priv = grant.privilege_type.toUpperCase();
      expect(
        ["SELECT", "INSERT"],
        `Forbidden privilege '${priv}' found on audit_events for role '${grant.grantee}'. Only SELECT and INSERT are allowed.`
      ).toContain(priv);
    }

    const forbiddenPrivileges = nonAdminGrants
      .map((g) => g.privilege_type.toUpperCase())
      .filter((p) => ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(p));

    expect(forbiddenPrivileges).toEqual([]);
  });

  it("audit_chain_heads permits only SELECT, INSERT, and UPDATE for any non-admin role", async () => {
    const owners = await db<{ tablename: string; tableowner: string }[]>`
      SELECT tablename, tableowner
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'audit_chain_heads';
    `;
    const ownerRole = owners[0]?.tableowner;
    const privilegedRoles = await db<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolsuper OR rolbypassrls;
    `;
    const adminRoles = new Set(["postgres", ownerRole, ...privilegedRoles.map((r) => r.rolname)].filter(Boolean));

    const grants = await db<{ grantee: string; privilege_type: string }[]>`
      SELECT 
        COALESCE(r.rolname, 'PUBLIC') as grantee,
        a.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public'
        AND c.relname = 'audit_chain_heads';
    `;

    const nonAdminGrants = grants.filter((g) => !adminRoles.has(g.grantee));

    for (const grant of nonAdminGrants) {
      const priv = grant.privilege_type.toUpperCase();
      expect(
        ["SELECT", "INSERT", "UPDATE"],
        `Forbidden privilege '${priv}' found on audit_chain_heads for role '${grant.grantee}'. Only SELECT, INSERT, and UPDATE are allowed.`
      ).toContain(priv);
    }

    const forbiddenPrivileges = nonAdminGrants
      .map((g) => g.privilege_type.toUpperCase())
      .filter((p) => ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(p));

    expect(forbiddenPrivileges).toEqual([]);
  });

  it("operational enforcement: UPDATE, DELETE, and TRUNCATE on audit_events fail with permission denied", async () => {
    await expect(
      db`UPDATE audit_events SET action = 'tampered' WHERE false`
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db`DELETE FROM audit_events WHERE false`
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db`TRUNCATE audit_events`
    ).rejects.toThrow(/permission denied/i);
  });

  it("operational enforcement: DELETE and TRUNCATE on audit_chain_heads fail with permission denied", async () => {
    await expect(
      db`DELETE FROM audit_chain_heads WHERE false`
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db`TRUNCATE audit_chain_heads`
    ).rejects.toThrow(/permission denied/i);
  });
});
