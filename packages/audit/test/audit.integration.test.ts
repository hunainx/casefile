import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { writeAuditEvent, verifyTenantAuditChain, GENESIS_HASH } from "../src/index.js";

describe("packages/audit — Integration Tests", () => {
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
          VALUES (${tenantId}, ${tenantId}, 'Audit Integration Tenant')
          ON CONFLICT (id) DO NOTHING;
        `;
      },
      appDb,
    );
  }

  it("writes hash-chained audit events inside transactions", async () => {
    const tenantId = randomUUID();
    await seedTenant(tenantId);

    let ev1Hash = "";
    await withTenant(
      tenantId,
      async (tx) => {
        const ev1 = await writeAuditEvent(tx, {
          tenantId,
          actorType: "user",
          actorId: "11111111-1111-1111-1111-111111111111",
          actorDisplay: "Alice",
          action: "workspace.create",
          objectType: "workspace",
          objectId: "22222222-2222-2222-2222-222222222222",
          objectDisplay: "WS1",
          requestId: "req_audit_1",
          outcome: "success",
        });

        expect(ev1.prev_hash).toBe(GENESIS_HASH);
        expect(ev1.hash).toHaveLength(64);
        ev1Hash = ev1.hash;

        const ev2 = await writeAuditEvent(tx, {
          tenantId,
          actorType: "user",
          actorId: "11111111-1111-1111-1111-111111111111",
          actorDisplay: "Alice",
          action: "source.admit",
          objectType: "source",
          objectId: "33333333-3333-3333-3333-333333333333",
          objectDisplay: "Source1",
          requestId: "req_audit_2",
          outcome: "success",
        });

        expect(ev2.prev_hash).toBe(ev1Hash);
        expect(ev2.hash).toHaveLength(64);
      },
      appDb,
    );

    // Verify tenant chain via verifier
    await withTenant(
      tenantId,
      async (tx) => {
        const res = await verifyTenantAuditChain(tx, tenantId);
        expect(res.valid).toBe(true);
        expect(res.verifiedCount).toBe(2);
      },
      appDb,
    );
  });

  it("rolls back audit write when enclosing transaction fails", async () => {
    const tenantId = randomUUID();
    await seedTenant(tenantId);
    const actionName = "transaction.failed.action";

    try {
      await withTenant(
        tenantId,
        async (tx) => {
          await writeAuditEvent(tx, {
            tenantId,
            actorType: "user",
            actorId: "11111111-1111-1111-1111-111111111111",
            actorDisplay: "Alice",
            action: actionName,
            objectType: "workspace",
            objectId: "44444444-4444-4444-4444-444444444444",
            objectDisplay: "WS_FAIL",
            requestId: "req_audit_fail",
            outcome: "success",
          });

          // Business logic failure
          throw new Error("Business logic transaction error");
        },
        appDb,
      );
    } catch (err: unknown) {
      expect((err as Error).message).toBe("Business logic transaction error");
    }

    // Verify the rolled back audit event was NOT persisted
    await withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM audit_events WHERE action = ${actionName} AND tenant_id = ${tenantId};
        `;
        expect(rows.length).toBe(0);
      },
      appDb,
    );
  });

  it("detects tail truncation when latest event is missing from database", async () => {
    const tenantId = randomUUID();
    await seedTenant(tenantId);

    let ev2Id = "";
    await withTenant(
      tenantId,
      async (tx) => {
        await writeAuditEvent(tx, {
          tenantId,
          actorType: "user",
          actorId: "11111111-1111-1111-1111-111111111111",
          actorDisplay: "Alice",
          action: "workspace.create",
          objectType: "workspace",
          objectId: "22222222-2222-2222-2222-222222222222",
          objectDisplay: "WS1",
          requestId: "req_audit_1",
          outcome: "success",
        });

        const ev2 = await writeAuditEvent(tx, {
          tenantId,
          actorType: "user",
          actorId: "11111111-1111-1111-1111-111111111111",
          actorDisplay: "Alice",
          action: "source.admit",
          objectType: "source",
          objectId: "33333333-3333-3333-3333-333333333333",
          objectDisplay: "Source1",
          requestId: "req_audit_2",
          outcome: "success",
        });
        ev2Id = ev2.id;
      },
      appDb,
    );

    // Using owner connection (simulating privileged insider deletion) to delete the tail event
    const ownerDb = postgres(getDbUrl().replace("casefile_app:casefile_app", "casefile:casefile"));
    try {
      await ownerDb`DELETE FROM audit_events WHERE id = ${ev2Id}`;
    } finally {
      await ownerDb.end();
    }

    // verifyTenantAuditChain must catch this truncation
    await withTenant(
      tenantId,
      async (tx) => {
        const res = await verifyTenantAuditChain(tx, tenantId);
        expect(res.valid).toBe(false);
        expect(res.break?.type).toBe("truncated_tail");
      },
      appDb,
    );
  });
});
