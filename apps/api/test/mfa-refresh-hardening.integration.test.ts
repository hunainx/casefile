import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { AuthService } from "../src/auth/service.js";
import { generateTotp, generateTotpSecret, hashPassword, signJwt } from "../src/auth/crypto.js";
import { nextTotpCode } from "./helpers/totp.js";
import {
  CLAUDE_CODE_CLIENT,
  MCP_RESOURCE,
  claimsToResign,
  claudeCodeCimdTransport,
  jwtClaims,
  seedMcpPerson,
  signInForMcp,
  type McpPerson,
} from "./helpers/mcp-oauth.js";

/**
 * Phase 2B, section D of PHASE-2B-PROMPT.md: the holes found in 2A.
 * - DEV-022: the MFA challenge token must work for nothing but finishing the MFA step.
 * - DEV-023: /v1/auth/mfa/verify must require that challenge token, for that same user.
 * - Refresh (REST and OAuth) re-checks the user, and for OAuth their eligibility; a refused
 *   refresh revokes the session.
 * - Refresh rotation is atomic: of two concurrent refreshes with one token, one succeeds.
 * - A TOTP code (time step) is accepted once per account; new secrets are 160 bits.
 */

describe("Phase 2B: MFA and refresh hardening", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  const savedEnv: Record<string, string | undefined> = {};

  /** A REST user with a password; with TOTP enrolled unless totp: false. */
  async function restPerson(label: string, opts: { totp?: boolean; secret?: string } = {}) {
    const id = randomUUID();
    const email = `${label}-${randomUUID().slice(0, 8)}@casefile.test`;
    const password = `Pw-${label}-Casefile-2026!`;
    const secret = opts.secret ?? generateTotpSecret();
    const hash = await hashPassword(password);
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${id}, ${T}, ${email}, ${label})`;
      await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash, totp_secret, totp_enabled)
               VALUES (${id}, ${T}, ${hash}, ${opts.totp === false ? null : secret}, ${opts.totp !== false})`;
      await tx`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (${randomUUID()}, ${T}, ${WS}, ${id}, 'investigator')`;
    }, sql);
    return { id, email, password, secret };
  }

  async function passwordStep(p: { email: string; password: string }) {
    const res = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email: p.email, password: p.password, tenantId: T } });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as { mfaRequired?: boolean; challengeToken?: string; userId?: string; accessToken?: string; refreshToken?: string };
  }

  function mfaVerify(body: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: body });
  }

  function restRefresh(refreshToken: string) {
    return app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
  }

  function oauthRefresh(refreshToken: string) {
    return app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CODE_CLIENT, resource: MCP_RESOURCE }).toString(),
    });
  }

  async function oauthTokens(p: McpPerson) {
    const r = await signInForMcp(app, p);
    expect(r.tokens, r.body).toBeDefined();
    return r.tokens!;
  }

  async function familyRevoked(sessionId: string): Promise<boolean> {
    const rows = await withTenant(T, (tx) => tx<{ live: number }[]>`
      SELECT count(*)::int AS live FROM auth_sessions
      WHERE session_family_id = (SELECT session_family_id FROM auth_sessions WHERE id = ${sessionId})
        AND is_revoked = false`, sql);
    return rows[0]!.live === 0;
  }

  /**
   * Fires `requests` while a separate transaction holds the session row locked, waits until
   * both requests are blocked on that lock (so both have already read the row as live), then
   * releases it. Without an atomic rotation both then rotate the same token.
   */
  async function raceOnSessionRow<T>(sessionId: string, requests: () => Array<PromiseLike<T>>): Promise<T[]> {
    let inFlight: Array<PromiseLike<T>> = [];
    await withTenant(T, async (tx) => {
      await tx`SELECT id FROM auth_sessions WHERE id = ${sessionId} FOR UPDATE`;
      inFlight = requests();
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%auth_sessions%'`;
        if (row!.n >= inFlight.length) break;
        if (Date.now() > deadline) throw new Error(`only ${row!.n} of ${inFlight.length} refreshes reached the row lock`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }, sql);
    return Promise.all(inFlight);
  }

  beforeAll(async () => {
    for (const k of ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID"]) savedEnv[k] = process.env[k];
    process.env.MATTER_TENANT_ID = T;
    process.env.MATTER_INVESTIGATION_ID = INV;
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql, oauth: { cimdTransport: claudeCodeCimdTransport } });
    await app.ready();
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Hardening Test Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Matter WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${INV}, ${T}, ${WS}, 'Hardening Case', '2B tests', 'collecting')`;
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

  describe("DEV-022: the MFA challenge token is not an access token", () => {
    it("is refused by GET /v1/me", async () => {
      const p = await restPerson("dev022a");
      const step = await passwordStep(p);
      expect(step.mfaRequired).toBe(true);
      const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${step.challengeToken}` } });
      expect(me.statusCode, me.body).toBe(401);
    });

    it("is refused by GET /v1/auth/sessions", async () => {
      const p = await restPerson("dev022b");
      const step = await passwordStep(p);
      const res = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: { authorization: `Bearer ${step.challengeToken}` } });
      expect(res.statusCode, res.body).toBe(401);
    });

    it("is refused by /mcp", async () => {
      const p = await restPerson("dev022c");
      const step = await passwordStep(p);
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${step.challengeToken}`, accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(res.statusCode, res.body).toBe(401);
    });
  });

  describe("DEV-023: /v1/auth/mfa/verify needs the challenge token for the same user", () => {
    it("refuses a user ID and a valid TOTP code without a challenge token, and issues nothing", async () => {
      const p = await restPerson("dev023a");
      const res = await mfaVerify({ userId: p.id, tenantId: T, totpCode: await nextTotpCode(p.secret) });
      expect([400, 401], res.body).toContain(res.statusCode);
      expect(res.body).not.toMatch(/accessToken|refreshToken/);
    });

    it("refuses a challenge token issued to another user", async () => {
      const a = await restPerson("dev023b-a");
      const b = await restPerson("dev023b-b");
      const stepA = await passwordStep(a);
      const res = await mfaVerify({ challengeToken: stepA.challengeToken, userId: b.id, tenantId: T, totpCode: await nextTotpCode(b.secret) });
      expect(res.statusCode, res.body).toBe(401);
      expect(res.body).not.toMatch(/accessToken|refreshToken/);
    });

    it("refuses an access token presented as the challenge token", async () => {
      const p = await restPerson("dev023c");
      const access = signJwt({ sub: p.id, tid: T, sid: randomUUID(), roles: ["investigator"], mfa: false });
      const res = await mfaVerify({ challengeToken: access, userId: p.id, tenantId: T, totpCode: await nextTotpCode(p.secret) });
      expect(res.statusCode, res.body).toBe(401);
    });

    it("refuses an expired challenge token", async () => {
      const p = await restPerson("dev023d");
      const step = await passwordStep(p);
      const expired = signJwt(claimsToResign(step.challengeToken!), -60);
      const res = await mfaVerify({ challengeToken: expired, userId: p.id, tenantId: T, totpCode: await nextTotpCode(p.secret) });
      expect(res.statusCode, res.body).toBe(401);
    });

    it("signs in with the challenge token and the user's own code", async () => {
      const p = await restPerson("dev023e");
      const step = await passwordStep(p);
      const res = await mfaVerify({ challengeToken: step.challengeToken, totpCode: await nextTotpCode(p.secret) });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body);
      expect(jwtClaims(body.accessToken).sub).toBe(p.id);
      expect(jwtClaims(body.accessToken).mfa).toBe(true);
    });
  });

  describe("a TOTP code is accepted once", () => {
    it("REST: the same code cannot complete two sign-ins", async () => {
      const p = await restPerson("reuse-rest");
      const code = generateTotp(p.secret);
      const first = await mfaVerify({ challengeToken: (await passwordStep(p)).challengeToken, userId: p.id, tenantId: T, totpCode: code });
      expect(first.statusCode, first.body).toBe(200);
      const second = await mfaVerify({ challengeToken: (await passwordStep(p)).challengeToken, userId: p.id, tenantId: T, totpCode: code });
      expect(second.statusCode, second.body).toBe(401);
    });

    it("REST: a code from an earlier time step is refused once a later one was used", async () => {
      const p = await restPerson("reuse-order");
      const now = Date.now();
      const later = await mfaVerify({ challengeToken: (await passwordStep(p)).challengeToken, userId: p.id, tenantId: T, totpCode: generateTotp(p.secret, now + 30_000) });
      expect(later.statusCode, later.body).toBe(200);
      const earlier = await mfaVerify({ challengeToken: (await passwordStep(p)).challengeToken, userId: p.id, tenantId: T, totpCode: generateTotp(p.secret, now) });
      expect(earlier.statusCode, earlier.body).toBe(401);
    });

    it("step-up cannot reuse the code that signed in", async () => {
      const p = await restPerson("reuse-stepup");
      const code = generateTotp(p.secret);
      const signIn = await mfaVerify({ challengeToken: (await passwordStep(p)).challengeToken, userId: p.id, tenantId: T, totpCode: code });
      expect(signIn.statusCode, signIn.body).toBe(200);
      const stepUp = await app.inject({
        method: "POST",
        url: "/v1/auth/step-up",
        headers: { authorization: `Bearer ${JSON.parse(signIn.body).accessToken}` },
        payload: { totpCode: code },
      });
      expect(stepUp.statusCode, stepUp.body).toBe(401);
    });

    it("OAuth sign-in page: the same code cannot be used for a second connection", async () => {
      const p = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, label: "reuse-oauth", wsRole: "investigator" });
      const code = generateTotp(p.secret);
      const signIn = async () => {
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
        const field = (html: string, n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(html)![1]!;
        const headers = { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` };
        const pw = await app.inject({ method: "POST", url: "/oauth/authorize", headers, payload: new URLSearchParams({ flow: field(page.body, "flow"), csrf: cookie, email: p.email, password: p.password }).toString() });
        return app.inject({ method: "POST", url: "/oauth/authorize", headers, payload: new URLSearchParams({ flow: field(pw.body, "flow"), csrf: cookie, email: p.email, code }).toString() });
      };
      const first = await signIn();
      expect(first.statusCode, first.body).toBe(200);
      expect(first.body).toMatch(/Allow access/);
      const second = await signIn();
      expect(second.statusCode, second.body).toBe(401);
      expect(second.body).toMatch(/not valid/);
    });
  });

  describe("TOTP secrets are 160 bits (RFC 4226)", () => {
    it("generateTotpSecret() returns 32 base32 characters (20 bytes)", () => {
      const s = generateTotpSecret();
      expect(s).toMatch(/^[A-Z2-7]{32}$/);
    });

    it("the one-time setup page offers a 160-bit secret", async () => {
      const p = await restPerson("setup160", { totp: false });
      const issued = await withTenant(T, (tx) => AuthService.issuePasswordResetToken(tx, { tenantId: T, email: p.email, issuedBy: "test", requestId: `t-${randomUUID()}` }), sql);
      const page = await app.inject({ method: "GET", url: "/account/setup" });
      const cookie = /__Host-cf_csrf=([^;]+)/.exec(String(page.headers["set-cookie"]))![1]!;
      const start = await app.inject({
        method: "POST",
        url: "/account/setup",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` },
        payload: new URLSearchParams({ action: "start", csrf: cookie, token: issued.token }).toString(),
      });
      expect(start.statusCode, start.body).toBe(200);
      expect(/<dd class="mono">([A-Z2-7]+)<\/dd>/.exec(start.body)?.[1]).toMatch(/^[A-Z2-7]{32}$/);
    });

    it("an existing 20-character secret keeps working", async () => {
      const legacy = "JBSWY3DPEHPK3PXPJBSW"; // 20 base32 characters, the old length
      const p = await restPerson("legacy", { secret: legacy });
      const res = await mfaVerify({ challengeToken: (await passwordStep(p)).challengeToken, userId: p.id, tenantId: T, totpCode: await nextTotpCode(legacy) });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe("REST refresh re-checks the user", () => {
    it("a deactivated user's refresh is refused and the session revoked", async () => {
      const p = await restPerson("rest-suspended", { totp: false });
      const tokens = await passwordStep(p);
      await withTenant(T, (tx) => tx`UPDATE users SET status = 'suspended' WHERE id = ${p.id}`, sql);
      const res = await restRefresh(tokens.refreshToken!);
      expect(res.statusCode, res.body).toBe(401);
      expect(await familyRevoked(String(jwtClaims(tokens.accessToken!).sid))).toBe(true);
      await withTenant(T, (tx) => tx`UPDATE users SET status = 'active' WHERE id = ${p.id}`, sql);
      expect((await restRefresh(tokens.refreshToken!)).statusCode, "the refresh token stays dead").toBe(401);
    });

    it("a deleted user's refresh is refused", async () => {
      const p = await restPerson("rest-deleted", { totp: false });
      const tokens = await passwordStep(p);
      await withTenant(T, (tx) => tx`UPDATE users SET deleted_at = NOW() WHERE id = ${p.id}`, sql);
      const res = await restRefresh(tokens.refreshToken!);
      expect(res.statusCode, res.body).toBe(401);
      expect(await familyRevoked(String(jwtClaims(tokens.accessToken!).sid))).toBe(true);
    });
  });

  describe("OAuth refresh re-checks the user and their eligibility", () => {
    /** change() takes access away; undo() gives it back, and the revoked refresh token must stay dead. */
    const refusedAndRevoked = async (label: string, change: (p: McpPerson) => Promise<unknown>, undo: (p: McpPerson) => Promise<unknown>) => {
      const p = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, investigationId: INV, label, wsRole: "investigator" });
      const t = await oauthTokens(p);
      await change(p);
      const res = await oauthRefresh(t.refresh_token!);
      expect(res.statusCode, res.body).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_grant");
      expect(await familyRevoked(String(jwtClaims(t.access_token).sid)), "the connection must be revoked").toBe(true);
      await undo(p);
      expect(JSON.parse((await oauthRefresh(t.refresh_token!)).body).error, "the refresh token stays dead").toBe("invalid_grant");
    };

    it("a deactivated user", () =>
      refusedAndRevoked(
        "oauth-suspended",
        (p) => withTenant(T, (tx) => tx`UPDATE users SET status = 'suspended' WHERE id = ${p.id}`, sql),
        (p) => withTenant(T, (tx) => tx`UPDATE users SET status = 'active' WHERE id = ${p.id}`, sql),
      ));

    it("a user whose role no longer allows MCP (demoted to viewer)", () =>
      refusedAndRevoked(
        "oauth-demoted",
        (p) => withTenant(T, (tx) => tx`UPDATE workspace_members SET role = 'viewer' WHERE user_id = ${p.id}`, sql),
        (p) => withTenant(T, (tx) => tx`UPDATE workspace_members SET role = 'investigator' WHERE user_id = ${p.id}`, sql),
      ));

    it("a user removed from the matter's workspace", () =>
      refusedAndRevoked(
        "oauth-removed",
        (p) => withTenant(T, (tx) => tx`DELETE FROM workspace_members WHERE user_id = ${p.id}`, sql),
        (p) => withTenant(T, (tx) => tx`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (${randomUUID()}, ${T}, ${WS}, ${p.id}, 'investigator')`, sql),
      ));

    it("a user now behind an ethical wall", () =>
      refusedAndRevoked(
        "oauth-walled",
        (p) =>
          withTenant(T, (tx) => tx`INSERT INTO ethical_walls (id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason)
                                     VALUES (${randomUUID()}, ${T}, ${WS}, 'user', ${p.id}, ${INV}, 'Conflict (test)')`, sql),
        (p) => withTenant(T, (tx) => tx`DELETE FROM ethical_walls WHERE subject_id = ${p.id}`, sql),
      ));

    it("an eligible user still refreshes", async () => {
      const p = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, investigationId: INV, label: "oauth-ok", wsRole: "investigator" });
      const t = await oauthTokens(p);
      const res = await oauthRefresh(t.refresh_token!);
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe("refresh rotation is atomic: two refreshes with one token, only one succeeds", () => {
    it("REST /v1/auth/refresh", async () => {
      const p = await restPerson("race-rest", { totp: false });
      const tokens = await passwordStep(p);
      const sid = String(jwtClaims(tokens.accessToken!).sid);
      const results = await raceOnSessionRow(sid, () => [restRefresh(tokens.refreshToken!), restRefresh(tokens.refreshToken!)]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses, results.map((r) => r.body).join("\n")).toEqual([200, 401]);
      // The losing request presented a token that had just been rotated: reuse, so the whole
      // family is revoked (D76), including the winner's new session.
      expect(await familyRevoked(sid)).toBe(true);
    });

    it("OAuth /oauth/token", async () => {
      const p = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, investigationId: INV, label: "race-oauth", wsRole: "investigator" });
      const t = await oauthTokens(p);
      const sid = String(jwtClaims(t.access_token).sid);
      const results = await raceOnSessionRow(sid, () => [oauthRefresh(t.refresh_token!), oauthRefresh(t.refresh_token!)]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses, results.map((r) => r.body).join("\n")).toEqual([200, 400]);
      expect(await familyRevoked(sid)).toBe(true);
    });
  });
});
