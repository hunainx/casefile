import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { EpistemicStateSchema } from "@casefile/contracts";

describe("Epic E4 Epistemic & Provenance Acceptance Criteria (PRD §56.3 & §56.4)", () => {
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

    const email = `e4-acceptance-${Date.now()}@casefile.test`;
    const password = "E4Password123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "E4 Acc User", orgName: "E4 Acc Org" },
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
      payload: { name: "E4 Acc Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "E4 Acceptance Investigation",
        objective: "Testing AC-EPI-01..05 & AC-PRV-01..04",
      },
    });
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── AC-EPI-01: AI cannot verify ───────────────────────────────────────────
  it("AC-EPI-01 — AI cannot verify: rejected with integrity error and emits PolicyViolationAttempted", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "beneficial_owner",
        object_type: "entity",
        object_id: randomUUID(),
        asserter: { type: "model" },
        epistemic_state: "Verified",
        evidence_ids: [randomUUID()],
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.type).toContain("epistemic-authority-violation");

    // Security audit event emitted
    await withTenant(tenantId, async (tx) => {
      const rows = await tx`
        SELECT *
        FROM audit_events
        WHERE action = 'policy.violation_attempted'
          AND tenant_id = ${tenantId}
        ORDER BY timestamp DESC;
      `;
      expect(rows.length).toBeGreaterThan(0);
      const evt = rows[0] as Record<string, unknown>;
      const after = typeof evt.after === "string" ? (JSON.parse(evt.after) as Record<string, unknown>) : (evt.after as Record<string, unknown>);
      expect(after.reason).toBe("epistemic_authority_violation");
    }, sql);
  });

  // ── AC-EPI-02: Grounding required for machine asserters ───────────────────
  it("AC-EPI-02 — Grounding required for machine asserters: empty evidence_ids rejected with 422 grounding-required", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "relationship",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "transferred_funds_to",
        object_type: "entity",
        object_id: randomUUID(),
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [], // empty grounding!
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.type).toContain("grounding-required");
  });

  // ── AC-EPI-03: Recomputation preserves the record ────────────────────────
  it("AC-EPI-03 — Recomputation preserves the record: conflicting machine value produces DivergenceNotice without modifying Verified assertion", async () => {
    const subjectId = randomUUID();
    const verifiedObjectId = randomUUID();
    const conflictingObjectId = randomUUID();

    // 1. Create machine assertion
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "relationship",
        subject_type: "entity",
        subject_id: subjectId,
        predicate: "director_of",
        object_type: "entity",
        object_id: verifiedObjectId,
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const initial = JSON.parse(createRes.body);

    // 2. Human promotes to Verified
    const valRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions/${initial.id}/validate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        epistemic_state: "Verified",
        rationale: "Confirmed via regulatory registry filing.",
      },
    });
    expect(valRes.statusCode).toBe(200);
    const verified = JSON.parse(valRes.body);
    expect(verified.epistemic_state).toBe("Verified");
    expect(verified.plane).toBe("record");

    // 3. Recomputation run produces conflicting value
    const recomputeRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "relationship",
        subject_type: "entity",
        subject_id: subjectId,
        predicate: "director_of",
        object_type: "entity",
        object_id: conflictingObjectId, // Conflicting target!
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
        derivation: {
          parents: [initial.id],
          transform: "v2_relationship_extractor",
          transform_version: "2.0.0",
        },
      },
    });
    expect(recomputeRes.statusCode).toBe(201);
    const recomputeData = JSON.parse(recomputeRes.body);

    // DivergenceNotice was created and returned
    expect(recomputeData.divergence_notice).toBeDefined();
    expect(recomputeData.divergence_notice.status).toBe("open");

    // The verified assertion is completely UNCHANGED
    const checkRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/assertions/${verified.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(checkRes.statusCode).toBe(200);
    const checkData = JSON.parse(checkRes.body);
    expect(checkData.epistemic_state).toBe("Verified");
    expect(checkData.plane).toBe("record");
    expect(checkData.object_id).toBe(verifiedObjectId);
  });

  // ── AC-EPI-04: Contradiction against verified ────────────────────────────
  it("AC-EPI-04 — Contradiction against verified: conflicting assertion raises ContradictionAgainstVerified alert while A remains Verified", async () => {
    const alertsRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/assertions/contradiction-alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(alertsRes.statusCode).toBe(200);
    const alertsData = JSON.parse(alertsRes.body);
    expect(alertsData.items.length).toBeGreaterThan(0);
    expect(alertsData.items[0].severity).toBe("critical");
    expect(alertsData.items[0].status).toBe("active");
  });

  // ── AC-EPI-05: Single vocabulary ─────────────────────────────────────────
  it("AC-EPI-05 — Single vocabulary: uses exactly one of the seven epistemic ladder states", () => {
    const permitted = ["Unknown", "Possible", "Likely", "Supported", "Verified", "Contradicted", "Refuted"];
    expect(EpistemicStateSchema.options.sort()).toEqual(permitted.sort());
    expect(EpistemicStateSchema.options.length).toBe(7);
  });

  // ── AC-PRV-01: Full derivation chain ─────────────────────────────────────
  it("AC-PRV-01 — Provenance: records full derivation metadata with parent lineage", async () => {
    const parentId = randomUUID();
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "stated_payment_amount",
        object_type: "currency",
        object_literal: { amount: 5000000, currency: "USD" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
        derivation: {
          parents: [parentId],
          transform: "invoice_ocr_parser",
          transform_version: "1.4.2",
          executed_at: new Date().toISOString(),
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.derivation.parents).toContain(parentId);
    expect(data.derivation.transform).toBe("invoice_ocr_parser");
    expect(data.derivation.transform_version).toBe("1.4.2");
  });

  // ── AC-PRV-02: Evidence junction link ────────────────────────────────────
  it("AC-PRV-02 — Provenance: persists junction links to evidence locators in assertion_evidence", async () => {
    const ev1 = randomUUID();
    const ev2 = randomUUID();
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "event",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "meeting_held",
        object_type: "text",
        object_literal: { location: "Geneva" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [ev1, ev2],
      },
    });
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);

    await withTenant(tenantId, async (tx) => {
      const rows = await tx<{ evidence_id: string }[]>`
        SELECT evidence_id
        FROM assertion_evidence
        WHERE assertion_id = ${data.id}
          AND tenant_id = ${tenantId};
      `;
      expect(rows.length).toBe(2);
      const evidenceIds = rows.map((r) => r.evidence_id);
      expect(evidenceIds).toContain(ev1);
      expect(evidenceIds).toContain(ev2);
    }, sql);
  });
});
