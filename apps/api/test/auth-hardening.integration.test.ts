import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { signJwt, generateRefreshToken, generateTotp, generateTotpSecret } from "../src/auth/crypto.js";
import { MFA_CHALLENGE_AUDIENCE, storeWebAuthnCredential } from "../src/auth/service.js";

/**
 * Behaviour changed in MCP sign-in Phase 2A that already existed, each proven red first:
 * - the REST API refuses tokens that carry an `aud` claim (MCP tokens, D69);
 * - the REST refresh endpoint refuses refresh tokens of an OAuth (MCP) session;
 * - TOTP cannot be enrolled with a password-only session (D71): /v1/auth/mfa/setup is gone
 *   and /v1/auth/mfa/verify no longer switches TOTP on;
 * - passkey credentials can be stored (DEV-021).
 */
describe("apps/api — auth hardening for MCP sign-in (Phase 2A)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let user: { id: string; tenantId: string };
  let accessToken: string;
  const MCP_AUDIENCE = "https://mcp.casefile.test/mcp";

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `hardening-${randomUUID()}@casefile.test`, password: "Hardening123!", name: "Hardening", orgName: "Hardening Org" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    user = body.user;
    accessToken = body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("the REST API refuses an otherwise valid access token that carries an aud claim", async () => {
    const claims = { sub: user.id, tid: user.tenantId, sid: randomUUID(), roles: ["ws_admin"], mfa: true };
    const control = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${signJwt(claims)}` } });
    expect(control.statusCode, "the same claims without aud are accepted").toBe(200);

    const mcpToken = signJwt({ ...claims, aud: MCP_AUDIENCE, scope: "casefile.read", cid: "https://claude.ai/oauth/claude-code-client-metadata" });
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${mcpToken}` } });
    expect(res.statusCode).toBe(401);
  });

  it("the REST refresh endpoint refuses the refresh token of an OAuth (MCP) session and leaves it usable", async () => {
    const { token, hash } = generateRefreshToken(user.tenantId);
    const sessionId = randomUUID();
    await withTenant(user.tenantId, (tx) => tx`
      INSERT INTO auth_sessions (id, tenant_id, user_id, session_family_id, refresh_token_hash, expires_at, oauth_client_id, audience)
      VALUES (${sessionId}, ${user.tenantId}, ${user.id}, ${randomUUID()}, ${hash}, NOW() + INTERVAL '90 days',
              'https://claude.ai/oauth/claude-code-client-metadata', ${MCP_AUDIENCE})`, sql);

    const res = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: token } });
    expect(res.statusCode).toBe(401);
    const [row] = await withTenant(user.tenantId, (tx) => tx<{ is_revoked: boolean }[]>`
      SELECT is_revoked FROM auth_sessions WHERE id = ${sessionId}`, sql);
    expect(row!.is_revoked, "a refused request must not rotate or revoke the MCP session").toBe(false);
  });

  it("POST /v1/auth/mfa/setup no longer hands out a TOTP secret (enrolment is the admin one-time link only)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/mfa/setup", headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.statusCode).toBe(410);
    expect(res.body).not.toMatch(/otpauth:|"secret"/);
    const [cred] = await withTenant(user.tenantId, (tx) => tx<{ totp_secret: string | null; totp_enabled: boolean }[]>`
      SELECT totp_secret, totp_enabled FROM auth_credentials WHERE user_id = ${user.id}`, sql);
    expect(cred!.totp_secret).toBeNull();
    expect(cred!.totp_enabled).toBe(false);
  });

  it("POST /v1/auth/mfa/verify cannot switch TOTP on for an account that has not enrolled", async () => {
    // A secret stored but never confirmed (as the old /mfa/setup left it): verify must not activate it.
    const secret = generateTotpSecret();
    await withTenant(user.tenantId, (tx) => tx`
      UPDATE auth_credentials SET totp_secret = ${secret}, totp_enabled = false WHERE user_id = ${user.id}`, sql);

    // A valid challenge token for this user (D75), so the refusal below is about enrolment.
    const challengeToken = signJwt({ sub: user.id, tid: user.tenantId, sid: "mfa_challenge", roles: [], mfa: false, aud: MFA_CHALLENGE_AUDIENCE }, 300);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      payload: { challengeToken, userId: user.id, tenantId: user.tenantId, totpCode: generateTotp(secret) },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).accessToken).toBeUndefined();
    const [cred] = await withTenant(user.tenantId, (tx) => tx<{ totp_enabled: boolean }[]>`
      SELECT totp_enabled FROM auth_credentials WHERE user_id = ${user.id}`, sql);
    expect(cred!.totp_enabled).toBe(false);
  });

  it("DEV-021: a verified passkey credential can be stored, and stored again (conflict path)", async () => {
    const credential = {
      id: `passkey_${randomUUID()}`,
      tenantId: user.tenantId,
      userId: user.id,
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: ["usb", "nfc"],
      name: "Test Passkey",
    };
    await withTenant(user.tenantId, (tx) => storeWebAuthnCredential(tx, credential), sql);
    await withTenant(user.tenantId, (tx) => storeWebAuthnCredential(tx, { ...credential, counter: 7, backedUp: true }), sql);
    const [row] = await withTenant(user.tenantId, (tx) => tx<{ counter: string; backed_up: boolean; transports: string[] }[]>`
      SELECT counter, backed_up, transports FROM webauthn_credentials WHERE id = ${credential.id}`, sql);
    expect(Number(row!.counter)).toBe(7);
    expect(row!.backed_up).toBe(true);
    expect(row!.transports).toEqual(["usb", "nfc"]);
  });
});
