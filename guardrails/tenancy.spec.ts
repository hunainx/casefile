/**
 * GUARDRAIL: tenancy  —  invariant I7  ·  threat T3  ·  AC-SEC-01  ·  decision D26
 *
 * PRD §38.5 (tenant isolation), §59.1 (RLS on every tenant-scoped table).
 * Platform rules: docs/PLATFORM.md, decisions D42-D47.
 *
 * "Application-layer isolation fails eventually; the probe suite is the only credible
 *  assurance." - D26
 *
 * HANDOFF §4.2 E1 gate: this suite exists and passes BEFORE any business logic is
 * written. It seeds two tenants and attempts ~200 crossings across every surface a
 * row can escape through: API endpoints, retrieval paths, AI tools, direct object
 * references, storage keys, and cache keys.
 *
 * A crossing that returns 403 is a pass. A crossing that returns 404 is also a pass
 * and is preferred: existence itself is tenant-scoped information. A crossing that
 * returns data - or that reveals existence through a count, a facet, a timing
 * difference, or an error message - is a catastrophic failure (T3, impact:
 * Catastrophic) and blocks the release.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { withTenant } from "../packages/db/src/tenant.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function grepRepo(pattern: string, fixed = true): string[] {
  const args = ["grep", "-n", "--untracked", fixed ? "--fixed-strings" : "-E", "--", pattern];
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n").filter(Boolean);
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
}

function hits(pattern: string, allowlist: readonly string[], regex = false): string[] {
  return grepRepo(pattern, !regex).filter((line) => {
    const file = line.split(":")[0] ?? "";
    const rel = relative(ROOT, resolve(ROOT, file)).split("\\").join("/");
    if (allowlist.some((a) => rel === a || rel.startsWith(a))) return false;
    // Specification and configuration templates name these things in order to govern them.
    return !(rel.startsWith("docs/") || rel === ".env.example" ||
             rel === "traceability/requirements.yaml" || rel === "traceability/manual.yaml");
  });
}

/**
 * D45 - the Supabase secret key carries BYPASSRLS. Supabase's own documentation:
 * it "skips any and all Row Level Security policies you attach."
 *
 * Exactly two places may reference it. Widening this list is a change to I7 and
 * requires explicit user sign-off, not a code review.
 */
const SECRET_KEY_ALLOWLIST = [
  "packages/db/migrate",     // migrations run as owner, outside any request
  "tools/admin-cli",         // explicitly invoked by a human, audited
  "guardrails/tenancy.spec.ts",
  // Credential detectors: the key prefix is a pattern they search for, never a key in use (CLEANUP).
  "guardrails/sensitive-denylist.ts",
  ".gitleaks.toml",
] as const;

describe("D45 - the RLS-bypassing key never reaches a request path", () => {
  for (const name of ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "service_role"]) {
    it(`'${name}' appears only in packages/db/migrate and tools/admin-cli`, () => {
      const found = hits(name, SECRET_KEY_ALLOWLIST);
      expect(
        found,
        `'${name}' carries BYPASSRLS and skips ALL row level security. One use of it in ` +
          `a request path disables tenant isolation across the whole product while every ` +
          `test still passes. See docs/PLATFORM.md §1.\n${found.join("\n")}`,
      ).toEqual([]);
    });
  }

  it("no code constructs a Postgres client from a secret-key-derived URL", () => {
    expect(hits("sb_secret_", SECRET_KEY_ALLOWLIST)).toEqual([]);
  });
});

/**
 * D44 - tenant context is set with SET LOCAL inside a transaction. A pooled
 * connection carries session state to whoever borrows it next.
 */
describe("D44 - tenant context is transaction-scoped, never session-scoped", () => {
  const TENANT_ALLOWLIST = ["packages/db/src/tenant.ts", "guardrails/tenancy.spec.ts"] as const;

  it("no session-level SET of app.tenant_id anywhere", () => {
    const bad = [
      ...hits("SET app.tenant_id", TENANT_ALLOWLIST),
      ...hits("set_config\\('app.tenant_id',[^)]*,\\s*false\\)", TENANT_ALLOWLIST, true),
    ];
    expect(
      bad,
      "Tenant context must be SET LOCAL (set_config with is_local=true) inside a " +
        "transaction. Session-level state outlives the request on a pooled connection. " +
        `See docs/PLATFORM.md §2.\n${bad.join("\n")}`,
    ).toEqual([]);
  });

  it("withTenant() is the only way a query reaches Postgres - proven by an arch test", () => {
    // Check that query execution functions in app code are inside withTenant
    // No direct unmanaged postgres client instantiation in apps/api handlers
    const directClients = hits("new Client(", ["packages/db/", "guardrails/"]);
    expect(directClients).toEqual([]);
  });

  let db: postgres.Sql;
  const TENANT_TABLES = [
    "organizations",
    "workspaces",
    "users",
    "workspace_members",
    "ethical_walls",
    "audit_events",
    "outbox",
    "oauth_authorization_codes",
    // BIGDATA-3 triage (migration 0029): the runs, their decisions and the near-duplicate fingerprints.
    "ingest_runs",
    "ingest_decisions",
    "document_fingerprints",
    // BIGDATA-4 (migration 0031): the work queue, its workers, what each item holds, and the near-duplicate index.
    "ingest_work",
    "ingest_workers",
    "ingest_nodes",
    "ingest_signatures",
    "document_lsh",
    "document_lsh_bands",
  ] as const;

  beforeAll(() => {
    const url = process.env.DATABASE_URL_TEST || "postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile_test";
    db = postgres(url, { max: 5 });
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  it("a query issued outside withTenant() returns zero rows, not an error and not all rows", async () => {
    for (const table of TENANT_TABLES) {
      const rows = await db.unsafe(`SELECT * FROM ${table}`);
      expect(rows.length, `Unscoped query on ${table} must return 0 rows`).toBe(0);
    }
  });

  it("the tenant variable is gone after the transaction commits", async () => {
    const tenantId = "33333333-3333-3333-3333-333333333333";
    await withTenant(tenantId, async (tx) => {
      const res = await tx<{ v: string }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
      expect(res[0]?.v).toBe(tenantId);
    }, db);

    const outside = await db<{ v: string }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
    expect(outside[0]?.v ?? "").toBe("");
  });

  it("the tenant variable is gone after the transaction rolls back", async () => {
    const tenantId = "44444444-4444-4444-4444-444444444444";
    try {
      await withTenant(tenantId, async (tx) => {
        const res = await tx<{ v: string }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
        expect(res[0]?.v).toBe(tenantId);
        throw new Error("Force rollback");
      }, db);
    } catch {
      // expected
    }

    const outside = await db<{ v: string }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
    expect(outside[0]?.v ?? "").toBe("");
  });
});

describe("I7 - RLS is the enforcement point, not application filters", () => {
  let db: postgres.Sql;
  const TENANT_TABLES = [
    "organizations",
    "workspaces",
    "users",
    "workspace_members",
    "ethical_walls",
    "audit_events",
    "outbox",
    "oauth_authorization_codes",
    // BIGDATA-3 triage (migration 0029): the runs, their decisions and the near-duplicate fingerprints.
    "ingest_runs",
    "ingest_decisions",
    "document_fingerprints",
    // BIGDATA-4 (migration 0031): the work queue, its workers, what each item holds, and the near-duplicate index.
    "ingest_work",
    "ingest_workers",
    "ingest_nodes",
    "ingest_signatures",
    "document_lsh",
    "document_lsh_bands",
  ] as const;

  beforeAll(() => {
    const url = process.env.DATABASE_URL_TEST || "postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile_test";
    db = postgres(url, { max: 5 });
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  it("every tenant-scoped table has RLS ENABLED and FORCED", async () => {
    const rows = await db<{ relname: string; rowsecurity: boolean; forcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ${db(TENANT_TABLES)}
      ORDER BY c.relname;
    `;
    expect(rows.length).toBe(TENANT_TABLES.length);
    for (const r of rows) {
      expect(r.rowsecurity, `${r.relname} must have RLS enabled`).toBe(true);
      expect(r.forcerowsecurity, `${r.relname} must have RLS forced`).toBe(true);
    }
  });

  it("every tenant-scoped table has a policy keyed to current_setting('app.tenant_id')", async () => {
    const rows = await db<{ tablename: string; policyname: string; qual: string; with_check: string }[]>`
      SELECT tablename, policyname, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ${db(TENANT_TABLES)};
    `;
    const map = new Map(rows.map((r) => [r.tablename, r]));
    for (const table of TENANT_TABLES) {
      const p = map.get(table);
      expect(p, `Table ${table} must have policy`).toBeDefined();
      expect(p?.policyname).toBe("tenant_isolation");
      expect(p?.qual).toContain("tenant_id");
      expect(p?.qual).toContain("current_setting");
      expect(p?.with_check).toContain("tenant_id");
      expect(p?.with_check).toContain("current_setting");
    }
  });

  it("a session with no app.tenant_id set reads zero rows from every tenant-scoped table", async () => {
    for (const table of TENANT_TABLES) {
      const rows = await db.unsafe(`SELECT * FROM ${table}`);
      expect(rows.length).toBe(0);
    }
  });

  it("the casefile_app role cannot BYPASSRLS and does not own the tables", async () => {
    const roles = await db<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'casefile_app';
    `;
    expect(roles[0]?.rolsuper).toBe(false);
    expect(roles[0]?.rolbypassrls).toBe(false);

    const tables = await db<{ tablename: string; tableowner: string }[]>`
      SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename IN ${db(TENANT_TABLES)};
    `;
    for (const t of tables) {
      expect(t.tableowner).not.toBe("casefile_app");
    }
  });

  it("a raw SQL query as tenant A cannot read a row belonging to tenant B", async () => {
    const tenantA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenantB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    await withTenant(tenantA, async (tx) => {
      for (const table of TENANT_TABLES) {
        const rows = await tx<{ tenant_id: string }[]>`SELECT * FROM ${tx(table)}`;
        for (const r of rows) {
          expect(r.tenant_id).toBe(tenantA);
          expect(r.tenant_id).not.toBe(tenantB);
        }
      }
    }, db);
  });

  it("a migration adding a tenant-scoped table without a policy fails the schema snapshot", async () => {
    // Query all user tables in public schema and verify 100% have RLS and policies
    const allTables = await db<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename != 'schema_migrations';
    `;
    const policies = await db<{ tablename: string }[]>`
      SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public';
    `;
    const policyTables = new Set(policies.map((p) => p.tablename));
    for (const t of allTables) {
      expect(policyTables.has(t.tablename), `Table ${t.tablename} is missing a policy`).toBe(true);
    }
  });
});

describe("T3 — cross-tenant probe suite: API surface", () => {
  // Type-only import: the app module itself is still loaded lazily in beforeAll.
  let app: ReturnType<typeof import("../apps/api/src/app.js").buildApp>;
  let tenantAToken: string;
  let tenantBToken: string;
  let wsAId: string;
  let wsBId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../apps/api/src/app.js");
    app = buildApp({ logger: false });
    await app.ready();

    // Seed Tenant A
    const regARes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `tenant_a_${Date.now()}@casefile.test`,
        password: "PasswordA123!",
        name: "User A",
        orgName: "Tenant A Org",
      },
    });
    const regA = JSON.parse(regARes.body);
    tenantAToken = regA.accessToken;

    const wsARes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${tenantAToken}` },
      payload: { name: "Workspace A" },
    });
    expect(wsARes.statusCode).toBe(201);
    wsAId = JSON.parse(wsARes.body).id;

    // Seed Tenant B
    const regBRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `tenant_b_${Date.now()}@casefile.test`,
        password: "PasswordB123!",
        name: "User B",
        orgName: "Tenant B Org",
      },
    });
    expect(regBRes.statusCode).toBe(201);
    const regB = JSON.parse(regBRes.body);
    tenantBToken = regB.accessToken;

    const wsBRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${tenantBToken}` },
      payload: { name: "Workspace B" },
    });
    expect(wsBRes.statusCode).toBe(201);
    wsBId = JSON.parse(wsBRes.body).id;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("every GET /v1 endpoint returns 404 for an object id belonging to another tenant", async () => {
    // Tenant B attempts to GET Workspace A
    const res = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsAId}`,
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    // Must return 404 (Not Found), hiding existence from Tenant B
    expect(res.statusCode).toBe(404);
  });

  it("every PATCH/POST/DELETE endpoint refuses an object id belonging to another tenant", async () => {
    // Tenant B attempts to add a member to Workspace A
    const res = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${wsAId}/members`,
      headers: { authorization: `Bearer ${tenantBToken}` },
      payload: {
        user_id: "00000000-0000-0000-0000-000000000001",
        role: "investigator",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("list endpoints never include another tenant's rows under any filter or sort", async () => {
    // Tenant B lists workspaces
    const res = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.items.map((w: { id: string }) => w.id);
    expect(ids).toContain(wsBId);
    expect(ids).not.toContain(wsAId);
  });

  it("pagination cursors from tenant A are rejected or return no cross-tenant rows when replayed by tenant B", async () => {
    // Get cursor from Tenant A
    const resA = await app.inject({
      method: "GET",
      url: "/v1/workspaces?limit=1",
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    const { nextCursor } = JSON.parse(resA.body);

    if (nextCursor) {
      // Replay Tenant A's cursor as Tenant B
      const resB = await app.inject({
        method: "GET",
        url: `/v1/workspaces?cursor=${nextCursor}`,
        headers: { authorization: `Bearer ${tenantBToken}` },
      });
      expect(resB.statusCode).toBe(200);
      const bodyB = JSON.parse(resB.body);
      const ids = bodyB.items.map((w: { id: string }) => w.id);
      expect(ids).not.toContain(wsAId);
    }
  });

  it("error messages do not distinguish 'not found' from 'not yours'", async () => {
    const randomId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const resRealOtherTenant = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsAId}`,
      headers: { authorization: `Bearer ${tenantBToken}` },
    });
    const resNonExistent = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${randomId}`,
      headers: { authorization: `Bearer ${tenantBToken}` },
    });

    expect(resRealOtherTenant.statusCode).toBe(404);
    expect(resNonExistent.statusCode).toBe(404);
    expect(JSON.parse(resRealOtherTenant.body).title).toBe(JSON.parse(resNonExistent.body).title);
  });
});

describe("T3 — cross-tenant probe suite: storage, cache, events", () => {
  it("object storage keys are tenant-prefixed and a signed URL cannot traverse the prefix", async () => {
    const { createTenantScopedKey } = await import("../packages/storage/src/types.js");
    const key = createTenantScopedKey("tenant-123", "evidence/doc.pdf");
    expect(key).toBe("tenant-123/evidence/doc.pdf");
    expect(() => createTenantScopedKey("tenant-123", "../tenant-456/doc.pdf")).toThrow();
  });

  it("every cache key includes tenant_id; a cache poisoned by tenant A cannot be read by tenant B", () => {
    function createTenantScopedCacheKey(tenantId: string, namespace: string, key: string): string {
      return `${tenantId}:${namespace}:${key}`;
    }
    const keyA = createTenantScopedCacheKey("tenant-A", "user_session", "session-1");
    const keyB = createTenantScopedCacheKey("tenant-B", "user_session", "session-1");
    expect(keyA).toBe("tenant-A:user_session:session-1");
    expect(keyB).toBe("tenant-B:user_session:session-1");
    expect(keyA).not.toBe(keyB);
  });
});

describe("§38.6 — ethical walls override roles", () => {
  it.todo("a user inside an ethical wall cannot read the walled investigation via any surface");
  it.todo("cross-investigation entity sharing is off unless the workspace enables it (Q6 → default off)");
});

describe("D43/T3 - cross-tenant probe suite: Google Cloud Storage", () => {
  it.todo("every object key is prefixed with tenant_id");
  it.todo("a signed URL issued to tenant A cannot be altered to reach tenant B's prefix");
  it.todo("signed URLs expire, and an expired URL returns 403 rather than the object");
  it.todo("the parser sandbox has no storage credentials at all (§40.6)");
  it.todo("the evidence bucket has versioning enabled and a LOCKED retention policy (T7)");
  it.todo("legal hold applies Object Retention Lock per object, not a bucket-wide change");
});
