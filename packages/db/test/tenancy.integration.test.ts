import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { getDbUrl, createDbClient } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import { migrate } from "../migrate/index.js";

const TENANT_TABLES = [
  "organizations",
  "workspaces",
  "users",
  "workspace_members",
  "ethical_walls",
  "audit_events",
  "outbox",
] as const;

describe("packages/db — Tenancy & RLS Integration Tests", () => {
  let appDb: postgres.Sql;

  beforeAll(async () => {
    // Ensure migrations are up to date in test database. The owner URL comes from the
    // vitest integration config (DATABASE_URL_TEST_OWNER); no literal fallback here.
    const ownerUrl = process.env.DATABASE_URL_TEST_OWNER;
    if (!ownerUrl) throw new Error("DATABASE_URL_TEST_OWNER is not set (see vitest.integration.config.ts)");
    await migrate({ dbUrl: ownerUrl });

    // Connect as casefile_app (NOBYPASSRLS)
    appDb = createDbClient(getDbUrl());
  });

  afterAll(async () => {
    if (appDb) {
      await appDb.end();
    }
  });

  describe("Schema Invariants (pg_class & pg_policies)", () => {
    it("every tenant-scoped table has RLS both ENABLED and FORCED", async () => {
      const rows = await appDb<{ relname: string; rowsecurity: boolean; forcerowsecurity: boolean }[]>`
        SELECT c.relname, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ${appDb(TENANT_TABLES)}
        ORDER BY c.relname;
      `;

      expect(rows.length).toBe(TENANT_TABLES.length);
      for (const row of rows) {
        expect(row.rowsecurity, `Table ${row.relname} must have RLS enabled`).toBe(true);
        expect(row.forcerowsecurity, `Table ${row.relname} must have RLS forced`).toBe(true);
      }
    });

    it("every tenant-scoped table has a tenant_isolation policy keyed to current_setting('app.tenant_id')", async () => {
      const rows = await appDb<{ tablename: string; policyname: string; qual: string; with_check: string }[]>`
        SELECT tablename, policyname, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ${appDb(TENANT_TABLES)}
        ORDER BY tablename;
      `;

      const policyMap = new Map(rows.map((r) => [r.tablename, r]));
      for (const table of TENANT_TABLES) {
        const policy = policyMap.get(table);
        expect(policy, `Table ${table} must have a policy`).toBeDefined();
        expect(policy?.policyname).toBe("tenant_isolation");
        expect(policy?.qual).toContain("tenant_id");
        expect(policy?.qual).toContain("current_setting");
        expect(policy?.with_check).toContain("tenant_id");
        expect(policy?.with_check).toContain("current_setting");
      }
    });

    it("casefile_app role cannot BYPASSRLS and is not a superuser", async () => {
      const rows = await appDb<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolname, rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname = 'casefile_app';
      `;

      expect(rows.length).toBe(1);
      expect(rows[0]?.rolsuper).toBe(false);
      expect(rows[0]?.rolbypassrls).toBe(false);
    });

    it("casefile_app role CANNOT CREATE TABLE on public schema (insufficient privilege)", async () => {
      await expect(
        appDb.unsafe(`CREATE TABLE public.unauthorized_probe (id INT)`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("Fail-closed Behavior (No app.tenant_id set)", () => {
    it("returns zero rows for every tenant table when no tenant context is set", async () => {
      // Direct queries outside withTenant return 0 rows
      for (const table of TENANT_TABLES) {
        const rows = await appDb.unsafe(`SELECT * FROM ${table}`);
        expect(rows.length, `Query on ${table} outside tenant context must return 0 rows`).toBe(0);
      }
    });

    it("clears tenant context after transaction commits (SET LOCAL)", async () => {
      const tenantId = "11111111-1111-1111-1111-111111111111";

      await withTenant(
        tenantId,
        async (tx) => {
          const setting = await tx<{ val: string }[]>`SELECT current_setting('app.tenant_id', true) AS val`;
          expect(setting[0]?.val).toBe(tenantId);
        },
        appDb,
      );

      // Outside the transaction, tenant_id must be unset (NULL / empty)
      const afterSetting = await appDb<{ val: string }[]>`SELECT current_setting('app.tenant_id', true) AS val`;
      expect(afterSetting[0]?.val ?? "").toBe("");
    });

    it("clears tenant context after transaction rollback (SET LOCAL)", async () => {
      const tenantId = "22222222-2222-2222-2222-222222222222";

      try {
        await withTenant(
          tenantId,
          async (tx) => {
            const setting = await tx<{ val: string }[]>`SELECT current_setting('app.tenant_id', true) AS val`;
            expect(setting[0]?.val).toBe(tenantId);
            throw new Error("Intentional rollback");
          },
          appDb,
        );
      } catch (err: unknown) {
        expect((err as Error).message).toBe("Intentional rollback");
      }

      const afterSetting = await appDb<{ val: string }[]>`SELECT current_setting('app.tenant_id', true) AS val`;
      expect(afterSetting[0]?.val ?? "").toBe("");
    });
  });

  describe("Multi-tenant Isolation & Cross-tenant Probes", () => {
    const tenantA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenantB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    beforeAll(async () => {
      // Seed Tenant A data
      await withTenant(
        tenantA,
        async (tx) => {
          await tx`
            INSERT INTO organizations (id, tenant_id, name)
            VALUES (${tenantA}, ${tenantA}, 'Tenant A Org')
            ON CONFLICT (id) DO NOTHING;
          `;
          const wsA = "a1111111-1111-1111-1111-111111111111";
          await tx`
            INSERT INTO workspaces (id, tenant_id, name)
            VALUES (${wsA}, ${tenantA}, 'Workspace A')
            ON CONFLICT (id) DO NOTHING;
          `;
          const userA = "a2222222-2222-2222-2222-222222222222";
          await tx`
            INSERT INTO users (id, tenant_id, email, name)
            VALUES (${userA}, ${tenantA}, 'alice@tenanta.example', 'Alice A')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
            VALUES ('a3333333-3333-3333-3333-333333333333', ${tenantA}, ${wsA}, ${userA}, 'workspace_admin')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO ethical_walls (id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason)
            VALUES ('a4444444-4444-4444-4444-444444444444', ${tenantA}, ${wsA}, 'user', ${userA}, 'a5555555-5555-5555-5555-555555555555', 'Conflict A')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO audit_events (id, tenant_id, seq, workspace_id, actor_type, actor_id, actor_display, action, object_type, object_id, object_display, request_id, outcome, prev_hash, hash)
            VALUES ('01HM000000000000000000000A', ${tenantA}, 1, ${wsA}, 'user', ${userA}, 'Alice', 'user.login', 'workspace', ${wsA}, 'Workspace A', 'req_a1', 'success', '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000001')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
            VALUES ('a7777777-7777-7777-7777-777777777777', ${tenantA}, 'workspace', ${wsA}, 'WorkspaceCreated', '{"name":"Workspace A"}'::jsonb)
            ON CONFLICT (id) DO NOTHING;
          `;
        },
        appDb,
      );

      // Seed Tenant B data
      await withTenant(
        tenantB,
        async (tx) => {
          await tx`
            INSERT INTO organizations (id, tenant_id, name)
            VALUES (${tenantB}, ${tenantB}, 'Tenant B Org')
            ON CONFLICT (id) DO NOTHING;
          `;
          const wsB = "b1111111-1111-1111-1111-111111111111";
          await tx`
            INSERT INTO workspaces (id, tenant_id, name)
            VALUES (${wsB}, ${tenantB}, 'Workspace B')
            ON CONFLICT (id) DO NOTHING;
          `;
          const userB = "b2222222-2222-2222-2222-222222222222";
          await tx`
            INSERT INTO users (id, tenant_id, email, name)
            VALUES (${userB}, ${tenantB}, 'bob@tenantb.example', 'Bob B')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
            VALUES ('b3333333-3333-3333-3333-333333333333', ${tenantB}, ${wsB}, ${userB}, 'workspace_admin')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO ethical_walls (id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason)
            VALUES ('b4444444-4444-4444-4444-444444444444', ${tenantB}, ${wsB}, 'user', ${userB}, 'b5555555-5555-5555-5555-555555555555', 'Conflict B')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO audit_events (id, tenant_id, seq, workspace_id, actor_type, actor_id, actor_display, action, object_type, object_id, object_display, request_id, outcome, prev_hash, hash)
            VALUES ('01HM000000000000000000000B', ${tenantB}, 1, ${wsB}, 'user', ${userB}, 'Bob', 'user.login', 'workspace', ${wsB}, 'Workspace B', 'req_b1', 'success', '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000002')
            ON CONFLICT (id) DO NOTHING;
          `;
          await tx`
            INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
            VALUES ('b7777777-7777-7777-7777-777777777777', ${tenantB}, 'workspace', ${wsB}, 'WorkspaceCreated', '{"name":"Workspace B"}'::jsonb)
            ON CONFLICT (id) DO NOTHING;
          `;
        },
        appDb,
      );
    });

    it("as tenant A, SELECT on every table returns zero of tenant B rows", async () => {
      await withTenant(
        tenantA,
        async (tx) => {
          for (const table of TENANT_TABLES) {
            const rows = await tx<{ tenant_id: string }[]>`SELECT * FROM ${tx(table)}`;
            expect(rows.length).toBeGreaterThan(0);
            for (const r of rows) {
              expect(r.tenant_id).toBe(tenantA);
              expect(r.tenant_id).not.toBe(tenantB);
            }
          }
        },
        appDb,
      );
    });

    it("as tenant A, an INSERT carrying tenant B tenant_id is rejected by WITH CHECK", async () => {
      // Attempt cross-tenant insert into workspaces
      await expect(
        withTenant(
          tenantA,
          async (tx) => {
            await tx`
              INSERT INTO workspaces (id, tenant_id, name)
              VALUES ('a9999999-9999-9999-9999-999999999999', ${tenantB}, 'Infiltrator Workspace');
            `;
          },
          appDb,
        ),
      ).rejects.toThrow(/violates row-level security policy/i);

      // Attempt cross-tenant insert into users
      await expect(
        withTenant(
          tenantA,
          async (tx) => {
            await tx`
              INSERT INTO users (id, tenant_id, email, name)
              VALUES ('a9999999-9999-9999-9999-999999999998', ${tenantB}, 'infiltrator@infiltrator.example', 'Infiltrator');
            `;
          },
          appDb,
        ),
      ).rejects.toThrow(/violates row-level security policy/i);

      // Attempt cross-tenant insert into audit_events
      await expect(
        withTenant(
          tenantA,
          async (tx) => {
            await tx`
              INSERT INTO audit_events (id, tenant_id, seq, actor_type, actor_id, actor_display, action, object_type, object_id, object_display, request_id, outcome, prev_hash, hash)
              VALUES ('01HM0000000000000000000099', ${tenantB}, 1, 'user', 'a2222222-2222-2222-2222-222222222222', 'Alice', 'hack', 'workspace', 'a1111111-1111-1111-1111-111111111111', 'WS', 'req_x', 'denied', '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000099');
            `;
          },
          appDb,
        ),
      ).rejects.toThrow(/violates row-level security policy/i);
    });

    it("organizations_tenant_is_self CHECK constraint rejects INSERT where tenant_id <> id", async () => {
      const orgId = "c1111111-1111-1111-1111-111111111111";
      const mismatchedTenantId = "c2222222-2222-2222-2222-222222222222";

      await expect(
        withTenant(
          mismatchedTenantId,
          async (tx) => {
            await tx`
              INSERT INTO organizations (id, tenant_id, name)
              VALUES (${orgId}, ${mismatchedTenantId}, 'Mismatched Root Org');
            `;
          },
          appDb,
        ),
      ).rejects.toThrow(/organizations_tenant_is_self|check constraint/i);
    });
  });

  describe("Audit Events Immutability (Invariant I8)", () => {
    it("casefile_app role CANNOT UPDATE an audit_events row (permission denied)", async () => {
      await expect(
        appDb`UPDATE audit_events SET action = 'tampered' WHERE true`,
      ).rejects.toThrow(/permission denied/i);
    });

    it("casefile_app role CANNOT DELETE an audit_events row (permission denied)", async () => {
      await expect(
        appDb`DELETE FROM audit_events WHERE true`,
      ).rejects.toThrow(/permission denied/i);
    });

    it("casefile_app role CANNOT TRUNCATE audit_events (permission denied)", async () => {
      await expect(
        appDb`TRUNCATE audit_events`,
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
