import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { enforcePermission, evaluatePermission } from "@casefile/policy";
import { writeAuditEvent, verifyTenantAuditChain } from "@casefile/audit";
import { createSourceStorageKey, computeSha256 } from "@casefile/storage";
import { BreakGlassService } from "../src/services/break-glass.js";
import { buildApp } from "../src/app.js";

describe("apps/api — PRD §56 Acceptance Criteria Suite (E1)", () => {
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

  it("REQ-AC-SEC-01: Cross-tenant isolation returns 404 (never 403) to prevent existence leakage", async () => {
    // 1. Create Tenant A
    const regA = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `ten_a_${Date.now()}@casefile.test`, password: "Password123!", name: "Alice", orgName: "Tenant A" },
    });
    expect(regA.statusCode).toBe(201);
    const { accessToken: tokenA } = JSON.parse(regA.body);

    // 2. Create Tenant B with a workspace
    const regB = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `ten_b_${Date.now()}@casefile.test`, password: "Password123!", name: "Bob", orgName: "Tenant B" },
    });
    expect(regB.statusCode).toBe(201);
    const { accessToken: tokenB } = JSON.parse(regB.body);

    const wsBRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: "Secret B Workspace" },
    });
    const wsB = JSON.parse(wsBRes.body);

    // 3. User A attempts to access Tenant B's workspace
    const crossWsRes = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsB.id}/policy`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    // PRD §56.12 AC-SEC-01: Response must be 404 (never 403, which would confirm existence)
    expect(crossWsRes.statusCode).toBe(404);
    const errObj = JSON.parse(crossWsRes.body);
    expect(errObj.title).toBe("Not Found");
  });

  it("REQ-AC-SEC-02: Ethical wall overrides role permissions and blocks access", () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const investigationId = randomUUID();

    // User has workspace_admin role, but an ethical wall blocks them from investigationId
    const result = evaluatePermission({
      tenantId,
      userId,
      workspaceRole: "workspace_admin",
      investigationId,
      permission: "investigation.access",
      ethicalWalls: [{ userId, investigationId }],
    });

    // Ethical wall unconditionally overrides workspace_admin role (AC-SEC-02, §38.4)
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("ethical_wall");
  });

  it("REQ-AC-SEC-03: Audit log SHA-256 hash chaining verifies correctly across all events", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    await withTenant(tenantId, async (tx) => {
      await tx`
        INSERT INTO organizations (id, tenant_id, name)
        VALUES (${tenantId}, ${tenantId}, 'Audit Chain Org');
      `;

      // Write a sequence of 5 chained audit events
      for (let i = 1; i <= 5; i++) {
        await writeAuditEvent(tx, {
          tenantId,
          actorType: "user",
          actorId: userId,
          actorDisplay: "Test User",
          action: `action.test.${i}`,
          objectType: "workspace",
          objectId: randomUUID(),
          objectDisplay: `Workspace ${i}`,
          requestId: `req_${i}`,
          outcome: "success",
        });
      }

      // Verify cryptographic chain
      const res = await verifyTenantAuditChain(tx, tenantId);
      expect(res.valid).toBe(true);
      expect(res.verifiedCount).toBe(5);
    }, db);
  });

  it("REQ-AC-SEC-04: Audit log immutability blocks DELETE at data layer", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    await withTenant(tenantId, async (tx) => {
      await tx`
        INSERT INTO organizations (id, tenant_id, name)
        VALUES (${tenantId}, ${tenantId}, 'Audit Immutability Org');
      `;

      await writeAuditEvent(tx, {
        tenantId,
        actorType: "user",
        actorId: userId,
        actorDisplay: "Test User",
        action: "immutable.test",
        objectType: "document",
        objectId: randomUUID(),
        objectDisplay: "Doc 1",
        requestId: "req_immutability",
        outcome: "success",
      });
    }, db);

    // Attempt to delete the audit event at the database layer
    let deleteDenied = false;
    try {
      await withTenant(tenantId, async (tx) => {
        await tx`DELETE FROM audit_events WHERE tenant_id = ${tenantId};`;
      }, db);
    } catch (err) {
      deleteDenied = true;
      expect((err as Error).message).toMatch(/permission denied|immutable/i);
    }
    expect(deleteDenied).toBe(true);
  });

  it("REQ-AC-SEC-06: Permission denials write outcome: 'denied' audit events with reason", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();

    await withTenant(tenantId, async (tx) => {
      await tx`
        INSERT INTO organizations (id, tenant_id, name)
        VALUES (${tenantId}, ${tenantId}, 'Denial Audit Org');
      `;

      // Enforce permission with viewer role attempting workspace.manage
      let denied = false;
      try {
        await enforcePermission(tx, {
          tenantId,
          userId,
          workspaceRole: "viewer",
          permission: "workspace.manage",
          requestId: "req_denial_test",
        });
      } catch (err) {
        denied = true;
        expect((err as { code: string }).code).toBe("FORBIDDEN");
      }
      expect(denied).toBe(true);

      // Verify that audit event was recorded with outcome = 'denied'
      const auditRows = await tx<{ action: string; outcome: string; denial_reason: string }[]>`
        SELECT action, outcome, denial_reason
        FROM audit_events
        WHERE tenant_id = ${tenantId} AND outcome = 'denied'
        ORDER BY created_at DESC LIMIT 1;
      `;
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]!.outcome).toBe("denied");
      expect(auditRows[0]!.denial_reason).toBeDefined();
    }, db);
  });

  it("REQ-AC-SEC-05: Break-glass requires dual approval, is time-boxed, recorded in customer audit log, and notifies customer", async () => {
    const customerTenantId = randomUUID();
    const staffRequesterId = randomUUID();
    const staffApproverId = randomUUID();
    const targetStaffUserId = randomUUID();

    await withTenant(customerTenantId, async (tx) => {
      await tx`
        INSERT INTO organizations (id, tenant_id, name)
        VALUES (${customerTenantId}, ${customerTenantId}, 'Break Glass Customer Corp');
      `;

      // 1. Staff requester submits break-glass request
      const grant = await BreakGlassService.requestBreakGlass(tx, {
        tenantId: customerTenantId,
        staffUserId: targetStaffUserId,
        reason: "Investigating critical data sync ticket #4821",
        requestedBy: staffRequesterId,
        durationMinutes: 30,
      });
      expect(grant.status).toBe("pending");
      expect(grant.customer_notified).toBe(false);

      // 2. Dual-approval enforcement: Requester CANNOT approve their own request
      let selfApprovalError = false;
      try {
        await BreakGlassService.approveBreakGlass(tx, {
          grantId: grant.id,
          approvedBy: staffRequesterId,
          tenantId: customerTenantId,
        });
      } catch (err) {
        selfApprovalError = true;
        expect((err as { code: string }).code).toBe("DUAL_APPROVAL_REQUIRED");
      }
      expect(selfApprovalError).toBe(true);

      // 3. Second staff member approves (Dual-approval succeeds)
      const approvedGrant = await BreakGlassService.approveBreakGlass(tx, {
        grantId: grant.id,
        approvedBy: staffApproverId,
        tenantId: customerTenantId,
      });
      expect(approvedGrant.status).toBe("approved");
      expect(approvedGrant.customer_notified).toBe(true);
      expect(approvedGrant.expires_at).toBeDefined();
      expect(approvedGrant.session_recording_id).toBeDefined();

      // 4. Validate and record staff data access (appears in customer's audit log)
      const accessRes = await BreakGlassService.validateAndRecordAccess(tx, {
        grantId: grant.id,
        staffUserId: targetStaffUserId,
        tenantId: customerTenantId,
        targetResource: "investigations/inv_secret",
      });
      expect(accessRes.valid).toBe(true);

      // 5. Verify customer's audit log contains break-glass and staff access entries
      const auditLog = await tx<{ action: string; actor_id: string; outcome: string }[]>`
        SELECT action, actor_id, outcome
        FROM audit_events
        WHERE tenant_id = ${customerTenantId}
        ORDER BY seq ASC;
      `;
      const actions = auditLog.map((a) => a.action);
      expect(actions).toContain("break_glass_access_granted");
      expect(actions).toContain("staff_data_access");

      // 6. Cryptographic audit chain verification passes with break-glass events
      const chainCheck = await verifyTenantAuditChain(tx, customerTenantId);
      expect(chainCheck.valid).toBe(true);
      expect(chainCheck.verifiedCount).toBe(2);
    }, db);
  });

  it("REQ-AC-ING-02: Source storage keys enforce content-addressed layout <tenant>/<investigation>/sources/<sha256>", () => {
    const tenantId = "tenant-uuid-123";
    const investigationId = "investigation-uuid-456";
    const rawBytes = new TextEncoder().encode("Important investigative contract content");
    const expectedSha = computeSha256(rawBytes);

    const storageKey = createSourceStorageKey(tenantId, investigationId, rawBytes);
    expect(storageKey).toBe(`${tenantId}/${investigationId}/sources/${expectedSha}`);
  });
});
