import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import type postgres from "postgres";

/**
 * D64: a route's response is sent only after its tenant transaction commits.
 *
 * Handlers call reply.send() inside the request transaction. Before D64 the response left
 * immediately, so a handler that sent and then failed acknowledged a write that was rolled
 * back, and a follow-up request could read state from before COMMIT (REQ-WS-03 and
 * AC-EPI-01 failed intermittently on that race). The first case below is deterministic:
 * without the fix the client receives 200 for a rolled-back write.
 */
describe("apps/api — response is sent only after the request transaction commits (D64)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let token: string;

  async function auditRowsFor(requestId: string): Promise<number> {
    return withTenant(tenantId, async (tx) => {
      const rows = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM audit_events
        WHERE tenant_id = ${tenantId} AND request_id = ${requestId};
      `;
      return Number(rows[0]?.count ?? "0");
    }, sql);
  }

  function probeEvent(requestId: string, userId: string) {
    return {
      tenantId,
      actorType: "user" as const,
      actorId: userId,
      actorDisplay: "commit-before-reply probe",
      action: "test.commit_probe",
      objectType: "probe",
      objectId: randomUUID(),
      objectDisplay: "probe",
      requestId,
      outcome: "success" as const,
    };
  }

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });

    // Probe routes go through the same onRoute wrapper as every real route.
    app.post("/v1/__probe/send-then-fail", { config: { authenticated: true } }, async (req, reply) => {
      const { requestId } = req.body as { requestId: string };
      await writeAuditEvent(req.tx!, probeEvent(requestId, req.user!.userId));
      reply.status(200).send({ acknowledged: true });
      throw new Error("handler failed after calling reply.send()");
    });
    app.post("/v1/__probe/send-then-succeed", { config: { authenticated: true } }, async (req, reply) => {
      const { requestId } = req.body as { requestId: string };
      await writeAuditEvent(req.tx!, probeEvent(requestId, req.user!.userId));
      return reply.status(200).send({ acknowledged: true });
    });
    await app.ready();

    const email = `commit-before-reply-${Date.now()}@casefile.test`;
    const password = "CommitBeforeReply123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "Commit Probe", orgName: "Commit Probe Org" },
    });
    expect(regRes.statusCode).toBe(201);
    const reg = JSON.parse(regRes.body);
    tenantId = reg.user.tenantId;
    token = reg.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("a handler that sends and then throws returns the error, and its write is not persisted", async () => {
    const requestId = randomUUID();
    const res = await app.inject({
      method: "POST",
      url: "/v1/__probe/send-then-fail",
      headers: { authorization: `Bearer ${token}` },
      payload: { requestId },
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).acknowledged).toBeUndefined();
    expect(await auditRowsFor(requestId)).toBe(0);
  });

  it("a successful write is visible to the very next read once the response has arrived", async () => {
    for (let i = 0; i < 25; i++) {
      const requestId = randomUUID();
      const res = await app.inject({
        method: "POST",
        url: "/v1/__probe/send-then-succeed",
        headers: { authorization: `Bearer ${token}` },
        payload: { requestId },
      });
      expect(res.statusCode).toBe(200);
      expect(await auditRowsFor(requestId)).toBe(1);
    }
  });
});
