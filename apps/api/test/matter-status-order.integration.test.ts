import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { handleMatterStatus } from "@casefile/mcp";
import { buildApp } from "../src/app.js";

/**
 * FINAL, DEV-045. matter_status counted the sources by status with `GROUP BY status` and no ORDER BY, so the keys
 * of `sources.by_status` came in whatever order Postgres' aggregate returned them: the same counts, in another order
 * from one call to the next (the BIGDATA-4 before capture's two passes differed). The order is now fixed: by status
 * name. The test makes the unordered form visible by switching sorting and index scans off in its transaction
 * (Postgres then groups by hashing, which is what gave the random order), and asks for the fixed order both ways.
 */
describe("FINAL — DEV-045: matter_status lists its status counts in a fixed order", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let userId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });
  const ctx = () => ({ tenantId, investigationId, userId, roles: ["lead_inv"] });

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `status-order-${Date.now()}@casefile.test`;
    const password = "StatusOrder123!";
    const reg = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Status Order", orgName: "Status Order Fake Org" } })).body);
    tenantId = reg.user.tenantId;
    userId = reg.user.id;
    token = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } })).body).accessToken;
    workspaceId = JSON.parse((await app.inject({ method: "POST", url: "/v1/workspaces", headers: auth(), payload: { name: "Status Order WS" } })).body).id;
    investigationId = JSON.parse((await app.inject({ method: "POST", url: "/v1/investigations", headers: auth(), payload: { workspace_id: workspaceId, name: "Status Order", objective: "FINAL DEV-045" } })).body).id;
    // Fake sources in the four statuses of the 100 MB capture, written in no particular order.
    const statuses = ["unprocessable", "indexed", "stored_unparsed", "needs_ocr", "indexed", "needs_ocr", "indexed"];
    await withTenant(tenantId, async (tx) => {
      for (const [i, status] of statuses.entries()) {
        await tx`
          INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, status)
          VALUES (${randomUUID()}, ${tenantId}, ${workspaceId}, ${investigationId}, ${`fake-${i}.txt`}, 'text/plain', 10,
                  ${String(i).repeat(64).slice(0, 64)}, ${`memory://fake/${i}`}, ${status})`;
      }
    }, sql);
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  const expected = { indexed: 3, needs_ocr: 2, stored_unparsed: 1, unprocessable: 1 };

  it("the counts come in status order, whatever plan Postgres picks for the grouping", async () => {
    // Postgres' own choice (on a small matter: the index on tenant, investigation, status gives the rows in status
    // order already), then a scan and a hash grouping (what a bigger matter got: the random order).
    for (const settings of [[], ["enable_sort", "enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan"]]) {
      const status = await withTenant(tenantId, async (tx) => {
        for (const s of settings) await tx.unsafe(`SET LOCAL ${s} = off`);
        return handleMatterStatus(tx, ctx());
      }, sql);
      expect(status.sources.total).toBe(7);
      expect(JSON.stringify(status.sources.by_status), `off: ${settings.join(", ") || "none"}`).toBe(JSON.stringify(expected));
    }
  });
});
