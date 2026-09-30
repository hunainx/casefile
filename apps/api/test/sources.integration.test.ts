import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient } from "@casefile/db";
import type postgres from "postgres";

describe("apps/api — Sources API Pipeline & Isolation Suite", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `sources-api-${Date.now()}@casefile.test`;
    const password = "SourcesPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password,
        name: "Sources Api User",
        orgName: "Sources Api Corp",
      },
    });
    expect(regRes.statusCode).toBe(201);
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password, tenantId },
    });
    expect(tokenRes.statusCode).toBe(200);
    token = JSON.parse(tokenRes.body).accessToken;

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Sources Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Sources Investigation Matter",
        objective: "Sources endpoints validation",
      },
    });
    expect(invRes.statusCode).toBe(201);
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("REQ-API-GET-V1-INVESTIGATIONS-ID-SOURCES: Pagination and filtering", async () => {
    // Ingest two sources
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Source_List_A.pdf",
        mime_type: "application/pdf",
        raw_text: "Source text A",
        acquisition_record: { origin: "Dept A", custodian: "Custodian A" },
      },
    });
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Source_List_B.pdf",
        mime_type: "application/pdf",
        raw_text: "Source text B",
        acquisition_record: { origin: "Dept B", custodian: "Custodian B" },
      },
    });

    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources?limit=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const body = JSON.parse(listRes.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(1);
    expect(body.nextCursor).toBeDefined();
  });

  it("Enforces tenant isolation on sources", async () => {
    // Register second tenant
    const t2Email = `t2-sources-${Date.now()}@casefile.test`;
    const t2Reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: t2Email, password: "TenantTwoPass123!", name: "T2 User", orgName: "Tenant Two Corp" },
    });
    const t2Data = JSON.parse(t2Reg.body);
    const t2TokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: t2Email, password: "TenantTwoPass123!", tenantId: t2Data.user.tenantId },
    });
    const t2Token = JSON.parse(t2TokenRes.body).accessToken;

    // T2 attempt to read T1 sources
    const crossRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${t2Token}` },
    });
    // Returns 200 with empty array (or 404 if investigation not found in T2)
    const crossBody = JSON.parse(crossRes.body);
    expect(crossBody.items.length).toBe(0);
  });
});
