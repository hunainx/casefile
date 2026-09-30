import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { handleMatterStatus } from "@casefile/mcp";
import { buildApp } from "../src/app.js";
import { runPreflight, formatReport } from "../../../scripts/matter-preflight.js";

/**
 * FIXES-1 D, DEV-024. An ethical wall may name a group, but there is no group membership table,
 * so nothing can resolve a group to its people and such a wall screened nobody, silently. The safe
 * option, until groups exist: POST /v1/workspaces/:id/ethical-walls refuses a group wall (and a
 * "role" wall, which the contract allowed but the database cannot store), and any group wall that
 * is already in a matter is flagged by the preflight (NOT READY) and by the MCP matter_status tool.
 */
describe("FIXES-1 D — DEV-024: group walls are refused and flagged, never silently ignored", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let userId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let dir: string;
  const auth = () => ({ authorization: `Bearer ${token}` });
  const wall = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/ethical-walls`, headers: auth(), payload: { reason: "Fake conflict", investigation_id: investigationId, ...payload } });
  const walls = () => withTenant(tenantId, (tx) => tx<{ subject_type: string }[]>`SELECT subject_type FROM ethical_walls WHERE workspace_id = ${workspaceId} ORDER BY created_at`, sql);
  const envFile = (name: string) => {
    const f = join(dir, name);
    writeFileSync(f, `DATABASE_URL=${getDbUrl()}\nMATTER_TENANT_ID=${tenantId}\nMATTER_INVESTIGATION_ID=${investigationId}\nMCP_PUBLIC_URL=https://mcp.casefile.test/mcp\n`);
    return f;
  };
  const ctx = () => ({ tenantId, investigationId, userId, roles: ["lead_inv"] });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "casefile-walls-"));
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `group-walls-${Date.now()}@casefile.test`;
    const password = "GroupWalls123!";
    const reg = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Group Walls", orgName: "Group Walls Fake Org" } })).body);
    tenantId = reg.user.tenantId;
    userId = reg.user.id;
    token = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } })).body).accessToken;
    workspaceId = JSON.parse((await app.inject({ method: "POST", url: "/v1/workspaces", headers: auth(), payload: { name: "Group Walls WS" } })).body).id;
    investigationId = JSON.parse((await app.inject({ method: "POST", url: "/v1/investigations", headers: auth(), payload: { workspace_id: workspaceId, name: "Group Walls", objective: "FIXES-1 D" } })).body).id;
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await app.close();
    await sql.end();
  });

  it("a group wall is refused with 422 and the reason; nothing is stored", async () => {
    const res = await wall({ subject_type: "group", subject_id: randomUUID() });
    expect(res.statusCode, res.body).toBe(422);
    expect(JSON.parse(res.body).detail).toMatch(/group.*not applied|no group membership/i);
    expect(await walls()).toEqual([]);
  });

  it("a role wall is refused the same way (the contract allowed it; the database cannot store it)", async () => {
    const res = await wall({ subject_type: "role", subject_id: randomUUID() });
    expect(res.statusCode, res.body).toBe(422);
    expect(await walls()).toEqual([]);
  });

  it("a user wall is still created and applied", async () => {
    const res = await wall({ subject_type: "user", subject_id: randomUUID() });
    expect(res.statusCode, res.body).toBe(201);
    expect(await walls()).toEqual([{ subject_type: "user" }]);
  });

  it("without a group wall, matter_status has no warning and the preflight is not held up by walls", async () => {
    const status = await withTenant(tenantId, (tx) => handleMatterStatus(tx, ctx()), sql);
    expect(status).not.toHaveProperty("warnings");
    const report = await runPreflight(envFile("no-group.env"));
    expect(report.reasons.filter((r) => /ethical wall/i.test(r))).toEqual([]);
  });

  it("a group wall already in the matter (created before this fix) is flagged: matter_status warns and the preflight says NOT READY", async () => {
    await withTenant(tenantId, (tx) => tx`
      INSERT INTO ethical_walls (id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason)
      VALUES (${randomUUID()}, ${tenantId}, ${workspaceId}, 'group', ${randomUUID()}, ${investigationId}, 'Fake group wall from before FIXES-1')`, sql);
    const status = (await withTenant(tenantId, (tx) => handleMatterStatus(tx, ctx()), sql)) as { warnings?: Array<{ kind: string; count: number; message: string }> };
    expect(status.warnings).toEqual([{ kind: "unapplied_group_ethical_walls", count: 1, message: expect.stringMatching(/1 ethical wall.*group.*NOT applied/i) }]);
    const out = formatReport(await runPreflight(envFile("group.env")));
    expect(out).toMatch(/RESULT: NOT READY/);
    expect(out).toMatch(/1 ethical wall\(s\) name a group/);
  });
});
