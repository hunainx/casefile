import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";

describe("Entities & Relationships Multi-Tenant Isolation & Endpoints", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenant1Id: string;
  let token1: string;
  let inv1Id: string;
  let entity1Id: string;

  let tenant2Id: string;
  let token2: string;
  let inv2Id: string;
  let entity2Id: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // Tenant 1 Setup
    const email1 = `t1-entity-${Date.now()}@casefile.test`;
    const reg1 = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email1, password: "Password123!", name: "T1 User", orgName: "Org 1" },
    });
    tenant1Id = JSON.parse(reg1.body).user.tenantId;

    const tok1 = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: email1, password: "Password123!", tenantId: tenant1Id },
    });
    token1 = JSON.parse(tok1.body).accessToken;

    const ws1 = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token1}` },
      payload: { name: "Workspace 1" },
    });
    const ws1Id = JSON.parse(ws1.body).id;

    const inv1 = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token1}` },
      payload: { workspace_id: ws1Id, name: "Inv 1" },
    });
    inv1Id = JSON.parse(inv1.body).id;

    // Tenant 2 Setup
    const email2 = `t2-entity-${Date.now()}@casefile.test`;
    const reg2 = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email2, password: "Password123!", name: "T2 User", orgName: "Org 2" },
    });
    tenant2Id = JSON.parse(reg2.body).user.tenantId;

    const tok2 = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: email2, password: "Password123!", tenantId: tenant2Id },
    });
    token2 = JSON.parse(tok2.body).accessToken;

    const ws2 = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token2}` },
      payload: { name: "Workspace 2" },
    });
    const ws2Id = JSON.parse(ws2.body).id;

    const inv2 = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token2}` },
      payload: { workspace_id: ws2Id, name: "Inv 2" },
    });
    inv2Id = JSON.parse(inv2.body).id;

    // Create Entity in Tenant 1
    const ent1Res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv1Id}/entities`,
      headers: { authorization: `Bearer ${token1}` },
      payload: { type: "Organization", canonical_name: "Tenant 1 Exclusive Assets" },
    });
    entity1Id = JSON.parse(ent1Res.body).id;

    // Create Entity in Tenant 2
    const ent2Res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv2Id}/entities`,
      headers: { authorization: `Bearer ${token2}` },
      payload: { type: "Organization", canonical_name: "Tenant 2 Secret Corp" },
    });
    entity2Id = JSON.parse(ent2Res.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("enforces RLS isolation across tenants on entities", async () => {
    // Tenant 2 attempts to fetch Tenant 1 entity -> 404
    const res = await app.inject({
      method: "GET",
      url: `/v1/investigations/${inv1Id}/entities/${entity1Id}`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(res.statusCode).toBe(404);

    // Direct entity route cross-tenant lookup -> 404
    const directRes = await app.inject({
      method: "GET",
      url: `/v1/entities/${entity1Id}`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(directRes.statusCode).toBe(404);

    // SQL RLS check
    await withTenant(tenant2Id, async (tx) => {
      const rows = await tx`SELECT * FROM entities WHERE id = ${entity1Id};`;
      expect(rows.length).toBe(0);
      const rows2 = await tx`SELECT * FROM entities WHERE id = ${entity2Id};`;
      expect(rows2.length).toBe(1);
    }, sql);
  });

  it("paginates entities with cursor and limit", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: `/v1/investigations/${inv1Id}/entities`,
        headers: { authorization: `Bearer ${token1}` },
        payload: { type: "Person", canonical_name: `Batch Subject ${i}` },
      });
    }

    const page1 = await app.inject({
      method: "GET",
      url: `/v1/investigations/${inv1Id}/entities?limit=3`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(page1.statusCode).toBe(200);
    const data1 = JSON.parse(page1.body);
    expect(data1.items.length).toBe(3);
    expect(data1.nextCursor).toBeDefined();

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/investigations/${inv1Id}/entities?limit=3&cursor=${data1.nextCursor}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(page2.statusCode).toBe(200);
    const data2 = JSON.parse(page2.body);
    expect(data2.items.length).toBeGreaterThan(0);
  });
});
