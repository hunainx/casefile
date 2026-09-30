import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { hashPassword } from "../src/auth/crypto.js";
import { nextTotpCode } from "./helpers/totp.js";
import { CLAUDE_CODE_CLIENT, MCP_RESOURCE, claudeCodeCimdTransport, mcpAccessToken, mcpPost, seedMcpPerson } from "./helpers/mcp-oauth.js";

/**
 * Phase 3, section B: the four holes Phase 2B found (DEV-025 to DEV-028), each written first
 * and shown red against the 2B code.
 */

describe("Phase 3: the 2B findings", () => {
  let app: ReturnType<typeof buildApp>;
  let sql: postgres.Sql;
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  const OTHER_INV = randomUUID();
  const savedEnv: Record<string, string | undefined> = {};

  async function restUser(label: string, status = "active") {
    const id = randomUUID();
    const email = `${label}-${randomUUID().slice(0, 8)}@casefile.test`;
    const password = `Pw-${label}-Casefile-2026!`;
    const hash = await hashPassword(password);
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO users (id, tenant_id, email, name, status) VALUES (${id}, ${T}, ${email}, ${label}, ${status})`;
      await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash) VALUES (${id}, ${T}, ${hash})`;
      await tx`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (${randomUUID()}, ${T}, ${WS}, ${id}, 'investigator')`;
    }, sql);
    return { id, email, password };
  }

  const login = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId: T } });

  beforeAll(async () => {
    for (const k of ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID"]) savedEnv[k] = process.env[k];
    process.env.MATTER_TENANT_ID = T;
    process.env.MATTER_INVESTIGATION_ID = INV;
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql, oauth: { cimdTransport: claudeCodeCimdTransport } });
    await app.ready();
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Findings Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Matter WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${INV}, ${T}, ${WS}, 'The Matter', 'Phase 3', 'collecting')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${OTHER_INV}, ${T}, ${WS}, 'Walled Other Case', 'must never be shown', 'collecting')`;
    }, sql);
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("DEV-025: a user who is not active cannot sign in, and is told nothing about it", () => {
    it("REST: a suspended user with the right password gets exactly the wrong-password answer", async () => {
      const u = await restUser("dev025-rest", "suspended");
      const suspendedRes = await login(u.email, u.password);
      const wrongRes = await login(u.email, "not-the-password-123");
      expect(suspendedRes.statusCode, suspendedRes.body).toBe(401);
      const a = JSON.parse(suspendedRes.body);
      const b = JSON.parse(wrongRes.body);
      expect({ type: a.type, title: a.title, status: a.status, detail: a.detail }).toEqual({ type: b.type, title: b.title, status: b.status, detail: b.detail });
      expect(suspendedRes.body).not.toMatch(/accessToken|challengeToken|suspend|inactive|not active/i);
    });

    it("OAuth sign-in page: a suspended user with the right password sees 'Incorrect email or password'", async () => {
      const p = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, label: "dev025-oauth", wsRole: "investigator", status: "suspended" });
      const q = new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_CODE_CLIENT,
        redirect_uri: "http://localhost:53123/callback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: MCP_RESOURCE,
        scope: "casefile.read",
        state: "s",
      });
      const page = await app.inject({ method: "GET", url: `/oauth/authorize?${q}` });
      const cookie = /__Host-cf_csrf=([^;]+)/.exec(String(page.headers["set-cookie"]))![1]!;
      const flow = /name="flow" value="([^"]*)"/.exec(page.body)![1]!;
      const res = await app.inject({
        method: "POST",
        url: "/oauth/authorize",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` },
        payload: new URLSearchParams({ flow, csrf: cookie, email: p.email, password: p.password }).toString(),
      });
      expect(res.statusCode, res.body).toBe(401);
      expect(res.body).toMatch(/Incorrect email or password/);
      expect(res.body).not.toMatch(/not active|Two-step verification/);
    });

    it("REST: a user suspended between the password step and the TOTP step is refused", async () => {
      const p = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, label: "dev025-mfa", wsRole: "investigator" });
      const step = JSON.parse((await login(p.email, p.password)).body);
      expect(step.mfaRequired).toBe(true);
      await withTenant(T, (tx) => tx`UPDATE users SET status = 'suspended' WHERE id = ${p.id}`, sql);
      const res = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: step.challengeToken, totpCode: await nextTotpCode(p.secret) } });
      expect(res.statusCode, res.body).toBe(401);
      expect(res.body).not.toMatch(/accessToken/);
    });
  });

  describe("DEV-026: the MCP tools see only MATTER_INVESTIGATION_ID", () => {
    let token: string;
    beforeAll(async () => {
      token = await mcpAccessToken(app, await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, investigationId: INV, label: "dev026", wsRole: "ws_admin" }));
    });
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse((await mcpPost(app, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body).result;

    it("list_investigations returns only the matter's investigation", async () => {
      const r = await call("list_investigations", {});
      const ids = JSON.parse(r.content[0].text).investigations.map((i: { id: string }) => i.id);
      expect(ids).toEqual([INV]);
      expect(r.content[0].text).not.toContain("Walled Other Case");
    });

    it("get_investigation with another investigation's ID answers not found, exactly as for an unknown ID", async () => {
      const other = await call("get_investigation", { investigation_id: OTHER_INV });
      const unknown = await call("get_investigation", { investigation_id: randomUUID() });
      expect(other.isError).toBe(true);
      expect(other.content[0].text).toMatch(/not found/);
      expect(other.content[0].text).not.toContain("Walled Other Case");
      expect(other.content[0].text.replace(OTHER_INV, "<id>")).toBe(unknown.content[0].text.replace(/[0-9a-f-]{36}/, "<id>"));
    });

    it("get_investigation with no ID or the matter's ID returns the matter", async () => {
      expect(JSON.parse((await call("get_investigation", {})).content[0].text).investigation.id).toBe(INV);
      expect(JSON.parse((await call("get_investigation", { investigation_id: INV })).content[0].text).investigation.id).toBe(INV);
    });
  });

  describe("DEV-027: a user revokes only their own sessions", () => {
    it("another user's session ID answers 404 and the session stays live", async () => {
      const a = await restUser("dev027-a");
      const b = await restUser("dev027-b");
      const aTok = JSON.parse((await login(a.email, a.password)).body).accessToken;
      const bTok = JSON.parse((await login(b.email, b.password)).body).accessToken;
      const bSid = JSON.parse(Buffer.from(bTok.split(".")[1], "base64url").toString()).sid;
      const res = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${bSid}`, headers: { authorization: `Bearer ${aTok}` } });
      expect(res.statusCode, res.body).toBe(404);
      const [row] = await withTenant(T, (tx) => tx<{ is_revoked: boolean }[]>`SELECT is_revoked FROM auth_sessions WHERE id = ${bSid}`, sql);
      expect(row!.is_revoked).toBe(false);
    });

    it("the caller's own other session is revoked (200)", async () => {
      const a = await restUser("dev027-own");
      const first = JSON.parse((await login(a.email, a.password)).body).accessToken;
      const second = JSON.parse((await login(a.email, a.password)).body).accessToken;
      const sid = JSON.parse(Buffer.from(second.split(".")[1], "base64url").toString()).sid;
      const res = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${sid}`, headers: { authorization: `Bearer ${first}` } });
      expect(res.statusCode, res.body).toBe(200);
      const [row] = await withTenant(T, (tx) => tx<{ is_revoked: boolean }[]>`SELECT is_revoked FROM auth_sessions WHERE id = ${sid}`, sql);
      expect(row!.is_revoked).toBe(true);
    });

    it("an unknown session ID answers 404", async () => {
      const a = await restUser("dev027-unknown");
      const tok = JSON.parse((await login(a.email, a.password)).body).accessToken;
      const res = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${randomUUID()}`, headers: { authorization: `Bearer ${tok}` } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DEV-028: /mcp is limited per account once the gate knows the caller", () => {
    let limited: ReturnType<typeof buildApp>;
    beforeAll(async () => {
      limited = buildApp({
        db: sql,
        oauth: { cimdTransport: claudeCodeCimdTransport },
        rateLimit: { rules: { general: { windowSeconds: 60, perIp: 4, perAccount: 4 }, mcp: { windowSeconds: 60, perIp: 4, perAccount: 3 } } },
      });
      await limited.ready();
    });
    afterAll(async () => {
      await limited.close();
    });
    // Counters live in Postgres and outlive a run: a fresh address per test.
    const freshIp = () => `10.${randomBytes(3).join(".")}`;
    const list = (token: string | undefined, ip: string) =>
      limited.inject({
        method: "POST",
        url: "/mcp",
        remoteAddress: ip,
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });

    it("two users behind one address each get their own budget", async () => {
      const ip = freshIp();
      const a = await mcpAccessToken(app, await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, label: "dev028-a", wsRole: "investigator" }));
      const b = await mcpAccessToken(app, await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, label: "dev028-b", wsRole: "investigator" }));
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await list(a, ip)).statusCode);
      for (let i = 0; i < 3; i++) statuses.push((await list(b, ip)).statusCode);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
      const fourth = await list(a, ip);
      expect(fourth.statusCode, "a's own limit is 3").toBe(429);
      expect(Number(fourth.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    });

    it("requests that fail the gate are limited per address, and do not use up a signed-in caller's budget", async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await list(undefined, ip)).statusCode);
      expect(statuses).toEqual([401, 401, 401, 401, 429]);
      const c = await mcpAccessToken(app, await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, label: "dev028-c", wsRole: "investigator" }));
      expect((await list(c, ip)).statusCode, "a valid caller from the same address is counted by account").toBe(200);
    });
  });
});
