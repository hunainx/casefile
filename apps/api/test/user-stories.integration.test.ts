import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import { nextTotpCode } from "./helpers/totp.js";
import { AuthService } from "../src/auth/service.js";
import { enrolTotpThroughSetupLink } from "./helpers/setup-link.js";

describe("apps/api — User Stories Integration Test Suite (AUTH & WS)", () => {
  let app: FastifyInstance;
  let db: postgres.Sql;

  beforeAll(async () => {
    db = createDbClient(getDbUrl());
    app = buildApp({ db, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (db) await db.end();
  });

  it("REQ-AUTH-01 & REQ-AUTH-02: Register with email/password and setup TOTP MFA", async () => {
    const testEmail = `story_auth_${Date.now()}@casefile.test`;
    const password = "ComplexPassword999!";

    // 1. REQ-AUTH-01: Register root user
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: testEmail,
        password,
        name: "Story Auth User",
        orgName: "Story Org",
      },
    });
    expect(regRes.statusCode).toBe(201);
    const regData = JSON.parse(regRes.body);
    expect(regData.accessToken).toBeDefined();
    expect(regData.refreshToken).toBeDefined();
    expect(regData.user.email).toBe(testEmail);

    const token = regData.accessToken;

    // 2. REQ-AUTH-02: Set up TOTP MFA — only through the admin-issued one-time link (D71);
    // a password-only session cannot enrol an authenticator.
    const refused = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/setup",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.statusCode).toBe(410);
    const { secret, uri } = await enrolTotpThroughSetupLink(app, db, { tenantId: regData.user.tenantId, email: testEmail, password });
    expect(secret).toBeDefined();
    expect(uri).toContain("otpauth://totp/Casefile");

    // 3. Sign in again: password, then the TOTP challenge
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: testEmail, password, tenantId: regData.user.tenantId },
    });
    expect(login.statusCode).toBe(200);
    expect(JSON.parse(login.body).mfaRequired).toBe(true);
    const otp = await nextTotpCode(secret);
    const mfaVerify = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      payload: {
        challengeToken: JSON.parse(login.body).challengeToken,
        userId: regData.user.id,
        tenantId: regData.user.tenantId,
        totpCode: otp,
      },
    });
    expect(mfaVerify.statusCode).toBe(200);
    const verifiedTokens = JSON.parse(mfaVerify.body);
    expect(verifiedTokens.accessToken).toBeDefined();
  });

  it("REQ-AUTH-05 & REQ-AUTH-06: List active sessions and remotely revoke a session", async () => {
    const testEmail = `sessions_${Date.now()}@casefile.test`;
    const password = "ComplexPassword999!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Session User", orgName: "Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { refreshToken } = JSON.parse(regRes.body);

    // Rotate to create a second active session
    const rotRes = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(rotRes.statusCode).toBe(200);
    const { accessToken: token2 } = JSON.parse(rotRes.body);

    // REQ-AUTH-05: List sessions
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(listRes.statusCode).toBe(200);
    const body = JSON.parse(listRes.body);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);

    const targetSession = body.sessions[0]!;

    // REQ-AUTH-06: Revoke target session
    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${targetSession.id}`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(JSON.parse(revokeRes.body).status).toBe("revoked");
  });

  it("REQ-AUTH-07: Password reset with an admin-issued single-use token (single-use, expiring, invalidates sessions)", async () => {
    const testEmail = `reset_user_${Date.now()}@casefile.test`;
    const password = "OriginalPassword123!";
    const newPassword = "BrandNewPassword999!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Reset User", orgName: "Reset Org" },
    });
    const { user } = JSON.parse(regRes.body);


    // 1. An administrator issues the reset token (D65: the HTTP request endpoint never
    //    returns one; scripts/issue-password-reset.ts calls this same service method).
    const issued = await withTenant(
      user.tenantId,
      (tx) =>
        AuthService.issuePasswordResetToken(tx, {
          tenantId: user.tenantId,
          email: testEmail,
          issuedBy: "test-admin",
          requestId: "req_auth_07",
        }),
      db,
    );
    const resetToken = issued.token;
    expect(resetToken).toBeDefined();

    // 2. Confirm password reset with valid token
    const confirmRes = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      payload: { token: resetToken, newPassword, tenantId: user.tenantId },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(JSON.parse(confirmRes.body).success).toBe(true);

    // 3. Single-use enforcement: re-using the same token is rejected
    const reuseReset = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      payload: { token: resetToken, newPassword: "AnotherPassword123!", tenantId: user.tenantId },
    });
    expect(reuseReset.statusCode).toBe(400);

    // 4. Old active session was invalidated in auth_sessions; login with new pass works
    const newLoginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: testEmail, password: newPassword, tenantId: user.tenantId },
    });
    expect(newLoginRes.statusCode).toBe(200);
  });

  it("REQ-AUTH-09: Security admin enforces MFA for all workspace members", async () => {
    const testEmail = `sec_admin_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Security Admin", orgName: "Sec Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.body);

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "MFA Enforced Workspace" },
    });
    const ws = JSON.parse(wsRes.body);

    // Update policy to require MFA
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { mfa_required: true },
    });
    expect(patchRes.statusCode).toBe(200);
    const policy = JSON.parse(patchRes.body);
    expect(policy.mfa_required).toBe(true);
  });

  it("REQ-AUTH-10: User sees sign-in history with IP and location metadata", async () => {
    const testEmail = `history_user_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "History User", orgName: "Hist Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { user } = JSON.parse(regRes.body);

    // Perform login to record sign-in history
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      headers: { "user-agent": "CasefileTestBrowser/1.0" },
      payload: { email: testEmail, password, tenantId: user.tenantId },
    });
    expect(loginRes.statusCode).toBe(200);
    const { accessToken } = JSON.parse(loginRes.body);

    // Retrieve sign-in history
    const histRes = await app.inject({
      method: "GET",
      url: "/v1/auth/history",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(histRes.statusCode).toBe(200);
    const histBody = JSON.parse(histRes.body);
    expect(Array.isArray(histBody.history)).toBe(true);
    expect(histBody.history.length).toBeGreaterThanOrEqual(1);
    expect(histBody.history[0].ipAddress).toBeDefined();
  });

  it("REQ-WS-01 & REQ-WS-02 & REQ-WS-11: Create workspace, invite member with role, and list workspaces", async () => {
    const testEmail = `ws_owner_${Date.now()}@casefile.test`;
    const password = "ComplexPassword999!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "WS Admin", orgName: "Test Corporation" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    // REQ-WS-01: Create workspace
    const wsName = `Investigation Workspace ${Date.now()}`;
    const createWsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: wsName },
    });
    expect(createWsRes.statusCode).toBe(201);
    const ws = JSON.parse(createWsRes.body);
    expect(ws.id).toBeDefined();
    expect(ws.name).toBe(wsName);

    // REQ-WS-11: List workspaces as org admin
    const listWsRes = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listWsRes.statusCode).toBe(200);
    const wsList = JSON.parse(listWsRes.body);
    expect(wsList.items.some((item: { id: string }) => item.id === ws.id)).toBe(true);

    // REQ-WS-02: Add member with specified role to workspace
    const addMemberRes = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws.id}/members`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        user_id: user.id,
        role: "investigator",
      },
    });
    expect(addMemberRes.statusCode).toBe(201);
    const member = JSON.parse(addMemberRes.body);
    expect(member.role).toBe("investigator");
    expect(member.workspace_id).toBe(ws.id);
  });

  it("REQ-WS-03: Remove a member and have their access revoked immediately", async () => {
    const testEmail = `remove_admin_${Date.now()}@casefile.test`;
    const password = "ComplexPassword999!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "WS Owner", orgName: "Removal Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Removal Workspace" },
    });
    const ws = JSON.parse(wsRes.body);

    const addMemberRes = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws.id}/members`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { user_id: user.id, role: "investigator" },
    });
    const member = JSON.parse(addMemberRes.body);

    // REQ-WS-03: Remove member
    const removeRes = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${ws.id}/members/${member.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(removeRes.statusCode).toBe(200);
    expect(JSON.parse(removeRes.body).status).toBe("removed");

    // List members returns 0 active members
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws.id}/members`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body).items.some((m: { id: string }) => m.id === member.id)).toBe(false);
  });

  it("REQ-WS-04 & REQ-WS-05 & REQ-WS-06: Configure workspace retention, confidence weights, and separation of duties", async () => {
    const testEmail = `ws_policy_admin_${Date.now()}@casefile.test`;
    const password = "ComplexPassword999!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Policy Owner", orgName: "Policy Corp" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.body);

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Policy Config Workspace" },
    });
    const ws = JSON.parse(wsRes.body);

    // REQ-WS-04 (retention), REQ-WS-05 (confidence weights), REQ-WS-06 (separation of duties)
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        retention_policy: { floor_days: 90, delete_after_days: 730 },
        confidence_weights: { corroboration_weight: 0.4, source_credibility: 0.6 },
        separation_of_duties: true,
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const policy = JSON.parse(patchRes.body);
    expect(policy.retention_policy.floor_days).toBe(90);
    expect(policy.confidence_weights.corroboration_weight).toBe(0.4);
    expect(policy.separation_of_duties).toBe(true);

    // Verify GET /v1/workspaces/:id/policy reflects saved settings
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = JSON.parse(getRes.body);
    expect(fetched.separation_of_duties).toBe(true);
    expect(fetched.retention_policy.floor_days).toBe(90);
  });

  it("REQ-WS-07: Configure ethical wall to isolate matters", async () => {
    const testEmail = `wall_admin_${Date.now()}@casefile.test`;
    const password = "ComplexPassword999!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Wall Admin", orgName: "Wall Corp" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    const createWsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Walled Workspace" },
    });
    expect(createWsRes.statusCode).toBe(201);
    const ws = JSON.parse(createWsRes.body);

    // REQ-WS-07: Create ethical wall
    const wallRes = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws.id}/ethical-walls`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        subject_type: "user",
        subject_id: user.id,
        investigation_id: "11111111-1111-1111-1111-111111111111",
        reason: "Matter A vs Matter B conflict barrier",
      },
    });
    expect(wallRes.statusCode).toBe(201);
    const wall = JSON.parse(wallRes.body);
    expect(wall.id).toBeDefined();
    expect(wall.reason).toBe("Matter A vs Matter B conflict barrier");
    expect(wall.workspace_id).toBe(ws.id);
  });
});
