import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { ContextManifest } from "@casefile/contracts";

describe("Epic E6 Investigation Memory & Context Manifests (PRD §13 & §20 MEM-01..08)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let focalEntityId: string;
  let sampleChunkId: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `e6-memory-${Date.now()}@casefile.test`;
    const password = "E6MemoryPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "E6 Memory User", orgName: "E6 Memory Org" },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;
    token = regData.accessToken;

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "E6 Memory WS" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    // 1. Create Investigation with defined objective and scope
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Operation Titan Memory",
        objective: "Identify beneficial owners of offshore shell companies",
        scope: {
          subjects: [
            { descriptor: "Titan Holdings Inc", subject_type: "organization", role: "primary_subject" },
          ],
        },
      },
    });
    investigationId = JSON.parse(invRes.body).id;
    expect(tenantId).toBeDefined();

    // 2. Add Spine Questions (Tier 1)
    const qRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/questions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "Who is the primary beneficial owner of Titan Holdings?",
        materiality: "critical",
        sequence: 1,
      },
    });
    expect(qRes.statusCode).toBe(201);

    // 3. Create Focal Entity (Tier 2)
    const entRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Organization",
        canonical_name: "Titan Holdings Inc",
        is_focal: true,
        confidence: 0.98,
      },
    });
    focalEntityId = JSON.parse(entRes.body).id;

    // 4. Ingest document to create chunk (Tier 4)
    const docRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Titan_Articles_Of_Association.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: "Titan Holdings Inc was established under the laws of Panama with 10,000 bearer shares.",
        acquisition_record: { origin: "Panama Public Registry", custodian: "Notary", acquisition_method: "upload" },
      },
    });
    const docData = JSON.parse(docRes.body);

    const chunkRows = await withTenant(tenantId, async (tx) => {
      return tx<{ id: string }[]>`
        SELECT c.id
        FROM chunks c
        JOIN content_documents cd ON cd.id = c.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${docData.id};
      `;
    });
    sampleChunkId = chunkRows[0]!.id;

    // 5. Create Verified Assertion (Tier 2)
    const assRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: focalEntityId,
        predicate: "jurisdiction_of_incorporation",
        object_type: "literal",
        object_literal: { jurisdiction: "Panama" },
        asserter: { type: "human" },
        epistemic_state: "Verified",
        confidence: 1.0,
        evidence_ids: [sampleChunkId],
      },
    });
    expect(assRes.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── MEM-01..04: 4-Tier Memory Retrieval ──────────────────────────────────
  it("MEM-01, MEM-02, MEM-03, MEM-04 — inspect 4-tier memory state ('What Casefile Knows')", async () => {
    const memoryRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/memory`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(memoryRes.statusCode).toBe(200);
    const memoryData = JSON.parse(memoryRes.body);

    // Tier 1: Definition Memory
    expect(memoryData.tier1).toBeDefined();
    expect(memoryData.tier1.objective).toContain("beneficial owners");
    expect(memoryData.tier1.questions.length).toBeGreaterThanOrEqual(1);
    expect(memoryData.tier1.scope_subjects.length).toBeGreaterThanOrEqual(1);

    // Tier 2: State Memory
    expect(memoryData.tier2).toBeDefined();
    expect(memoryData.tier2.focal_entities.some((e: { canonical_name: string }) => e.canonical_name === "Titan Holdings Inc")).toBe(true);
    expect(memoryData.tier2.verified_findings.length).toBeGreaterThanOrEqual(1);
    expect(memoryData.tier2.corpus_profile.total_sources).toBeGreaterThanOrEqual(1);

    // Tier 3: Working Memory
    expect(memoryData.tier3).toBeDefined();
    expect(Array.isArray(memoryData.tier3.recent_searches)).toBe(true);
  });

  // ── MEM-05..07: Context Manifest Assembly with Budget & Omission Tracking ─
  it("MEM-05, MEM-06, MEM-07 — assemble deterministic Context Manifest with token budgeting and omission records", async () => {
    const manifestRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/memory/manifest`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        operation: "answer_question",
        model_target: "claude-3-5-sonnet",
        target_chunk_ids: [sampleChunkId],
        working_context: { active_entity_id: focalEntityId },
      },
    });
    expect(manifestRes.statusCode).toBe(201);
    const manifest: ContextManifest = JSON.parse(manifestRes.body);

    expect(manifest.id).toBeDefined();
    expect(manifest.operation).toBe("answer_question");
    expect(manifest.tier1.objective).toBeDefined();
    expect(manifest.tier2.focal_entities.length).toBeGreaterThan(0);
    expect(manifest.tier4.length).toBe(1);
    expect(manifest.tier4[0]?.chunk_id).toBe(sampleChunkId);

    // Token budget verification (PRD §13.5)
    expect(manifest.token_budget).toBeDefined();
    expect(manifest.token_budget.total_allocated).toBe(200000);
    expect(manifest.token_budget.system_instructions).toBe(3000);
    expect(manifest.token_budget.response_reserve).toBe(15000);
    expect(manifest.token_budget.total_used).toBeGreaterThan(0);
    expect(manifest.token_budget.remaining).toBeGreaterThan(0);
    expect(Array.isArray(manifest.omitted)).toBe(true);
  });

  // ── MEM-08: Memory Inspection & Correction ────────────────────────────────
  it("MEM-08 — memory correction: update focal status and memory state snapshot", async () => {
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/memory`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        focal_entity_ids: [focalEntityId],
        corrected_summaries: {
          titan_summary: "Titan Holdings is verified as a Panamanian offshore entity.",
        },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).message).toContain("updated successfully");
  });
});
