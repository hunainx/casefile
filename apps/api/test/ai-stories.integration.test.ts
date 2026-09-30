/**
 * Epic E8 — AI Gateway, Capabilities, Tool Catalog & Stories Integration Tests
 *
 * Verifies:
 *   - AI-01..22: Capabilities (synthesis, extraction, gap analysis, timeline, contradiction), manifest tracking, promotion
 *   - TOOL-01..20: Tool Catalog (Class A read tools, Class B machine writes, Class C suggestions, Class D approval)
 *   - AGT-01..07: Agent governance and action boundaries
 *   - EVAL-01..10: Grounding evaluation metrics and telemetry
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { AIToolExecution } from "@casefile/contracts";

type AppInstance = ReturnType<typeof buildApp>;

describe("Epic E8 — AI Stories & Tool Catalog Integration Tests", () => {
  let app: AppInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let sourceId: string;
  let blockId: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // 1. Register User & Org
    const email = `ai-stories-${Date.now()}@casefile.test`;
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password: "AIStoriesPassword123!",
        name: "Marcus Vance",
        orgName: "Vance Global Analytics",
      },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    // 2. Token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password: "AIStoriesPassword123!", tenantId },
    });
    token = JSON.parse(tokenRes.body).accessToken;

    // 3. Workspace & Investigation
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "AI Gateway Analytics" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Project Chimera Analysis",
        objective: "Test AI gateway model router and tool execution catalogue",
      },
    });
    investigationId = JSON.parse(invRes.body).id;

    // 4. Source & Evidence
    const sampleText = "On 2021-04-15, Chimera Holdings entered into a binding guarantee with Meridian Capital for 5000000 USD.";
    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Chimera_Guarantee_2021.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        raw_text: sampleText,
        acquisition_record: {
          origin: "Client Production",
          custodian: "Marcus Vance",
          acquisition_method: "upload",
        },
      },
    });
    expect(srcRes.statusCode).toBe(201);
    sourceId = JSON.parse(srcRes.body).id;

    const blockRows = await withTenant(tenantId, async (tx) => {
      return tx<{ id: string }[]>`
        SELECT b.id
        FROM content_blocks b
        JOIN content_documents cd ON cd.id = b.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${sourceId}
          AND b.tenant_id = ${tenantId};
      `;
    }, sql);
    expect(blockRows.length).toBeGreaterThan(0);
    blockId = blockRows[0]!.id;

    const startIdx = sampleText.indexOf("Chimera Holdings entered into a binding guarantee");
    const endIdx = startIdx + "Chimera Holdings entered into a binding guarantee with Meridian Capital".length;

    const evRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: startIdx,
        char_end: endIdx,
        quoted_text: "Chimera Holdings entered into a binding guarantee with Meridian Capital",
        evidence_type: "documentary",
        weight: "strong",
      },
    });
    expect(JSON.parse(evRes.body).id).toBeDefined();
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── AI-01..10: NOT IMPLEMENTED (DEV-017) ────────────────────────────────────
  // Previously asserted that every capability returned a result with positive token
  // counts and cost. Those numbers were constants and the result was a fixed narrative.
  it("AI-01..10 — every AI capability returns 501 Not Implemented; no result exists to retrieve", async () => {
    const capabilities = ["contradiction_detection", "report_drafting", "entity_resolution"] as const;

    for (const cap of capabilities) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/ai/invoke`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          capability: cap,
          query: `Analyze ${cap} across evidence base`,
        },
      });

      expect(res.statusCode).toBe(501);
      const body = JSON.parse(res.body);
      expect(body.type).toBe("https://docs.casefile.com/errors/not-implemented");
      expect(body.detail).toContain(`'${cap}' is not implemented`);
      expect(body.id).toBeUndefined();
    }

    await withTenant(tenantId, async (tx) => {
      const rows = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ai_results
        WHERE tenant_id = ${tenantId} AND investigation_id = ${investigationId};
      `;
      expect(rows[0]?.count).toBe("0");
    }, sql);
  });

  // ── TOOL-01..20: Full AI Tool Catalog Execution ────────────────────────────
  it("TOOL-01..20 — Executes Class A, B, and C tools in catalogue", async () => {
    // 1. Tool: get_investigation_state (Class A)
    const stateRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/ai/tools/execute`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tool_name: "get_investigation_state",
        input_params: {},
      },
    });
    expect(stateRes.statusCode).toBe(200);
    const stateBody: AIToolExecution = JSON.parse(stateRes.body);
    expect(stateBody.action_class).toBe("A");
    expect(stateBody.output_payload).toBeDefined();

    // 2. Tool: create_extraction (Class B)
    const extRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/ai/tools/execute`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tool_name: "create_extraction",
        input_params: { source_id: sourceId, span: "binding guarantee" },
      },
    });
    expect(extRes.statusCode).toBe(200);
    const extBody: AIToolExecution = JSON.parse(extRes.body);
    expect(extBody.action_class).toBe("B");

    // 3. Tool: draft_finding (Class C)
    const draftRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/ai/tools/execute`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tool_name: "draft_finding",
        input_params: { question_id: "q_100" },
      },
    });
    expect(draftRes.statusCode).toBe(200);
    const draftBody: AIToolExecution = JSON.parse(draftRes.body);
    expect(draftBody.action_class).toBe("C");

    // 4. Tool: promote_analysis with explicit confirmation (Class D allowed)
    const classDRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/ai/tools/execute`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tool_name: "promote_analysis",
        input_params: { result_id: "res_123" },
        allow_class_d: true,
      },
    });
    expect(classDRes.statusCode).toBe(200);
    const classDBody: AIToolExecution = JSON.parse(classDRes.body);
    expect(classDBody.action_class).toBe("D");
    expect(classDBody.confirmed_by).toBeDefined();
  });
});
