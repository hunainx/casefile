import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { enforcePermission } from "@casefile/policy";
import { verifyTenantAuditChain } from "@casefile/audit";
import { BreakGlassService } from "../src/services/break-glass.js";
import { nextTotpCode } from "./helpers/totp.js";
import { enrolTotpThroughSetupLink } from "./helpers/setup-link.js";
import { buildApp } from "../src/app.js";

describe("apps/api — Security User Stories Integration Suite (REQ-SEC-01..10)", () => {
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

  it("REQ-SEC-01: Security admin sees permission denials in audit log to spot probing", async () => {
    // 1. Register organization and security admin user
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `sec_admin_${Date.now()}@casefile.test`,
        password: "Password123!",
        name: "Security Admin",
        orgName: "Security Org",
      },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    // 2. Create workspace
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Probing Monitor WS" },
    });
    expect(wsRes.statusCode).toBe(201);

    // 3. Simulate unauthorized probing attempts by a viewer user
    const probeUserId = randomUUID();
    await withTenant(user.tenantId, async (tx) => {
      // Simulate 3 unauthorized attempts
      for (const forbiddenPerm of ["workspace.policy", "workspace.manage", "system.admin"]) {
        try {
          await enforcePermission(tx, {
            tenantId: user.tenantId,
            userId: probeUserId,
            workspaceRole: "viewer",
            permission: forbiddenPerm,
            requestId: `probe_${forbiddenPerm}`,
          });
        } catch {
          // Expected permission denial
        }
      }
    }, db);

    // 4. Enrol TOTP (only through the admin-issued one-time link, D71) and perform step-up
    // re-authentication to query sensitive audit logs (D51)
    const { secret } = await enrolTotpThroughSetupLink(app, db, { tenantId: user.tenantId, email: user.email, password: "Password123!" });

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: user.email, password: "Password123!", tenantId: user.tenantId },
    });
    expect(login.statusCode).toBe(200);
    const verifyMfa = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      payload: {
        challengeToken: JSON.parse(login.body).challengeToken,
        userId: user.id,
        tenantId: user.tenantId,
        totpCode: await nextTotpCode(secret),
      },
    });
    expect(verifyMfa.statusCode).toBe(200);

    const stepUpRes = await app.inject({
      method: "POST",
      url: "/v1/auth/step-up",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        totpCode: await nextTotpCode(secret),
      },
    });
    expect(stepUpRes.statusCode).toBe(200);
    const { accessToken: stepUpToken } = JSON.parse(stepUpRes.body);

    // 5. Security admin queries audit events for denials
    const auditRes = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: { authorization: `Bearer ${stepUpToken}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const body = JSON.parse(auditRes.body);
    const auditEvents = body.items || body;

    // Find recorded denials
    const denials = auditEvents.filter((e: { outcome: string }) => e.outcome === "denied");
    expect(denials.length).toBeGreaterThanOrEqual(3);
    for (const denial of denials) {
      expect(denial.outcome).toBe("denied");
      expect(denial.denial_reason).toBeDefined();
    }
  });

  it("REQ-SEC-05: Cross-tenant access attempt returns 404 (never 403) and leaves tenant data isolated", async () => {
    // 1. Create Tenant Alpha
    const regAlpha = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `alpha_${Date.now()}@casefile.test`,
        password: "Password123!",
        name: "Alpha User",
        orgName: "Alpha Corp",
      },
    });
    const { accessToken: tokenAlpha } = JSON.parse(regAlpha.body);

    // 2. Create Tenant Beta with confidential workspace
    const regBeta = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `beta_${Date.now()}@casefile.test`,
        password: "Password123!",
        name: "Beta User",
        orgName: "Beta Corp",
      },
    });
    const { accessToken: tokenBeta } = JSON.parse(regBeta.body);

    const wsBetaRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${tokenBeta}` },
      payload: { name: "Confidential Beta Matter" },
    });
    const wsBeta = JSON.parse(wsBetaRes.body);

    // 3. User Alpha attempts cross-tenant probing of Beta workspace
    const probeRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsBeta.id}/policy`,
      headers: { authorization: `Bearer ${tokenAlpha}` },
    });

    // Must return 404 Not Found (never 403) to prevent existence leakage
    expect(probeRes.statusCode).toBe(404);
  });

  it("REQ-SEC-06 & REQ-SEC-07: Break-glass access is time-boxed, dual-approved, recorded, and customer-visible in own audit log", async () => {
    const customerTenantId = randomUUID();
    const staffRequesterId = randomUUID();
    const staffApproverId = randomUUID();
    const targetStaffUserId = randomUUID();

    await withTenant(customerTenantId, async (tx) => {
      await tx`
        INSERT INTO organizations (id, tenant_id, name)
        VALUES (${customerTenantId}, ${customerTenantId}, 'SEC-06 Customer Org');
      `;

      // 1. Submit break-glass request
      const grant = await BreakGlassService.requestBreakGlass(tx, {
        tenantId: customerTenantId,
        staffUserId: targetStaffUserId,
        reason: "Customer support ticket #7109 data recovery",
        requestedBy: staffRequesterId,
        durationMinutes: 45,
      });
      expect(grant.status).toBe("pending");

      // 2. Dual approval requirement: Requestor cannot self-approve
      await expect(
        BreakGlassService.approveBreakGlass(tx, {
          grantId: grant.id,
          approvedBy: staffRequesterId,
          tenantId: customerTenantId,
        }),
      ).rejects.toThrow(/dual approval/i);

      // 3. Distinct second staff member approves
      const approved = await BreakGlassService.approveBreakGlass(tx, {
        grantId: grant.id,
        approvedBy: staffApproverId,
        tenantId: customerTenantId,
      });
      expect(approved.status).toBe("approved");
      expect(approved.customer_notified).toBe(true);
      expect(approved.session_recording_id).toBeDefined();

      // 4. Staff accesses customer resource during approved time-box
      const access = await BreakGlassService.validateAndRecordAccess(tx, {
        grantId: grant.id,
        staffUserId: targetStaffUserId,
        tenantId: customerTenantId,
        targetResource: "Matter #99 Archive",
      });
      expect(access.valid).toBe(true);

      // 5. Customer verifies that staff access appears in customer's own audit log (SEC-07)
      const auditRows = await tx<{ action: string; actor_display: string }[]>`
        SELECT action, actor_display
        FROM audit_events
        WHERE tenant_id = ${customerTenantId}
        ORDER BY seq ASC;
      `;
      expect(auditRows.some((r) => r.action === "break_glass_access_granted")).toBe(true);
      expect(auditRows.some((r) => r.action === "staff_data_access")).toBe(true);

      // 6. Cryptographic audit chain passes
      const chain = await verifyTenantAuditChain(tx, customerTenantId);
      expect(chain.valid).toBe(true);
    }, db);
  });

  it("REQ-SEC-09: Workspace admin configures separation of duties on workspace policy", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `sec_admin_duties_${Date.now()}@casefile.test`,
        password: "Password123!",
        name: "Security Admin",
        orgName: "Duties Org",
      },
    });
    const { accessToken } = JSON.parse(regRes.body);

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Dual Approval Matter" },
    });
    const ws = JSON.parse(wsRes.body);

    // Update policy to require separation of duties (second approver)
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        separation_of_duties: true,
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const policy = JSON.parse(patchRes.body);
    expect(policy.separation_of_duties).toBe(true);

    // Verify GET reflects separation of duties
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).separation_of_duties).toBe(true);
  });

  it("REQ-SEC-10: Workspace admin pins AI provider or requires self-hosted models for compliance", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `sec_admin_ai_${Date.now()}@casefile.test`,
        password: "Password123!",
        name: "Compliance Admin",
        orgName: "Compliance Org",
      },
    });
    const { accessToken } = JSON.parse(regRes.body);

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Regulated Healthcare Investigation" },
    });
    const ws = JSON.parse(wsRes.body);

    // Pin model provider to self-hosted / compliance-approved provider
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        model_policy: {
          pinned_provider: "anthropic",
          self_hosted_only: true,
          zero_retention_required: true,
        },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const policy = JSON.parse(patchRes.body);
    expect(policy.model_policy.pinned_provider).toBe("anthropic");
    expect(policy.model_policy.self_hosted_only).toBe(true);

    // Verify GET reflects model policy
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws.id}/policy`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).model_policy.pinned_provider).toBe("anthropic");
  });
});
