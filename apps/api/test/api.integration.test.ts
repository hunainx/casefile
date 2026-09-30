import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";
import { nextTotpCode } from "./helpers/totp.js";
import { enrolTotpThroughSetupLink } from "./helpers/setup-link.js";
import {
  AuthTokenResponseSchema,
  MeResponseSchema,
  OrganizationSchema,
  WorkspaceSchema,
  WorkspaceMemberSchema,
  WorkspacePolicySchema,
  ProblemDetailsSchema,
} from "@casefile/contracts";

describe("apps/api — Integration & Security Pipeline Tests", () => {
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

  it("GET /health, /ready, and /healthz return 200 OK", async () => {
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(JSON.parse(healthRes.body).status).toBe("ok");

    const readyRes = await app.inject({ method: "GET", url: "/ready" });
    expect(readyRes.statusCode).toBe(200);
    expect(JSON.parse(readyRes.body).database).toBe("connected");

    const healthzRes = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthzRes.statusCode).toBe(200);
    expect(JSON.parse(healthzRes.body).status).toBe("ok");
    expect(JSON.parse(healthzRes.body).database).toBe("connected");
  });

  it("GET /healthz returns 503 when database round-trip fails", async () => {
    // A real client pointed at a local port nothing listens on: every round trip fails.
    const brokenDb = postgres({
      host: "127.0.0.1",
      port: 1,
      database: "unreachable",
      username: "unreachable",
      max: 1,
      connect_timeout: 2,
    });
    const brokenApp = buildApp({ db: brokenDb, logger: false });
    await brokenApp.ready();
    const res = await brokenApp.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("unhealthy");
    await brokenApp.close();
    await brokenDb.end({ timeout: 1 });
  });

  // §45.2 REQ-API-POST-V1-AUTH-TOKEN
  it("REQ-API-POST-V1-AUTH-TOKEN: POST /v1/auth/token exchange credentials, matches OpenAPI schema, returns RFC 9457 error on failure", async () => {
    const testEmail = `token_user_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Token User", orgName: "Token Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { user } = JSON.parse(regRes.body);

    // 1. Valid token exchange (returns 200 and matches AuthTokenResponseSchema)
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: testEmail, password, tenantId: user.tenantId },
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokenData = JSON.parse(tokenRes.body);
    const parsed = AuthTokenResponseSchema.parse(tokenData);
    expect(parsed.accessToken).toBeDefined();
    expect(parsed.tokenType).toBe("Bearer");

    // 2. Invalid credentials (returns 401 Problem Details)
    const failRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: testEmail, password: "WrongPassword!", tenantId: user.tenantId },
    });
    expect(failRes.statusCode).toBe(401);
    const failProblem = ProblemDetailsSchema.parse(JSON.parse(failRes.body));
    expect(failProblem.status).toBe(401);
  });

  // §45.2 REQ-API-POST-V1-AUTH-REFRESH
  it("REQ-API-POST-V1-AUTH-REFRESH: POST /v1/auth/refresh rotates token, enforces reuse detection and RFC 9457 error", async () => {
    const testEmail = `refresh_user_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Refresh User", orgName: "Refresh Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { refreshToken } = JSON.parse(regRes.body);

    // 1. Rotation succeeds
    const rotRes = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(rotRes.statusCode).toBe(200);
    const rotData = JSON.parse(rotRes.body);
    const parsed = AuthTokenResponseSchema.parse(rotData);
    expect(parsed.refreshToken).toBeDefined();

    // 2. Token reuse attempt triggers revocation and returns 401 Problem Details
    const reuseRes = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(reuseRes.statusCode).toBe(401);
    const prob = ProblemDetailsSchema.parse(JSON.parse(reuseRes.body));
    expect(prob.status).toBe(401);
  });

  // §45.2 REQ-API-GET-V1-ME
  it("REQ-API-GET-V1-ME: GET /v1/me returns authenticated user profile and enforces authentication", async () => {
    const testEmail = `me_user_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Me User", orgName: "Me Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    // 1. Authenticated GET /v1/me matches MeResponseSchema
    const meRes = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const meData = JSON.parse(meRes.body);
    const parsed = MeResponseSchema.parse(meData);
    expect(parsed.id).toBe(user.id);
    expect(parsed.email).toBe(testEmail);

    // 2. Unauthenticated request returns 401 Problem Details
    const unauthRes = await app.inject({
      method: "GET",
      url: "/v1/me",
    });
    expect(unauthRes.statusCode).toBe(401);
    const prob = ProblemDetailsSchema.parse(JSON.parse(unauthRes.body));
    expect(prob.status).toBe(401);
  });

  // §45.2 REQ-API-GET-V1-ORGANIZATIONS-ID
  it("REQ-API-GET-V1-ORGANIZATIONS-ID: GET /v1/organizations/:id returns organization details with tenant isolation", async () => {
    const testEmail = `org_user_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Org User", orgName: "Target Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    // 1. Fetch own org
    const orgRes = await app.inject({
      method: "GET",
      url: `/v1/organizations/${user.tenantId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(orgRes.statusCode).toBe(200);
    const orgData = JSON.parse(orgRes.body);
    const parsed = OrganizationSchema.parse(orgData);
    expect(parsed.id).toBe(user.tenantId);

    // 2. Non-existent / foreign org returns 404 Problem Details
    const foreignRes = await app.inject({
      method: "GET",
      url: "/v1/organizations/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(foreignRes.statusCode).toBe(404);
    const prob = ProblemDetailsSchema.parse(JSON.parse(foreignRes.body));
    expect(prob.status).toBe(404);
  });

  // §45.2 REQ-API-GET-V1-WORKSPACES & REQ-API-POST-V1-WORKSPACES
  it("REQ-API-GET-V1-WORKSPACES & REQ-API-POST-V1-WORKSPACES: List and create workspaces with schema validation and permission enforcement", async () => {
    const testEmail = `ws_crud_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "WS Admin", orgName: "WS Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.body);

    // 1. POST /v1/workspaces (REQ-API-POST-V1-WORKSPACES)
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Engineering Matters" },
    });
    expect(createRes.statusCode).toBe(201);
    const ws = WorkspaceSchema.parse(JSON.parse(createRes.body));
    expect(ws.name).toBe("Engineering Matters");

    // 2. GET /v1/workspaces (REQ-API-GET-V1-WORKSPACES)
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listData = JSON.parse(listRes.body);
    expect(listData.items.some((w: { id: string }) => w.id === ws.id)).toBe(true);
  });

  // §45.2 REQ-API-GET-V1-WORKSPACES-ID-MEMBERS & REQ-API-POST-V1-WORKSPACES-ID-MEMBERS
  it("REQ-API-GET-V1-WORKSPACES-ID-MEMBERS & REQ-API-POST-V1-WORKSPACES-ID-MEMBERS: Add and list workspace members with permission and schema validation", async () => {
    const testEmail = `ws_mem_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "WS Mem Admin", orgName: "Mem Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Member Workspace" },
    });
    const ws = JSON.parse(wsRes.body);

    // 1. POST /v1/workspaces/:id/members (REQ-API-POST-V1-WORKSPACES-ID-MEMBERS)
    const addMemRes = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws.id}/members`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { user_id: user.id, role: "reviewer" },
    });
    expect(addMemRes.statusCode).toBe(201);
    const member = WorkspaceMemberSchema.parse(JSON.parse(addMemRes.body));
    expect(member.role).toBe("reviewer");

    // 2. GET /v1/workspaces/:id/members (REQ-API-GET-V1-WORKSPACES-ID-MEMBERS)
    const listMemRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws.id}/members`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listMemRes.statusCode).toBe(200);
    const memList = JSON.parse(listMemRes.body);
    expect(memList.items.some((m: { id: string }) => m.id === member.id)).toBe(true);
  });

  // §45.2 REQ-API-GET-V1-WORKSPACES-ID-POLICY & REQ-API-PATCH-V1-WORKSPACES-ID-POLICY
  it("REQ-API-GET-V1-WORKSPACES-ID-POLICY & REQ-API-PATCH-V1-WORKSPACES-ID-POLICY: Get and update workspace policy with schema validation", async () => {
    const testEmail = `ws_pol_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Policy Admin", orgName: "Policy Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.body);

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Policy Workspace" },
    });
    const ws = JSON.parse(wsRes.body);

    // 1. GET /v1/workspaces/:id/policy (REQ-API-GET-V1-WORKSPACES-ID-POLICY)
    const getPolRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getPolRes.statusCode).toBe(200);
    const policy = WorkspacePolicySchema.parse(JSON.parse(getPolRes.body));
    expect(policy.workspace_id).toBe(ws.id);

    // 2. PATCH /v1/workspaces/:id/policy (REQ-API-PATCH-V1-WORKSPACES-ID-POLICY)
    const patchPolRes = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        separation_of_duties: true,
        mfa_required: true,
        retention_policy: { floor_days: 90, delete_after_days: 365 },
        confidence_weights: { source_credibility: 0.8 },
      },
    });
    expect(patchPolRes.statusCode).toBe(200);
    const updatedPolicy = WorkspacePolicySchema.parse(JSON.parse(patchPolRes.body));
    expect(updatedPolicy.separation_of_duties).toBe(true);
    expect(updatedPolicy.mfa_required).toBe(true);
  });

  it("step-up MFA required for ⚠ high-risk actions (D51)", async () => {
    const testEmail = `stepup_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "StepUp User", orgName: "Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.body);

    // 1. Calling high-risk endpoint without step-up MFA throws 403 STEP_UP_MFA_REQUIRED
    const nonStepUpRes = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(nonStepUpRes.statusCode).toBe(403);
    expect(JSON.parse(nonStepUpRes.body).type).toContain("step-up-mfa-required");

    // Enrol TOTP through the admin-issued one-time link (D71)
    const { secret } = await enrolTotpThroughSetupLink(app, db, { tenantId: JSON.parse(regRes.body).user.tenantId, email: testEmail, password });

    const otp = await nextTotpCode(secret);

    // 2. Perform step-up MFA challenge
    const stepUpRes = await app.inject({
      method: "POST",
      url: "/v1/auth/step-up",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { totpCode: otp },
    });
    expect(stepUpRes.statusCode).toBe(200);
    const { accessToken: stepUpToken } = JSON.parse(stepUpRes.body);

    // 3. High-risk endpoint succeeds with fresh step-up token
    const stepUpSuccessRes = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: { authorization: `Bearer ${stepUpToken}` },
    });
    expect(stepUpSuccessRes.statusCode).toBe(200);
  });

  it("enforces cursor pagination and Idempotency-Key caching", async () => {
    const testEmail = `idemp_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Idemp User", orgName: "Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.body);

    const idempotencyKey = `key_${Date.now()}`;

    // Mutating POST with Idempotency-Key
    const createWs1 = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "idempotency-key": idempotencyKey,
      },
      payload: { name: "Idempotent Workspace" },
    });
    expect(createWs1.statusCode).toBe(201);
    const wsData = JSON.parse(createWs1.body);

    // Replayed POST returns cached response
    const createWs2 = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "idempotency-key": idempotencyKey,
      },
      payload: { name: "Idempotent Workspace" },
    });
    expect(createWs2.statusCode).toBe(201);
    expect(JSON.parse(createWs2.body).id).toBe(wsData.id);

    // List with cursor pagination
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/workspaces?limit=1",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listData = JSON.parse(listRes.body);
    expect(listData.items.length).toBe(1);
  });

  // §45.2 REQ-API-GET-V1-AUDIT-EVENTS & REQ-API-POST-V1-AUDIT-EXPORT & REQ-M-AUDIT-009
  it("REQ-API-GET-V1-AUDIT-EVENTS & REQ-API-POST-V1-AUDIT-EXPORT: Query and export audit events with step-up verification and export auditing", async () => {
    const testEmail = `audit_export_${Date.now()}@casefile.test`;
    const password = "Password123!";

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmail, password, name: "Audit Lead", orgName: "Audit Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const { user } = JSON.parse(regRes.body);

    // Enrol TOTP through the admin-issued one-time link (D71)
    const { secret } = await enrolTotpThroughSetupLink(app, db, { tenantId: user.tenantId, email: testEmail, password });

    // Sign in: password, then the TOTP challenge, completed with the password step's challenge token (D75)
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: testEmail, password, tenantId: user.tenantId },
    });
    expect(login.statusCode).toBe(200);
    const { challengeToken } = JSON.parse(login.body);
    const mfaVerifyRes = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      payload: {
        challengeToken,
        userId: user.id,
        tenantId: user.tenantId,
        totpCode: await nextTotpCode(secret),
      },
    });
    expect(mfaVerifyRes.statusCode).toBe(200);
    const { accessToken: mfaToken } = JSON.parse(mfaVerifyRes.body);

    // Step-up verification (D51)
    const stepUpRes = await app.inject({
      method: "POST",
      url: "/v1/auth/step-up",
      headers: { authorization: `Bearer ${mfaToken}` },
      // A code is accepted once (D75): step-up needs the next one.
      payload: { totpCode: await nextTotpCode(secret) },
    });
    expect(stepUpRes.statusCode).toBe(200);
    const { accessToken: stepUpToken } = JSON.parse(stepUpRes.body);

    // 1. Create a workspace to generate audit activity
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${stepUpToken}` },
      payload: { name: "Audit Test WS" },
    });
    expect(wsRes.statusCode).toBe(201);

    // 2. GET /v1/audit/events (REQ-API-GET-V1-AUDIT-EVENTS)
    const listAuditRes = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: { authorization: `Bearer ${stepUpToken}` },
    });
    expect(listAuditRes.statusCode).toBe(200);
    const auditData = JSON.parse(listAuditRes.body);
    expect(Array.isArray(auditData.items)).toBe(true);
    expect(auditData.items.length).toBeGreaterThan(0);

    // 3. POST /v1/audit/export (REQ-API-POST-V1-AUDIT-EXPORT) - JSON format
    const exportJsonRes = await app.inject({
      method: "POST",
      url: "/v1/audit/export",
      headers: { authorization: `Bearer ${stepUpToken}` },
      payload: { format: "json" },
    });
    expect(exportJsonRes.statusCode).toBe(200);
    const jsonExport = JSON.parse(exportJsonRes.body);
    expect(jsonExport.format).toBe("json");
    expect(jsonExport.record_count).toBeGreaterThan(0);
    expect(Array.isArray(jsonExport.data)).toBe(true);

    // 3. POST /v1/audit/export - CSV format
    const exportCsvRes = await app.inject({
      method: "POST",
      url: "/v1/audit/export",
      headers: { authorization: `Bearer ${stepUpToken}` },
      payload: { format: "csv" },
    });
    expect(exportCsvRes.statusCode).toBe(200);
    const csvExport = JSON.parse(exportCsvRes.body);
    expect(csvExport.format).toBe("csv");
    expect(csvExport.data).toContain("id,seq,timestamp,action,actor_id,outcome");

    // 4. REQ-M-AUDIT-009: Verify that exporting audit events emitted an audit event
    const afterExportAuditRes = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: { authorization: `Bearer ${stepUpToken}` },
    });
    const eventsAfter = JSON.parse(afterExportAuditRes.body).items;
    const exportEvent = eventsAfter.find((e: { action: string }) => e.action === "audit.export");
    expect(exportEvent).toBeDefined();
    expect(exportEvent.actor_id).toBe(user.id);
  });
});

