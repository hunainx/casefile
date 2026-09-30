import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";

describe("Assertion Service & API Routes Integration (PRD §6, §12, §13, §45.4)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenant1Id: string;
  let tenant2Id: string;
  let workspace1Id: string;
  let investigation1Id: string;
  let token1: string;
  let token2: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // Org 1 Setup
    const email1 = `e4-api-1-${Date.now()}@casefile.test`;
    const regRes1 = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email1, password: "Password123!", name: "API User 1", orgName: "API Org 1" },
    });
    const regData1 = JSON.parse(regRes1.body);
    tenant1Id = regData1.user.tenantId;

    const tokenRes1 = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: email1, password: "Password123!", tenantId: tenant1Id },
    });
    token1 = JSON.parse(tokenRes1.body).accessToken;

    const wsRes1 = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token1}` },
      payload: { name: "API Workspace 1" },
    });
    workspace1Id = JSON.parse(wsRes1.body).id;

    const invRes1 = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token1}` },
      payload: { workspace_id: workspace1Id, name: "Matter Alpha", objective: "API Route Testing" },
    });
    investigation1Id = JSON.parse(invRes1.body).id;

    // Org 2 Setup (for Cross-Tenant Isolation Testing)
    const email2 = `e4-api-2-${Date.now()}@casefile.test`;
    const regRes2 = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email2, password: "Password123!", name: "API User 2", orgName: "API Org 2" },
    });
    const regData2 = JSON.parse(regRes2.body);
    tenant2Id = regData2.user.tenantId;

    const tokenRes2 = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email: email2, password: "Password123!", tenantId: tenant2Id },
    });
    token2 = JSON.parse(tokenRes2.body).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("creates, retrieves, and lists assertions with cursor pagination", async () => {
    const createdIds: string[] = [];

    // Create 3 assertions
    for (let i = 1; i <= 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigation1Id}/assertions`,
        headers: { authorization: `Bearer ${token1}` },
        payload: {
          kind: "attribute",
          subject_type: "entity",
          subject_id: randomUUID(),
          predicate: `property_${i}`,
          object_type: "text",
          object_literal: { val: `value_${i}` },
          asserter: { type: "model" },
          epistemic_state: "Supported",
          evidence_ids: [randomUUID()],
        },
      });
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      createdIds.push(data.id);
    }

    // List with pagination limit=2
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigation1Id}/assertions?limit=2`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listData = JSON.parse(listRes.body);
    expect(listData.items.length).toBe(2);
    expect(listData.nextCursor).toBeDefined();

    // Fetch next page with cursor
    const nextRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigation1Id}/assertions?limit=2&cursor=${encodeURIComponent(listData.nextCursor)}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(nextRes.statusCode).toBe(200);
    const nextData = JSON.parse(nextRes.body);
    expect(nextData.items.length).toBe(1);

    // Fetch individual assertion
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigation1Id}/assertions/${createdIds[0]}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(getRes.statusCode).toBe(200);
    const getData = JSON.parse(getRes.body);
    expect(getData.id).toBe(createdIds[0]);
  });

  it("enforces multi-tenant RLS isolation: tenant2 cannot view or mutate tenant1 assertions", async () => {
    // 1. Create assertion in tenant 1
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigation1Id}/assertions`,
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "secret_deal",
        object_type: "text",
        object_literal: { confidential: true },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const assertion1 = JSON.parse(createRes.body);

    // 2. Tenant 2 tries to GET assertion1
    const t2GetRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigation1Id}/assertions/${assertion1.id}`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(t2GetRes.statusCode).toBe(404);

    // 3. Tenant 2 tries to validate assertion1
    const t2ValRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigation1Id}/assertions/${assertion1.id}/validate`,
      headers: { authorization: `Bearer ${token2}` },
      payload: {
        epistemic_state: "Verified",
        rationale: "Unauthorized validation attempt.",
      },
    });
    expect(t2ValRes.statusCode).toBe(404);
  });

  it("supports human validation with audit trail and rationale", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigation1Id}/assertions`,
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        kind: "relationship",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "owns_shareholder_stake",
        object_type: "entity",
        object_id: randomUUID(),
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const assertion = JSON.parse(createRes.body);

    const valRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigation1Id}/assertions/${assertion.id}/validate`,
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        epistemic_state: "Verified",
        rationale: "Direct inspection of original shareholder register.",
      },
    });
    expect(valRes.statusCode).toBe(200);
    const verified = JSON.parse(valRes.body);
    expect(verified.epistemic_state).toBe("Verified");
    expect(verified.plane).toBe("record");
    expect(verified.review_rationale).toBe("Direct inspection of original shareholder register.");
    expect(verified.reviewed_by).toBeDefined();
  });

  it("supports assertion supersession linking old and new assertions (REQ-M-API-006)", async () => {
    // 1. Create original assertion
    const origRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigation1Id}/assertions`,
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "company_registration_number",
        object_type: "text",
        object_literal: { number: "12345678" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });
    expect(origRes.statusCode).toBe(201);
    const orig = JSON.parse(origRes.body);

    // 2. Supersede with updated assertion
    const superRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigation1Id}/assertions/${orig.id}/supersede`,
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: orig.subject_id,
        predicate: "company_registration_number",
        object_type: "text",
        object_literal: { number: "12345678-CORRECTED" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });
    expect(superRes.statusCode).toBe(201);
    const replacement = JSON.parse(superRes.body);
    expect(replacement.supersedes).toBe(orig.id);

    // 3. Verify old assertion is marked superseded
    const checkOldRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigation1Id}/assertions/${orig.id}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(checkOldRes.statusCode).toBe(200);
    const oldData = JSON.parse(checkOldRes.body);
    expect(oldData.review_state).toBe("superseded");
    expect(oldData.superseded_by).toBe(replacement.id);
  });
});

