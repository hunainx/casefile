import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";

/**
 * FINAL, DEV-036. The contract lets an ethical wall leave out `investigation_id` (a wall over the whole
 * workspace), but `ethical_walls.investigation_id` is NOT NULL (migration 0002), so such a request failed in the
 * database with a 500: a wall the owner asked for, not made, with no reason given. The safe option (as DEV-024):
 * the route refuses a workspace-wide wall with 422 and the reason, before anything is written. No such wall can be
 * in a matter already (the column refuses it), so there is nothing for the preflight or matter_status to flag; the
 * last test keeps that true: if a migration ever lets the column be empty, it fails until such walls are applied
 * or flagged.
 */
describe("FINAL — DEV-036: a workspace-wide ethical wall is refused with a reason, never a 500", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });
  const wall = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/v1/workspaces/${workspaceId}/ethical-walls`, headers: auth(), payload: { reason: "Fake conflict", subject_type: "user", subject_id: randomUUID(), ...payload } });
  const walls = () => withTenant(tenantId, (tx) => tx<{ investigation_id: string | null }[]>`SELECT investigation_id FROM ethical_walls WHERE workspace_id = ${workspaceId} ORDER BY created_at`, sql);

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `workspace-walls-${Date.now()}@casefile.test`;
    const password = "WorkspaceWalls123!";
    const reg = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Workspace Walls", orgName: "Workspace Walls Fake Org" } })).body);
    tenantId = reg.user.tenantId;
    token = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } })).body).accessToken;
    workspaceId = JSON.parse((await app.inject({ method: "POST", url: "/v1/workspaces", headers: auth(), payload: { name: "Workspace Walls WS" } })).body).id;
    investigationId = JSON.parse((await app.inject({ method: "POST", url: "/v1/investigations", headers: auth(), payload: { workspace_id: workspaceId, name: "Workspace Walls", objective: "FINAL DEV-036" } })).body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("a wall without an investigation is refused with 422 and the reason; nothing is stored", async () => {
    const res = await wall({});
    expect(res.statusCode, res.body).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.title).toBe("Unsupported ethical wall");
    expect(body.detail).toMatch(/whole workspace/i);
    expect(body.detail).toMatch(/one wall per investigation/i);
    expect(await walls()).toEqual([]);
  });

  it("an explicit null investigation is refused the same way", async () => {
    const res = await wall({ investigation_id: null });
    expect([400, 422], res.body).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
    expect(await walls()).toEqual([]);
  });

  it("a wall over one investigation is still created", async () => {
    const res = await wall({ investigation_id: investigationId });
    expect(res.statusCode, res.body).toBe(201);
    expect(await walls()).toEqual([{ investigation_id: investigationId }]);
  });

  it("no workspace-wide wall can already be in a matter: the column refuses an empty investigation", async () => {
    const col = await withTenant(tenantId, (tx) => tx<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ethical_walls' AND column_name = 'investigation_id'`, sql);
    expect(col).toEqual([{ is_nullable: "NO" }]);
  });
});
