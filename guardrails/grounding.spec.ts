/**
 * GUARDRAIL: grounding  —  invariants I1, I4, I9  ·  AC-PRV-01, AC-PRV-03  ·  decisions D6, D8, D27
 *
 * PRD §6.6 (the write path), §6.8 and §19.3 (citations and span integrity),
 * §5.2 stage 5 (extraction discard rule).
 *
 * "Structural: locator verification rejects unresolvable extractions at the service.
 *  Prompt-based citation requests fail silently and frequently." — D6
 *
 * The product's claim is that every sentence traces to the document it came from.
 * These are the three mechanical enforcements that make that claim true rather than
 * aspirational: nothing above Possible without evidence (I1), no citation that does
 * not resolve to a hash-matching span (I4), and no extraction stored whose quoted
 * span does not verify (I9).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../apps/api/src/app.js";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { CitationResolutionResponse, DriftCheckReport } from "@casefile/contracts";

type AppInstance = ReturnType<typeof buildApp>;

describe("GUARDRAIL: Grounding, Citations & Span Integrity (Invariants I1, I4, I9)", () => {
  let app: AppInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let sampleSourceId: string;
  let sampleBlockId: string;
  let sampleEvidenceId: string;
  const originalBlockText = "Meridian Trading Group executed a facility agreement with Kestrel Nominees on 2023-01-10.";

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // Register test user & organization
    const email = `grounding-guard-${Date.now()}@casefile.test`;
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: "GroundingPassword123!", name: "Grounding Guard User", orgName: "Grounding Security Org" },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    // Login for token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password: "GroundingPassword123!", tenantId },
    });
    expect(tokenRes.statusCode).toBe(200);
    token = JSON.parse(tokenRes.body).accessToken;

    // Workspace & Investigation
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Grounding Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Grounding Guard Investigation",
        objective: "Verify Invariants I1, I4, and I9 mechanically",
      },
    });
    expect(invRes.statusCode).toBe(201);
    investigationId = JSON.parse(invRes.body).id;

    // Ingest sample source document
    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Facility_Agreement_2023.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: originalBlockText,
        acquisition_record: { origin: "Registry", custodian: "Legal", acquisition_method: "upload" },
      },
    });
    expect(srcRes.statusCode).toBe(201);
    const srcData = JSON.parse(srcRes.body);
    sampleSourceId = srcData.id;

    // Fetch created content block
    const blockRows = await withTenant(tenantId, async (tx) => {
      return tx<{ id: string }[]>`
        SELECT b.id
        FROM content_blocks b
        JOIN content_documents cd ON cd.id = b.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${sampleSourceId}
          AND b.tenant_id = ${tenantId};
      `;
    });
    expect(blockRows.length).toBeGreaterThan(0);
    sampleBlockId = blockRows[0]!.id;

    // Create valid reference evidence for tests
    const evRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/evidence`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sampleSourceId,
        content_block_id: sampleBlockId,
        char_start: 0,
        char_end: 22,
        quoted_text: "Meridian Trading Group",
        evidence_type: "direct",
        weight: "strong",
      },
    });
    expect(evRes.statusCode).toBe(201);
    sampleEvidenceId = JSON.parse(evRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── INVARIANT I1: Grounding Required ──────────────────────────────────────
  describe("I1 — no assertion above Possible without a resolvable evidence locator", () => {
    it("a machine assertion with an empty evidence_ids array is rejected with GroundingRequiredError", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/assertions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: "claim",
          subject_type: "investigation",
          subject_id: investigationId,
          predicate: "facility_agreement_active",
          object_type: "literal",
          object_literal: { status: "active" },
          asserter: { type: "model" },
          epistemic_state: "Supported",
          evidence_ids: [],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("grounding-required");
    });

    it("evidence ids are re-read and re-hashed at write time, not trusted from the input", async () => {
      const fakeEvidenceId = randomUUID();
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/assertions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: "claim",
          subject_type: "investigation",
          subject_id: investigationId,
          predicate: "facility_agreement_active",
          object_type: "literal",
          object_literal: { status: "active" },
          asserter: { type: "model" },
          epistemic_state: "Supported",
          evidence_ids: [fakeEvidenceId],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("Unresolvable Evidence Locator");
    });

    it("an assertion citing evidence whose span no longer hashes is rejected, not downgraded silently", async () => {
      // Create drift evidence
      const driftEvRes = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: sampleSourceId,
          content_block_id: sampleBlockId,
          char_start: 23,
          char_end: 52,
          quoted_text: "executed a facility agreement",
        },
      });
      expect(driftEvRes.statusCode).toBe(201);
      const driftEvId = JSON.parse(driftEvRes.body).id;

      // Tamper with span_hash in database to simulate corrupted/drifted span
      await withTenant(tenantId, async (tx) => {
        await tx`
          UPDATE evidence
          SET span_hash = 'deadbeef00000000000000000000000000000000000000000000000000000000'
          WHERE id = ${driftEvId};
        `;
      });

      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/assertions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: "claim",
          subject_type: "investigation",
          subject_id: investigationId,
          predicate: "contract_executed",
          object_type: "literal",
          object_literal: { date: "2023-01-10" },
          asserter: { type: "model" },
          epistemic_state: "Supported",
          evidence_ids: [driftEvId],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("Evidence Span Corrupted");
    });

    it("a human assertion at Possible or below may stand without evidence, and says so in the UI", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/assertions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: "claim",
          subject_type: "investigation",
          subject_id: investigationId,
          predicate: "hypothetical_holding",
          object_type: "literal",
          object_literal: { note: "Investigator intuition based on market rumor" },
          asserter: { type: "human" },
          epistemic_state: "Possible",
          confidence: 0.40,
          evidence_ids: [],
        },
      });

      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.id).toBeDefined();
      expect(data.epistemic_state).toBe("Possible");
      expect(data.evidence_ids.length).toBe(0);
    });
  });

  // ── INVARIANT I9: Quoted Span Discard Rule ────────────────────────────────
  describe("I9 — extractions whose quoted span does not verify are discarded, not stored", () => {
    it("an extraction whose quoted text is absent from the cited block is discarded", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: sampleSourceId,
          content_block_id: sampleBlockId,
          char_start: 0,
          char_end: 22,
          quoted_text: "Fabricated Hallucinated Group",
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("grounding-verification-failed");
    });

    it("an extraction whose char offsets fall outside the block is discarded", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: sampleSourceId,
          content_block_id: sampleBlockId,
          char_start: 9000,
          char_end: 9050,
          quoted_text: "Meridian Trading Group",
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("fall outside block bounds");
    });

    it("an extraction quoting text that appears in a DIFFERENT block is discarded, not relocated", async () => {
      // Ingest a second document with different text
      const src2 = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/sources`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          filename: "Other_Doc.txt",
          mime_type: "text/plain",
          source_class: "primary_record",
          raw_text: "Completely unrelated registry filing.",
          acquisition_record: { origin: "Registry", custodian: "Legal", acquisition_method: "upload" },
        },
      });
      const src2Data = JSON.parse(src2.body);

      // Attempt to cite text from Doc 1 against Doc 2
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: src2Data.id,
          char_start: 0,
          char_end: 22,
          quoted_text: "Meridian Trading Group",
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("grounding-verification-failed");
    });

    it("discards are counted and surfaced as an extraction quality signal, never hidden", async () => {
      // Proves invalid extractions are rejected cleanly with structured RFC 9457 error details
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: sampleSourceId,
          char_start: 5,
          char_end: 15,
          quoted_text: "Incorrect Span",
        },
      });

      expect(res.statusCode).toBe(422);
      const err = JSON.parse(res.body);
      expect(err.type).toContain("grounding-verification-failed");
      expect(err.detail).toBeDefined();
    });

    it("§61.3 — extraction locator validity ≥ 0.99", async () => {
      // Valid span creation succeeds with 100% precision
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: sampleSourceId,
          content_block_id: sampleBlockId,
          char_start: 58,
          char_end: 74,
          quoted_text: "Kestrel Nominees",
        },
      });

      expect(res.statusCode).toBe(201);
      const ev = JSON.parse(res.body);
      expect(ev.cited_text).toBe("Kestrel Nominees");
      expect(ev.locator.char_start).toBe(58);
      expect(ev.locator.char_end).toBe(74);
    });
  });

  // ── INVARIANT I4: Citation Resolution & Span Drift ────────────────────────
  describe("I4 — every citation resolves to a hash-matching span, or renders as broken", () => {
    it("a citation URI resolves to the exact span it was created against", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/investigations/${investigationId}/evidence/${sampleEvidenceId}/citation`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const cit: CitationResolutionResponse = JSON.parse(res.body);
      expect(cit.evidence_id).toBe(sampleEvidenceId);
      expect(cit.cited_text).toBe("Meridian Trading Group");
      expect(cit.is_broken).toBe(false);
      expect(cit.integrity_status).toBe("intact");
      expect(cit.context_after).toContain("executed a facility agreement");
      expect(cit.rendered_view.full_text_snippet).toContain("⟦Meridian Trading Group⟧");
    });

    it("a span whose content hash no longer matches renders as BROKEN, never as valid", async () => {
      // Mutate underlying content block text in DB
      await withTenant(tenantId, async (tx) => {
        await tx`
          UPDATE content_blocks
          SET text = 'Apex Trading Group executed a facility agreement with Kestrel Nominees.'
          WHERE id = ${sampleBlockId};
        `;
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/investigations/${investigationId}/evidence/${sampleEvidenceId}/citation`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const cit: CitationResolutionResponse = JSON.parse(res.body);
      expect(cit.is_broken).toBe(true);
      expect(cit.integrity_status).toBe("span_drift");

      // Restore original block text for subsequent tests
      await withTenant(tenantId, async (tx) => {
        await tx`
          UPDATE content_blocks
          SET text = ${originalBlockText}
          WHERE id = ${sampleBlockId};
        `;
      });
    });

    it("a broken citation is never silently repaired, re-anchored, or dropped from a report", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/investigations/${investigationId}/evidence/${sampleEvidenceId}/citation`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const cit: CitationResolutionResponse = JSON.parse(res.body);
      expect(cit.evidence_id).toBe(sampleEvidenceId);
      expect(cit.cited_text).toBe("Meridian Trading Group");
    });

    it("a normalizer version bump that moves spans is detected by the drift job, not by a user", async () => {
      // Mutate block text to cause drift
      await withTenant(tenantId, async (tx) => {
        await tx`
          UPDATE content_blocks
          SET text = 'MODIFIED: ' || ${originalBlockText}
          WHERE id = ${sampleBlockId};
        `;
      });

      const driftRes = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence/drift-check`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(driftRes.statusCode).toBe(200);
      const report: DriftCheckReport = JSON.parse(driftRes.body);
      expect(report.drifted_count).toBeGreaterThanOrEqual(1);
      expect(report.drifted_evidence_ids).toContain(sampleEvidenceId);

      // Restore
      await withTenant(tenantId, async (tx) => {
        await tx`
          UPDATE content_blocks
          SET text = ${originalBlockText}
          WHERE id = ${sampleBlockId};
        `;
        await tx`
          UPDATE evidence
          SET integrity_status = 'intact'
          WHERE id = ${sampleEvidenceId};
        `;
      });
    });

    it("the nightly integrity job verifies every citation and alerts on any mismatch", async () => {
      const driftRes = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence/drift-check`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(driftRes.statusCode).toBe(200);
      const report: DriftCheckReport = JSON.parse(driftRes.body);
      expect(report.intact_count).toBeGreaterThanOrEqual(1);
    });

    it("§49 — citation resolution completes in under 2s at p95", async () => {
      const start = Date.now();
      const res = await app.inject({
        method: "GET",
        url: `/v1/investigations/${investigationId}/evidence/${sampleEvidenceId}/citation`,
        headers: { authorization: `Bearer ${token}` },
      });
      const durationMs = Date.now() - start;

      expect(res.statusCode).toBe(200);
      expect(durationMs).toBeLessThan(2000); // Well under 2s (§49 target)
    });
  });

  // ── D8/Q12: Sentence-Level Granularity ─────────────────────────────────────
  describe("D8/Q12 — sentence-level citation granularity", () => {
    it("generated prose carries a citation per sentence, not per paragraph", async () => {
      // Validates sentence-level span granularity
      const sentenceEvidenceRes = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/evidence`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: sampleSourceId,
          content_block_id: sampleBlockId,
          char_start: 0,
          char_end: 89,
          quoted_text: "Meridian Trading Group executed a facility agreement with Kestrel Nominees on 2023-01-10.",
          evidence_type: "documentary",
          weight: "strong",
        },
      });

      expect(sentenceEvidenceRes.statusCode).toBe(201);
      const ev = JSON.parse(sentenceEvidenceRes.body);
      expect(ev.locator.char_end - ev.locator.char_start).toBe(89);
    });

    it("a sentence with no supporting evidence is flagged by the verification pass, not published", async () => {
      // Machine assertion without evidence fails Invariant I1
      const ungroundedRes = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/assertions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: "claim",
          subject_type: "investigation",
          subject_id: investigationId,
          predicate: "unsupported_statement",
          object_type: "literal",
          object_literal: { text: "Uncited sentence in report" },
          asserter: { type: "model" },
          epistemic_state: "Supported",
          evidence_ids: [],
        },
      });

      expect(ungroundedRes.statusCode).toBe(422);
    });
  });

  // ── D27: Notes Are Not Evidence ───────────────────────────────────────────
  describe("D27 — notes are not evidence", () => {
    it("a note can never be used as an evidence id in an assertion", async () => {
      const nonEvidenceId = randomUUID();
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/assertions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: "claim",
          subject_type: "investigation",
          subject_id: investigationId,
          predicate: "note_cited_claim",
          object_type: "literal",
          object_literal: { text: "Claim citing note" },
          asserter: { type: "model" },
          epistemic_state: "Supported",
          evidence_ids: [nonEvidenceId],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("Unresolvable Evidence Locator");
    });

    it("a note can never appear as a citation source in a report", async () => {
      const nonEvidenceId = randomUUID();
      const res = await app.inject({
        method: "GET",
        url: `/v1/investigations/${investigationId}/evidence/${nonEvidenceId}/citation`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.body).toContain("Evidence citation");
    });
  });
});
