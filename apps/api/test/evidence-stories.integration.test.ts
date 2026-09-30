import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  Evidence,
  CitationResolutionResponse,
  EvidenceProvenanceChain,
} from "@casefile/contracts";

describe("Epic E7 — Evidence & Viewer User Stories (EVID-001..005, VIEW-001..006)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let sourceId: string;
  let blockId: string;
  let findingTargetId: string;
  let assertionTargetId: string;

  const rawDocumentText =
    "Panama Corporate Registry Filing #9842. The Board of Directors resolves that Meridian Trading Ltd is 100 percent owned by Kestrel Nominees Limited as of 2018-05-14.";

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // 1. Register User & Org
    const email = `evidence-stories-${Date.now()}@casefile.test`;
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password: "MasterPassword123!",
        name: "Marcus Aurelius",
        orgName: "Story Intelligence Group",
      },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    // 2. Token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password: "MasterPassword123!", tenantId },
    });
    token = JSON.parse(tokenRes.body).accessToken;

    // 3. Workspace & Investigation
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Evidence Story Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Operation Panama Filings",
        objective: "Verify all Evidence and Viewer User Stories",
      },
    });
    investigationId = JSON.parse(invRes.body).id;

    // 4. Ingest Document
    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Panama_Registry_Filing_9842.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        raw_text: rawDocumentText,
        acquisition_record: {
          origin: "Panama Public Registry",
          custodian: "Official Registrar",
          acquisition_method: "upload",
        },
      },
    });
    expect(srcRes.statusCode).toBe(201);
    sourceId = JSON.parse(srcRes.body).id;

    // Fetch block
    const blockRows = await withTenant(tenantId, async (tx) => {
      return tx<{ id: string }[]>`
        SELECT b.id
        FROM content_blocks b
        JOIN content_documents cd ON cd.id = b.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${sourceId}
          AND b.tenant_id = ${tenantId};
      `;
    });
    expect(blockRows.length).toBeGreaterThan(0);
    blockId = blockRows[0]!.id;

    findingTargetId = randomUUID();
    assertionTargetId = randomUUID();
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── REQ-EVID-001, 002, 003: Evidence Creation, Weight & Target Linking ─────
  it("REQ-EVID-001, REQ-EVID-002, REQ-EVID-003 — create evidence from selection with weight assessment and multi-target linking", async () => {
    const textSnippet = "Meridian Trading Ltd is 100 percent owned by Kestrel Nominees Limited";
    const startIdx = rawDocumentText.indexOf(textSnippet);
    const endIdx = startIdx + textSnippet.length;

    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: startIdx,
        char_end: endIdx,
        quoted_text: textSnippet,
        page: 1,
        bbox: { x1: 50.0, y1: 120.0, x2: 450.0, y2: 140.0 },
        evidence_type: "documentary",
        weight: "strong",
        weight_rationale: "Official notarized Panama registry filing directly certifying corporate ownership structure",
        targets: [
          { target_type: "finding", target_id: findingTargetId, role: "supports" },
          { target_type: "assertion", target_id: assertionTargetId, role: "supports" },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const ev: Evidence = JSON.parse(res.body);

    expect(ev.id).toBeDefined();
    expect(ev.cited_text).toBe(textSnippet);
    expect(ev.span_hash).toBeDefined();
    expect(ev.locator.char_start).toBe(startIdx);
    expect(ev.locator.char_end).toBe(endIdx);
    expect(ev.locator.page).toBe(1);
    expect(ev.locator.bbox).toBeDefined();
    expect(ev.weight).toBe("strong");
    expect(ev.weight_rationale).toContain("notarized Panama registry filing");
    expect(ev.supports.length).toBe(2);
    expect(ev.integrity_status).toBe("intact");
    expect(ev.status).toBe("active");
  });

  // ── REQ-EVID-004: Evidence Review & Dispute Workflow ───────────────────────
  it("REQ-EVID-004 — update review state to reviewed or disputed with rationale", async () => {
    const textSnippet = "The Board of Directors resolves";
    const startIdx = rawDocumentText.indexOf(textSnippet);
    const endIdx = startIdx + textSnippet.length;

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: startIdx,
        char_end: endIdx,
        quoted_text: textSnippet,
        evidence_type: "documentary",
        weight: "moderate",
      },
    });
    const evId = JSON.parse(createRes.body).id;

    // Review evidence
    const reviewRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/evidence/${evId}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        review_state: "reviewed",
      },
    });
    expect(reviewRes.statusCode).toBe(200);

    // Dispute evidence with rationale
    const disputeRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/evidence/${evId}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        review_state: "disputed",
        dispute_rationale: "Conflicting filing from 2021 indicates board composition was altered before resolution.",
      },
    });
    expect(disputeRes.statusCode).toBe(200);
    expect(JSON.parse(disputeRes.body).review_state).toBe("disputed");
  });

  // ── REQ-EVID-005: Evidence Withdrawal ──────────────────────────────────────
  it("REQ-EVID-005 — withdraw evidence with auditable exclusion reason", async () => {
    const textSnippet = "Panama Corporate Registry Filing #9842";
    const startIdx = rawDocumentText.indexOf(textSnippet);
    const endIdx = startIdx + textSnippet.length;

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: startIdx,
        char_end: endIdx,
        quoted_text: textSnippet,
        evidence_type: "documentary",
        weight: "weak",
      },
    });
    const evId = JSON.parse(createRes.body).id;

    const withdrawRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence/${evId}/withdraw`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        exclusion_reason: "Document was ruled privileged by external legal counsel and must be withdrawn.",
      },
    });

    expect(withdrawRes.statusCode).toBe(200);
    const withdrawnEv: Evidence = JSON.parse(withdrawRes.body);
    expect(withdrawnEv.status).toBe("withdrawn");
    expect(withdrawnEv.exclusion_reason).toContain("ruled privileged");
  });

  // ── REQ-VIEW-001..006: Evidence Viewer Capabilities ────────────────────────
  it("REQ-VIEW-001, 002, 003, 004, 005, 006 — Evidence Viewer displays document layout, toggle, ±500 context, integrity badge, contradictions, and derivation chain", async () => {
    const textSnippet = "Kestrel Nominees Limited";
    const startIdx = rawDocumentText.indexOf(textSnippet);
    const endIdx = startIdx + textSnippet.length;

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: startIdx,
        char_end: endIdx,
        quoted_text: textSnippet,
        page: 1,
        bbox: { x1: 200.0, y1: 125.0, x2: 380.0, y2: 138.0 },
        evidence_type: "direct",
        weight: "strong",
        targets: [
          { target_type: "finding", target_id: findingTargetId, role: "supports" },
          { target_type: "assertion", target_id: assertionTargetId, role: "contradicts" },
        ],
      },
    });
    const evId = JSON.parse(createRes.body).id;

    // 1. Citation Resolver (VIEW-001, 002, 003, 004, 005)
    const citRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/evidence/${evId}/citation`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(citRes.statusCode).toBe(200);
    const cit: CitationResolutionResponse = JSON.parse(citRes.body);

    // VIEW-001: Bounding box highlight on document
    expect(cit.locator.bbox).toBeDefined();

    // VIEW-002: Display mode toggle
    expect(cit.rendered_view.display_mode).toBe("original_document");

    // VIEW-003: Context display (±500 chars)
    expect(cit.context_before).toBeDefined();
    expect(cit.rendered_view.full_text_snippet).toContain("⟦Kestrel Nominees Limited⟧");

    // VIEW-004: Integrity status badge
    expect(cit.integrity_status).toBe("intact");
    expect(cit.is_broken).toBe(false);

    // VIEW-005: Contradiction surfacing
    expect(cit.contradicts.length).toBe(1);
    expect(cit.contradicts[0]!.target_id).toBe(assertionTargetId);

    // 2. Provenance Derivation Chain (VIEW-006)
    const provRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/evidence/${evId}/provenance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(provRes.statusCode).toBe(200);
    const prov: EvidenceProvenanceChain = JSON.parse(provRes.body);
    expect(prov.derivation_chain.length).toBe(8);
    expect(prov.is_complete).toBe(true);
  });
});
