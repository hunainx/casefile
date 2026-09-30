import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { withTenant } from "../src/tenant.js";
import { getDbUrl } from "../src/client.js";

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(resolve(process.cwd(), ".env"))) {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  } catch {
    void 0;
  }
}

function getTestDbUrl(): string {
  // Opt-in flag: only reach live infrastructure if explicitly requested
  if (
    process.env.ENABLE_LIVE_SUPABASE_TESTS === "true" &&
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes("127.0.0.1") &&
    !process.env.DATABASE_URL.includes("localhost") &&
    !process.env.DATABASE_URL.includes("CHANGEME")
  ) {
    return process.env.DATABASE_URL;
  }
  // Default: run against the test database configured in vitest environment
  return getDbUrl();
}

const targetDbUrl = getTestDbUrl();
const describeLive = describe;

describeLive("packages/db — Supabase Tenancy & RLS Integration Tests (Live Cluster)", () => {
  let db: postgres.Sql;
  const tenantA_id = "a1111111-1111-1111-1111-111111111111";
  const tenantB_id = "b2222222-2222-2222-2222-222222222222";
  const wsA_id = "a1111111-1111-1111-1111-000000000001";
  const wsB_id = "b2222222-2222-2222-2222-000000000001";

  beforeAll(async () => {
    db = postgres(targetDbUrl, { max: 5, connect_timeout: 10 });

    // Ensure clean state for test tenants
    await db`DELETE FROM organizations WHERE id IN (${tenantA_id}, ${tenantB_id})`.catch(() => {});

    // Seed Tenant A
    await withTenant(tenantA_id, async (tx) => {
      await tx`
        INSERT INTO organizations (id, tenant_id, name)
        VALUES (${tenantA_id}, ${tenantA_id}, 'Supabase Live Tenant Alpha')
        ON CONFLICT (id) DO NOTHING;
      `;
      await tx`
        INSERT INTO workspaces (id, tenant_id, name)
        VALUES (${wsA_id}, ${tenantA_id}, 'Workspace Alpha Live')
        ON CONFLICT (id) DO NOTHING;
      `;
    }, db);

    // Seed Tenant B
    await withTenant(tenantB_id, async (tx) => {
      await tx`
        INSERT INTO organizations (id, tenant_id, name)
        VALUES (${tenantB_id}, ${tenantB_id}, 'Supabase Live Tenant Beta')
        ON CONFLICT (id) DO NOTHING;
      `;
      await tx`
        INSERT INTO workspaces (id, tenant_id, name)
        VALUES (${wsB_id}, ${tenantB_id}, 'Workspace Beta Live')
        ON CONFLICT (id) DO NOTHING;
      `;
    }, db);
  });

  afterAll(async () => {
    if (db) {
      await db`DELETE FROM organizations WHERE id IN (${tenantA_id}, ${tenantB_id})`.catch(() => {});
      await db.end();
    }
  });

  it("asserts the active tenant role is casefile_app with NOBYPASSRLS and NOSUPERUSER (D45, I7)", async () => {
    await withTenant(tenantA_id, async (tx) => {
      const rows = await tx<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolname, rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname = current_user;
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]?.rolname).toBe("casefile_app");
      expect(rows[0]?.rolsuper, "Active role must NOT be a superuser").toBe(false);
      expect(rows[0]?.rolbypassrls, "Active role must NOT have BYPASSRLS").toBe(false);
    }, db);
  });

  it("asserts every tenant table in public schema has RLS both ENABLED and FORCED", async () => {
    const rows = await db<{ relname: string; rowsecurity: boolean; forcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.attname = 'tenant_id'
        AND a.attisdropped = false
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname;
    `;

    expect(rows.length).toBeGreaterThanOrEqual(40);
    for (const row of rows) {
      expect(row.rowsecurity, `Table ${row.relname} must have RLS ENABLED`).toBe(true);
      expect(row.forcerowsecurity, `Table ${row.relname} must have RLS FORCED (applies to owner)`).toBe(true);
    }
  });

  it("asserts tenant isolation: Tenant A cannot read Tenant B data or direct IDs", async () => {
    await withTenant(tenantA_id, async (tx) => {
      const orgs = await tx`SELECT id, name FROM organizations;`;
      expect(orgs.length).toBe(1);
      expect(orgs[0]?.id).toBe(tenantA_id);

      const workspaces = await tx`SELECT id, name FROM workspaces;`;
      expect(workspaces.length).toBe(1);
      expect(workspaces[0]?.id).toBe(wsA_id);

      const directLookupB = await tx`SELECT id FROM workspaces WHERE id = ${wsB_id};`;
      expect(directLookupB.length).toBe(0);
    }, db);
  });

  it("asserts tenant isolation: Tenant A cross-tenant insert is rejected by RLS WITH CHECK policy", async () => {
    await withTenant(tenantA_id, async (tx) => {
      let threw = false;
      try {
        await tx.savepoint(async (sp) => {
          await sp`
            INSERT INTO workspaces (id, tenant_id, name)
            VALUES ('a1111111-1111-1111-1111-000000000099', ${tenantB_id}, 'Illicit Crossing Workspace');
          `;
        });
      } catch (err: unknown) {
        threw = true;
        const msg = String(err);
        expect(msg).toContain("violates row-level security policy");
      }
      expect(threw, "Cross-tenant INSERT must be rejected by PostgreSQL RLS").toBe(true);
    }, db);
  });

  it("asserts tenant isolation: Tenant B cannot read Tenant A data or direct IDs", async () => {
    await withTenant(tenantB_id, async (tx) => {
      const orgs = await tx`SELECT id, name FROM organizations;`;
      expect(orgs.length).toBe(1);
      expect(orgs[0]?.id).toBe(tenantB_id);

      const workspaces = await tx`SELECT id, name FROM workspaces;`;
      expect(workspaces.length).toBe(1);
      expect(workspaces[0]?.id).toBe(wsB_id);

      const directLookupA = await tx`SELECT id FROM workspaces WHERE id = ${wsA_id};`;
      expect(directLookupA.length).toBe(0);
    }, db);
  });

  it("asserts fail-closed behaviour: queries with unauthenticated/dummy tenant return 0 rows", async () => {
    await withTenant("00000000-0000-0000-0000-000000000000", async (tx) => {
      const unscopedOrgs = await tx`SELECT * FROM organizations WHERE id IN (${tenantA_id}, ${tenantB_id});`;
      expect(unscopedOrgs.length).toBe(0);

      const unscopedWorkspaces = await tx`SELECT * FROM workspaces WHERE id IN (${wsA_id}, ${wsB_id});`;
      expect(unscopedWorkspaces.length).toBe(0);
    }, db);
  });
});
