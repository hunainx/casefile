import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";

describe("Invariant I9 — Extraction Quote Verification (PRD §5.2 Stage 5, Invariant I9)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let sourceId: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `e5-i9-${Date.now()}@casefile.test`;
    const password = "E5I9Password123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "E5 I9 User", orgName: "E5 I9 Org" },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password, tenantId },
    });
    token = JSON.parse(tokenRes.body).accessToken;

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "E5 I9 Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Operation Invariant I9",
        objective: "Verify extraction span quote enforcement.",
      },
    });
    investigationId = JSON.parse(invRes.body).id;

    // Upload source
    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Shareholder_Agreement.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: "Elena Rostova holds 45% voting equity in Meridian Capital Management S.A.",
        acquisition_record: {
          origin: "Corporate Registrar",
          custodian: "Corporate Legal Archives",
          acquisition_method: "upload",
        },
      },
    });
    sourceId = JSON.parse(srcRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("I9 — extraction with verified quoted span is accepted and stored as entity and mention", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/extract`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        items: [
          {
            kind: "entity",
            entity_type: "Person",
            canonical_name: "Elena Rostova",
            quoted_span: "Elena Rostova",
            char_start: 0,
            char_end: 13,
            confidence: 0.98,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.verified_count).toBe(1);
    expect(data.discarded_count).toBe(0);
    expect(data.created_entities.length).toBe(1);
    expect(data.created_entities[0].canonical_name).toBe("Elena Rostova");
  });

  it("I9 — extraction whose quoted span does not verify against source text is discarded, not stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/extract`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        items: [
          {
            kind: "entity",
            entity_type: "Person",
            canonical_name: "Fabricated Hallucinated Name",
            quoted_span: "Fabricated Hallucinated Name That Never Appears In Document",
            char_start: 0,
            char_end: 50,
            confidence: 0.90,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.verified_count).toBe(0);
    expect(data.discarded_count).toBe(1);
    expect(data.created_entities.length).toBe(0);
    expect(data.results[0].verified).toBe(false);
    expect(data.results[0].discard_reason).toContain("Invariant I9");
  });
});
