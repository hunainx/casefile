import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { seedMcpPerson, type McpPerson } from "./helpers/mcp-oauth.js";

/**
 * Phase 3 (docs/PLAN-MCP-AUTH.md section 5, D77): the explicit local no-login mode.
 * - Startup: MCP_AUTH_MODE=local-no-login is refused (FATAL, non-zero exit) unless HOST is
 *   loopback, K_SERVICE is unset, NODE_ENV is not production, MCP_PUBLIC_URL is unset or
 *   loopback, and MCP_LOCAL_USER_ID is an active, MCP-eligible user of MATTER_TENANT_ID.
 *   Any MCP_AUTH_MODE other than oauth or local-no-login is refused too. These run the real
 *   entry point (apps/api/src/server.ts) in a child process.
 * - Every request: loopback remote address AND a localhost / 127.0.0.1 Host header, else 403.
 * - Calls run as that user through the same /mcp auth gate, role checks and audit rows.
 */

const ROOT = resolve(__dirname, "../../..");
const TSX_CLI = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const SERVER = resolve(ROOT, "apps/api/src/server.ts");
const EIGHT = ["get_document_page", "get_evidence", "get_investigation", "get_source", "list_documents", "list_investigations", "matter_status", "search"];

describe("MCP local no-login mode (Phase 3)", () => {
  let db: postgres.Sql;
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  let ok: McpPerson;
  let suspended: McpPerson;
  let viewer: McpPerson;
  const savedEnv: Record<string, string | undefined> = {};
  const KEYS = ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID", "MCP_AUTH_MODE", "MCP_LOCAL_USER_ID", "MCP_PUBLIC_URL", "HOST", "K_SERVICE"];

  /** The environment of a local-no-login server that should start; each test breaks one thing. */
  function baseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: getDbUrl(),
      SUPABASE_URL: "https://example.invalid",
      SUPABASE_PUBLISHABLE_KEY: "pk_test_not_a_real_key",
      JWT_SECRET: "test_jwt_secret_at_least_32_bytes_long_000",
      MATTER_TENANT_ID: T,
      MATTER_INVESTIGATION_ID: INV,
      MCP_AUTH_MODE: "local-no-login",
      MCP_LOCAL_USER_ID: ok.id,
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "development",
    };
    delete env.VITEST;
    delete env.MCP_PUBLIC_URL;
    delete env.K_SERVICE;
    return env;
  }

  /** Boots server.ts and expects it to refuse: non-zero exit, FATAL on stderr naming the reason. */
  function expectRefusal(env: NodeJS.ProcessEnv, reason: RegExp) {
    const res = spawnSync(process.execPath, [TSX_CLI, SERVER], { cwd: ROOT, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    const stderr = `${res.stderr ?? ""}${res.error ? `\n${res.error.message}` : ""}`;
    expect(res.status, `server.ts must exit non-zero (null = still running when killed)\n${stderr}`).not.toBeNull();
    expect(res.status, stderr).not.toBe(0);
    expect(stderr).toContain("FATAL");
    expect(stderr).toMatch(reason);
  }

  /** Boots server.ts and waits for it to listen; returns its stderr banner. */
  async function expectStarts(env: NodeJS.ProcessEnv): Promise<string> {
    const child = spawn(process.execPath, [TSX_CLI, SERVER], { cwd: ROOT, env, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    try {
      const deadline = Date.now() + 20_000;
      while (!out.includes("Server listening") && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(out, `stdout:\n${out}\nstderr:\n${err}`).toContain("Server listening at http://127.0.0.1:");
      return err;
    } finally {
      child.kill();
    }
  }

  beforeAll(async () => {
    for (const k of KEYS) savedEnv[k] = process.env[k];
    db = createDbClient(getDbUrl());
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Local Mode Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Matter WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${INV}, ${T}, ${WS}, 'Local Case', 'Phase 3', 'collecting')`;
    }, db);
    ok = await seedMcpPerson(db, { tenantId: T, workspaceId: WS, label: "local-ok", wsRole: "investigator" });
    suspended = await seedMcpPerson(db, { tenantId: T, workspaceId: WS, label: "local-suspended", wsRole: "investigator", status: "suspended" });
    viewer = await seedMcpPerson(db, { tenantId: T, workspaceId: WS, label: "local-viewer", wsRole: "viewer" });
  });

  afterAll(async () => {
    await db.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("startup refusals (FATAL, the process exits)", () => {
    it("an MCP_AUTH_MODE that is neither oauth nor local-no-login", () => expectRefusal({ ...baseEnv(), MCP_AUTH_MODE: "no-auth" }, /MCP_AUTH_MODE/));
    it("HOST=0.0.0.0", () => expectRefusal({ ...baseEnv(), HOST: "0.0.0.0" }, /HOST/));
    it("HOST unset (it defaults to 0.0.0.0)", () => {
      const env = baseEnv();
      delete env.HOST;
      expectRefusal(env, /HOST/);
    });
    it("K_SERVICE set (Cloud Run)", () => expectRefusal({ ...baseEnv(), K_SERVICE: "casefile-api" }, /K_SERVICE/));
    it("NODE_ENV=production", () => expectRefusal({ ...baseEnv(), NODE_ENV: "production" }, /NODE_ENV/));
    it("a non-loopback MCP_PUBLIC_URL", () => expectRefusal({ ...baseEnv(), MCP_PUBLIC_URL: "https://mcp.casefile.test/mcp" }, /MCP_PUBLIC_URL/));
    it("MCP_LOCAL_USER_ID missing", () => {
      const env = baseEnv();
      delete env.MCP_LOCAL_USER_ID;
      expectRefusal(env, /MCP_LOCAL_USER_ID/);
    });
    it("MCP_LOCAL_USER_ID naming no user of the matter", () => expectRefusal({ ...baseEnv(), MCP_LOCAL_USER_ID: randomUUID() }, /MCP_LOCAL_USER_ID/));
    it("MCP_LOCAL_USER_ID naming a suspended user", () => expectRefusal({ ...baseEnv(), MCP_LOCAL_USER_ID: suspended.id }, /MCP_LOCAL_USER_ID.*not active|not active.*MCP_LOCAL_USER_ID/s));
    it("MCP_LOCAL_USER_ID naming a user whose role allows no MCP tools (viewer)", () =>
      expectRefusal({ ...baseEnv(), MCP_LOCAL_USER_ID: viewer.id }, /MCP_LOCAL_USER_ID[\s\S]*viewer/));
    it("starts when every condition holds, with a loud banner", async () => {
      const banner = await expectStarts(baseEnv());
      expect(banner).toMatch(/LOCAL NO-LOGIN MODE/);
      expect(banner).toContain(ok.id);
    });
    it("starts with a loopback MCP_PUBLIC_URL", async () => {
      await expectStarts({ ...baseEnv(), MCP_PUBLIC_URL: "http://localhost:3099/mcp" });
    });
  });

  describe("every request", () => {
    let app: ReturnType<typeof buildApp>;

    beforeAll(async () => {
      process.env.MATTER_TENANT_ID = T;
      process.env.MATTER_INVESTIGATION_ID = INV;
      process.env.MCP_AUTH_MODE = "local-no-login";
      process.env.MCP_LOCAL_USER_ID = ok.id;
      process.env.HOST = "127.0.0.1";
      delete process.env.MCP_PUBLIC_URL;
      delete process.env.K_SERVICE;
      app = buildApp({ db });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    const local = (payload: Record<string, unknown>, opts: { host?: string; remote?: string } = {}) =>
      app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: opts.remote ?? "127.0.0.1",
        headers: { host: opts.host ?? "localhost:3099", accept: "application/json, text/event-stream", "content-type": "application/json" },
        payload,
      });

    it("buildApp refuses local-no-login when HOST is not loopback", () => {
      process.env.HOST = "0.0.0.0";
      try {
        expect(() => buildApp({ db })).toThrow(/HOST/);
      } finally {
        process.env.HOST = "127.0.0.1";
      }
    });

    it("no token needed from loopback with Host localhost: the user's tools, through the same gate", async () => {
      const res = await local({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).result.tools.map((t: { name: string }) => t.name).sort()).toEqual(EIGHT);
      const get = await app.inject({ method: "GET", url: "/mcp", headers: { host: "localhost" } });
      expect(get.statusCode, "GET passes the gate and gets the route's 405").toBe(405);
    });

    it("accepts Host 127.0.0.1 with a port, and localhost without one", async () => {
      expect((await local({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { host: "127.0.0.1:3099" })).statusCode).toBe(200);
      expect((await local({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { host: "localhost" })).statusCode).toBe(200);
    });

    it("a non-loopback remote address → 403", async () => {
      const res = await local({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { remote: "192.168.1.50" });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).not.toContain("matter_status");
    });

    it("a non-local Host header (DNS rebinding) → 403", async () => {
      for (const host of ["evil.example", "evil.example:3099", "localhost.evil.example", "127.0.0.1.nip.io", "[::1]:3099"]) {
        const res = await local({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { host });
        expect(res.statusCode, `${host}: ${res.body}`).toBe(403);
      }
    });

    it("calls run as the real user with the role checks, and every audit row says local-no-login", async () => {
      const call = (name: string, args: Record<string, unknown>) => local({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name, arguments: args } });
      const status = JSON.parse((await call("matter_status", {})).body).result;
      expect(status.isError).toBeFalsy();
      const refused = JSON.parse((await call("get_download_link", { document_id: randomUUID() })).body).result;
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/does not allow get_download_link/);
      const rows = await withTenant(T, (tx) => tx<{ action: string; actor_id: string; actor_display: string; after: unknown; session_id: string | null }[]>`
        SELECT action, actor_id, actor_display, after, session_id FROM audit_events
        WHERE tenant_id = ${T} AND actor_id = ${ok.id} AND (action = 'mcp.tool_call' OR action LIKE 'auth.deny:%') ORDER BY seq`, db);
      expect(rows.map((r) => r.action)).toEqual(["mcp.tool_call", "auth.deny:export.create"]);
      for (const r of rows) {
        const after = typeof r.after === "string" ? JSON.parse(r.after) : r.after;
        expect(after.auth_mode).toBe("local-no-login");
        expect(r.actor_display).toContain("local-no-login");
        expect(r.session_id).toBeNull();
      }
    });

    it("the user's eligibility is re-checked on every request: suspended → 403 on the next call", async () => {
      expect((await local({ jsonrpc: "2.0", id: 7, method: "tools/list" })).statusCode).toBe(200);
      await withTenant(T, (tx) => tx`UPDATE users SET status = 'suspended' WHERE id = ${ok.id}`, db);
      try {
        const res = await local({ jsonrpc: "2.0", id: 8, method: "tools/list" });
        expect(res.statusCode, res.body).toBe(403);
      } finally {
        await withTenant(T, (tx) => tx`UPDATE users SET status = 'active' WHERE id = ${ok.id}`, db);
      }
    });

    it("an OAuth-style bearer token changes nothing: the caller is still the local user", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: "127.0.0.1",
        headers: { host: "localhost", authorization: "Bearer not-a-token", accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 9, method: "tools/list" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).result.tools).toHaveLength(8);
    });
  });
});
