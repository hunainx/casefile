import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { writeAuditEvent, writeAuditEvents, verifyTenantAuditChain, generateUlid, type AuditEventInput } from "../src/index.js";

/**
 * BIGDATA-4 (plan answer 10): writeAuditEvents() writes several events in one step (one lock of the
 * chain head, one INSERT, one head update). The chain must be hashed and ordered exactly as before:
 * the same events written one by one with writeAuditEvent(), from the same chain head, in the same
 * transaction, give the same rows, column for column (seq, prev_hash, hash included), and a chain
 * that mixes both verifies (the verifier's own tests, guardrails/audit-integrity.spec.ts, show it
 * catches a changed, missing or reordered row).
 */
describe("packages/audit — writeAuditEvents (one step, the same chain)", () => {
  let appDb: postgres.Sql;
  beforeAll(() => {
    appDb = createDbClient(getDbUrl());
  });
  afterAll(async () => {
    if (appDb) await appDb.end();
  });

  // Row ids are made once per test run (ids are unique across the table), and reused for both writes.
  const ids = Array.from({ length: 5 }, (_, i) => generateUlid(Date.UTC(2026, 8, 30, 12, 0, i)));
  const inputs = (tenantId: string): AuditEventInput[] =>
    Array.from({ length: 5 }, (_, i) => ({
      id: ids[i]!,
      tenantId,
      timestamp: new Date(Date.UTC(2026, 8, 30, 12, 0, i)),
      actorType: "user" as const,
      actorId: "11111111-1111-1111-1111-111111111111",
      actorDisplay: "Fake Operator",
      action: i % 2 ? "source.skip" : "source.admit",
      objectType: "source",
      objectId: `22222222-2222-2222-2222-22222222222${i}`,
      objectDisplay: `fake-${i}.txt`,
      after: { filename: `fake-${i}.txt`, n: i, nested: { list: [i, "x"] }, ...(i === 3 ? { odd: `nul${String.fromCharCode(0)}inside` } : {}) },
      requestId: `req-batch-${i}`,
      outcome: "success" as const,
    }));

  /** The same event without its fixed id (a new ULID each time). */
  const noId = (e: AuditEventInput): AuditEventInput => {
    const rest = { ...e };
    delete rest.id;
    return rest;
  };

  it("gives the same rows as writing the events one by one, from the same chain head", async () => {
    const tenantId = randomUUID();
    await withTenant(tenantId, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${tenantId}, ${tenantId}, 'Audit batch tenant')`;
      await writeAuditEvent(tx, { tenantId, actorType: "system", actorId: "33333333-3333-3333-3333-333333333333", actorDisplay: "setup", action: "tenant.seed", objectType: "organization", objectId: tenantId, objectDisplay: "seed", requestId: "seed", outcome: "success" });
    }, appDb);
    const rowsOf = (tx: postgres.TransactionSql) => tx`SELECT * FROM audit_events WHERE tenant_id = ${tenantId} AND seq > 1 ORDER BY seq`;
    class Rollback extends Error {}
    let oneByOne: postgres.Row[] = [];
    await withTenant(tenantId, async (tx) => {
      for (const e of inputs(tenantId)) await writeAuditEvent(tx, e);
      oneByOne = [...(await rowsOf(tx))];
      throw new Rollback();
    }, appDb).catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
    await withTenant(tenantId, async (tx) => {
      expect(await writeAuditEvents(tx, inputs(tenantId))).toBe(5);
    }, appDb);
    const batched = await withTenant(tenantId, (tx) => rowsOf(tx), appDb);
    expect(oneByOne).toHaveLength(5);
    const strip = (r: postgres.Row) => ({ ...r, created_at: undefined, updated_at: undefined });
    expect(batched.map(strip)).toEqual(oneByOne.map(strip));
    expect(batched.map((r) => Number(r.seq))).toEqual([2, 3, 4, 5, 6]);
    const chain = await withTenant(tenantId, (tx) => verifyTenantAuditChain(tx, tenantId), appDb);
    expect(chain).toEqual(expect.objectContaining({ valid: true, verifiedCount: 6 }));
  });

  it("a chain of single rows and batches verifies", async () => {
    const tenantId = randomUUID();
    await withTenant(tenantId, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${tenantId}, ${tenantId}, 'Audit batch tenant 2')`;
      await writeAuditEvent(tx, { ...noId(inputs(tenantId)[0]!), requestId: "first" });
      await writeAuditEvents(tx, inputs(tenantId).slice(1, 4).map(noId));
      await writeAuditEvent(tx, noId(inputs(tenantId)[4]!));
    }, appDb);
    await withTenant(tenantId, (tx) => writeAuditEvents(tx, inputs(tenantId).map(noId)), appDb);
    const ok = await withTenant(tenantId, (tx) => verifyTenantAuditChain(tx, tenantId), appDb);
    expect(ok).toEqual(expect.objectContaining({ valid: true, verifiedCount: 10 }));
  });

  it("refuses events of two tenants in one call (one call is one chain)", async () => {
    await expect(withTenant(randomUUID(), (tx) => writeAuditEvents(tx, [inputs(randomUUID())[0]!, inputs(randomUUID())[0]!]), appDb)).rejects.toThrow(/one tenant/);
  });
});
