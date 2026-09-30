import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { verifyTenantAuditChain } from "@casefile/audit";
import {
  evaluateAndAudit,
  enforcePermission,
  PermissionDeniedError,
  type AuthContext,
} from "../src/index.js";

describe("packages/policy — Policy & Denial Audit Integration Tests", () => {
  let appDb: postgres.Sql;

  beforeAll(async () => {
    appDb = createDbClient(getDbUrl());
  });

  afterAll(async () => {
    if (appDb) {
      await appDb.end();
    }
  });

  async function seedTenant(tenantId: string) {
    await withTenant(
      tenantId,
      async (tx) => {
        await tx`
          INSERT INTO organizations (id, tenant_id, name)
          VALUES (${tenantId}, ${tenantId}, 'Policy Integration Tenant')
          ON CONFLICT (id) DO NOTHING;
        `;
      },
      appDb,
    );
  }

  it("writes an audit_events row with outcome 'denied' when permission is denied", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const requestId = "req_denial_audit_1";
    await seedTenant(tenantId);

    const ctx: AuthContext = {
      tenantId,
      userId,
      permission: "evidence.create",
      workspaceRole: "viewer", // viewer cannot create evidence
      requestId,
      targetObjectId: randomUUID(),
      targetObjectType: "evidence",
    };

    await withTenant(
      tenantId,
      async (tx) => {
        const res = await evaluateAndAudit(tx, ctx);
        expect(res.allowed).toBe(false);
        expect(res.outcome).toBe("deny");
        expect(res.reason).toBe("role_permission_denied");
      },
      appDb,
    );

    // Verify audit_events row persisted with exact denial attributes
    await withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx<{
          outcome: string;
          actor_id: string;
          action: string;
          denial_reason: string;
          request_id: string;
          seq: number;
        }[]>`
          SELECT outcome, actor_id, action, denial_reason, request_id, seq
          FROM audit_events
          WHERE tenant_id = ${tenantId} AND request_id = ${requestId};
        `;

        expect(rows.length).toBe(1);
        const row = rows[0]!;
        expect(row.outcome).toBe("denied");
        expect(row.actor_id).toBe(userId);
        expect(row.action).toBe("auth.deny:evidence.create");
        expect(row.denial_reason).toBe("role_permission_denied");
        expect(row.request_id).toBe(requestId);
        expect(Number(row.seq)).toBe(1);

        // Verify chain integrity after denial write
        const chainRes = await verifyTenantAuditChain(tx, tenantId);
        expect(chainRes.valid).toBe(true);
        expect(chainRes.verifiedCount).toBe(1);
      },
      appDb,
    );
  });

  it("audits denial for ethical wall violations", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const invId = randomUUID();
    const requestId = "req_wall_audit_1";
    await seedTenant(tenantId);

    const ctx: AuthContext = {
      tenantId,
      userId,
      permission: "investigation.read",
      workspaceRole: "ws_admin",
      investigationId: invId,
      ethicalWalls: [
        {
          userId,
          investigationId: invId,
        },
      ],
      requestId,
    };

    await withTenant(
      tenantId,
      async (tx) => {
        const res = await evaluateAndAudit(tx, ctx);
        expect(res.allowed).toBe(false);
        expect(res.reason).toBe("ethical_wall");
      },
      appDb,
    );

    await withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx<{ outcome: string; denial_reason: string }[]>`
          SELECT outcome, denial_reason
          FROM audit_events
          WHERE tenant_id = ${tenantId} AND request_id = ${requestId};
        `;
        expect(rows.length).toBe(1);
        expect(rows[0]!.outcome).toBe("denied");
        expect(rows[0]!.denial_reason).toBe("ethical_wall");
      },
      appDb,
    );
  });

  it("response does not reveal whether target object exists (REQ-M-AUDIT-006)", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await seedTenant(tenantId);

    const existingObjectId = randomUUID();
    // Seed real workspace
    await withTenant(
      tenantId,
      async (tx) => {
        await tx`
          INSERT INTO workspaces (id, tenant_id, name)
          VALUES (${existingObjectId}, ${tenantId}, 'Existing WS')
          ON CONFLICT (id) DO NOTHING;
        `;
      },
      appDb,
    );

    const nonExistentObjectId = randomUUID();

    let errExisting: PermissionDeniedError | null = null;
    let errNonExistent: PermissionDeniedError | null = null;

    // Probe 1: Unauthorized user attempts action on existing object
    try {
      await withTenant(
        tenantId,
        async (tx) => {
          await enforcePermission(tx, {
            tenantId,
            userId,
            permission: "workspace.manage",
            workspaceRole: "viewer",
            targetObjectId: existingObjectId,
            targetObjectType: "workspace",
            requestId: "req_probe_existing",
          });
        },
        appDb,
      );
    } catch (e) {
      errExisting = e as PermissionDeniedError;
    }

    // Probe 2: Unauthorized user attempts action on non-existent object
    try {
      await withTenant(
        tenantId,
        async (tx) => {
          await enforcePermission(tx, {
            tenantId,
            userId,
            permission: "workspace.manage",
            workspaceRole: "viewer",
            targetObjectId: nonExistentObjectId,
            targetObjectType: "workspace",
            requestId: "req_probe_nonexistent",
          });
        },
        appDb,
      );
    } catch (e) {
      errNonExistent = e as PermissionDeniedError;
    }

    // Assert both errors are completely indistinguishable
    expect(errExisting).not.toBeNull();
    expect(errNonExistent).not.toBeNull();
    expect(errExisting!.name).toBe("PermissionDeniedError");
    expect(errNonExistent!.name).toBe("PermissionDeniedError");
    expect(errExisting!.message).toBe("Access denied");
    expect(errNonExistent!.message).toBe("Access denied");
    expect(errExisting!.code).toBe("FORBIDDEN");
    expect(errNonExistent!.code).toBe("FORBIDDEN");
    expect(errExisting!.status).toBe(403);
    expect(errNonExistent!.status).toBe(403);
    expect(errExisting!.reason).toBe(errNonExistent!.reason);
  });

  it("audit writes happen in the same transaction as guarded operation", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const requestId = "req_tx_fail";
    await seedTenant(tenantId);

    // Rollback test: if the transaction rolls back, audit row is rolled back too
    try {
      await withTenant(
        tenantId,
        async (tx) => {
          await evaluateAndAudit(tx, {
            tenantId,
            userId,
            permission: "org.manage",
            workspaceRole: "ws_admin", // denied
            requestId,
          });

          // Business failure / rollback
          throw new Error("Guarded transaction aborted");
        },
        appDb,
      );
    } catch (err: unknown) {
      expect((err as Error).message).toBe("Guarded transaction aborted");
    }

    // Verify rolled back audit event was not committed
    await withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx`SELECT id FROM audit_events WHERE request_id = ${requestId};`;
        expect(rows.length).toBe(0);
      },
      appDb,
    );
  });
});
