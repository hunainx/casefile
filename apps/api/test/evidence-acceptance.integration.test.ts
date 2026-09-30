import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type postgres from "postgres";
import type { FastifyInstance } from "fastify";
import type {
  CitationResolutionResponse,
  EvidenceProvenanceChain,
  DriftCheckReport,
} from "@casefile/contracts";

describe("Epic E7 — Evidence & Provenance Acceptance Tests (AC-PRV-01..04)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let sourceId: string;
  let blockId: string;
  const sampleDocText =
    "Pursuant to clause 14.2 of the Share Purchase Agreement, Meridian Trading Ltd transferred 100 percent beneficial ownership of Kestrel Nominees on 2019-08-12.";

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // 1. Register User & Org
    const email = `evidence-acceptance-${Date.now()}@casefile.test`;
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password: "MasterPassword123!",
        name: "Elena Rostova",
        orgName: "Evidence Intelligence Org",
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
      payload: { name: "Evidence Acceptance Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Operation Meridian Provenance",
        objective: "Verify all 4 Provenance and Citation Acceptance Criteria",
      },
    });
    investigationId = JSON.parse(invRes.body).id;

    // 4. Ingest Primary Record Document
    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Share_Purchase_Agreement_2019.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        raw_text: sampleDocText,
        acquisition_record: {
          origin: "Client Production",
          custodian: "J. Okonkwo",
          acquisition_method: "upload",
        },
      },
    });
    expect(srcRes.statusCode).toBe(201);
    sourceId = JSON.parse(srcRes.body).id;

    // Fetch created block
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
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── AC-PRV-01: Locator Verification on Extraction ─────────────────────────
  it("AC-PRV-01 — Given an extraction with mismatched quoted text at offsets, When verified, Then discarded not stored", async () => {
    // Model returns extraction claiming offsets 58–78 with fabricated text
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: 58,
        char_end: 78,
        quoted_text: "Fabricated Shell Company Corp",
        evidence_type: "documentary",
      },
    });

    expect(res.statusCode).toBe(422);
    const err = JSON.parse(res.body);
    expect(err.type).toContain("grounding-verification-failed");
    expect(err.detail).toContain("Quoted span text does not match block text");
  });

  // ── AC-PRV-02: Citation Resolution ─────────────────────────────────────────
  it("AC-PRV-02 — Given any citation URI, When activated, Then opens original document at exact span highlighted with ±500 chars context in < 2s", async () => {
    // Create valid evidence
    const startIdx = sampleDocText.indexOf("Meridian Trading Ltd");
    const endIdx = startIdx + "Meridian Trading Ltd".length;

    const evRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: startIdx,
        char_end: endIdx,
        quoted_text: "Meridian Trading Ltd",
        page: 12,
        bbox: { x1: 72.0, y1: 150.5, x2: 240.0, y2: 165.0 },
        evidence_type: "direct",
        weight: "strong",
      },
    });

    expect(evRes.statusCode).toBe(201);
    const evId = JSON.parse(evRes.body).id;

    const start = Date.now();
    const citRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/evidence/${evId}/citation`,
      headers: { authorization: `Bearer ${token}` },
    });
    const durationMs = Date.now() - start;

    expect(citRes.statusCode).toBe(200);
    expect(durationMs).toBeLessThan(2000); // PRD §56.3 < 2s p95 target

    const cit: CitationResolutionResponse = JSON.parse(citRes.body);
    expect(cit.evidence_id).toBe(evId);
    expect(cit.source.filename).toBe("Share_Purchase_Agreement_2019.pdf");
    expect(cit.source.mime_type).toBe("application/pdf");
    expect(cit.source.custodian).toBe("J. Okonkwo");
    expect(cit.locator.char_start).toBe(startIdx);
    expect(cit.locator.char_end).toBe(endIdx);
    expect(cit.locator.page).toBe(12);
    expect(cit.locator.bbox).toBeDefined();
    expect(cit.cited_text).toBe("Meridian Trading Ltd");
    expect(cit.span_hash).toBeDefined();
    expect(cit.context_before).toContain("Share Purchase Agreement, ");
    expect(cit.context_after).toContain("transferred 100 percent");
    expect(cit.rendered_view.display_mode).toBe("original_document");
    expect(cit.rendered_view.full_text_snippet).toContain("⟦Meridian Trading Ltd⟧");
    expect(cit.is_broken).toBe(false);
    expect(cit.integrity_status).toBe("intact");
  });

  // ── AC-PRV-03: Span Drift Detection ───────────────────────────────────────
  it("AC-PRV-03 — Given evidence with span_hash H, When underlying content changes, Then marked span_drift and flagged", async () => {
    // Create evidence for "Kestrel Nominees"
    // "Kestrel Nominees" in sampleDocText:
    const kestrelIdx = sampleDocText.indexOf("Kestrel Nominees");
    const kestrelEnd = kestrelIdx + "Kestrel Nominees".length;

    const evRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: kestrelIdx,
        char_end: kestrelEnd,
        quoted_text: "Kestrel Nominees",
        evidence_type: "documentary",
        weight: "strong",
      },
    });
    expect(evRes.statusCode).toBe(201);
    const driftEvId = JSON.parse(evRes.body).id;

    // Simulate re-normalization / content drift by modifying block text
    await withTenant(tenantId, async (tx) => {
      await tx`
        UPDATE content_blocks
        SET text = 'MODIFIED VERSION: ' || ${sampleDocText}
        WHERE id = ${blockId};
      `;
    });

    // Run Drift Check Job
    const driftRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence/drift-check`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(driftRes.statusCode).toBe(200);
    const report: DriftCheckReport = JSON.parse(driftRes.body);
    expect(report.drifted_count).toBeGreaterThanOrEqual(1);
    expect(report.drifted_evidence_ids).toContain(driftEvId);

    // Verify citation resolver now reports broken citation
    const citRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/evidence/${driftEvId}/citation`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(citRes.statusCode).toBe(200);
    const cit: CitationResolutionResponse = JSON.parse(citRes.body);
    expect(cit.is_broken).toBe(true);
    expect(cit.integrity_status).toBe("span_drift");

    // Restore original text
    await withTenant(tenantId, async (tx) => {
      await tx`
        UPDATE content_blocks
        SET text = ${sampleDocText}
        WHERE id = ${blockId};
      `;
      await tx`
        UPDATE evidence
        SET integrity_status = 'intact'
        WHERE id = ${driftEvId};
      `;
    });
  });

  // ── AC-PRV-04: Full Derivation Chain ──────────────────────────────────────
  it("AC-PRV-04 — Given any evidence object, When user opens provenance, Then returns full 8-link derivation chain with no gaps", async () => {
    // "beneficial ownership" in sampleDocText
    const benIdx = sampleDocText.indexOf("beneficial ownership");
    const benEnd = benIdx + "beneficial ownership".length;

    const evRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sourceId,
        content_block_id: blockId,
        char_start: benIdx,
        char_end: benEnd,
        quoted_text: "beneficial ownership",
        evidence_type: "documentary",
        weight: "strong",
      },
    });
    expect(evRes.statusCode).toBe(201);
    const evId = JSON.parse(evRes.body).id;

    // Fetch Provenance Chain
    const provRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/evidence/${evId}/provenance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(provRes.statusCode).toBe(200);
    const prov: EvidenceProvenanceChain = JSON.parse(provRes.body);

    expect(prov.evidence_id).toBe(evId);
    expect(prov.source_id).toBe(sourceId);
    expect(prov.filename).toBe("Share_Purchase_Agreement_2019.pdf");
    expect(prov.is_complete).toBe(true);
    expect(prov.derivation_chain.length).toBe(8);

    const stages = prov.derivation_chain.map((s) => s.stage);
    expect(stages).toEqual([
      "source",
      "acquisition",
      "artifact",
      "content_document",
      "content_block",
      "span",
      "evidence",
      "admitting_actor",
    ]);

    // Check individual stage properties
    expect(prov.derivation_chain[0]!.stage).toBe("source");
    expect(prov.derivation_chain[0]!.metadata.filename).toBe("Share_Purchase_Agreement_2019.pdf");

    expect(prov.derivation_chain[1]!.stage).toBe("acquisition");
    expect(prov.derivation_chain[1]!.metadata.custodian).toBe("J. Okonkwo");

    expect(prov.derivation_chain[5]!.stage).toBe("span");
    expect(prov.derivation_chain[5]!.metadata.char_start).toBe(benIdx);
    expect(prov.derivation_chain[5]!.metadata.char_end).toBe(benEnd);

    expect(prov.derivation_chain[7]!.stage).toBe("admitting_actor");
    expect(prov.derivation_chain[7]!.actor).toBe("Elena Rostova");
  });
});
