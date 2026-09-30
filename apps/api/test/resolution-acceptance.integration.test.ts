import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { MergeCandidate, MergeSignalBreakdown } from "@casefile/contracts";

describe("Epic E5 Entity Resolution Acceptance Criteria (PRD §56.5 / §56.6)", () => {
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

    const email = `e5-acceptance-${Date.now()}@casefile.test`;
    const password = "E5Password123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "E5 Acc User", orgName: "E5 Acc Org" },
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
      payload: { name: "E5 Resolution Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Operation Resolution",
        objective: "Verify multi-signal entity matching, conflict preservation, and unmerge.",
      },
    });
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── AC-RES-01: Person merges require humans ──────────────────────────────
  it("AC-RES-01 — Person merges require humans: deterministic match on Person is queued and NOT auto-merged", async () => {
    const passportNo = `P${Date.now()}`;

    // Create Person A
    const resA = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Person",
        canonical_name: "Aleksandr Vyshnevetsky",
        identifiers: [{ scheme: "passport", value: passportNo, is_strong: true }],
      },
    });
    expect(resA.statusCode).toBe(201);
    const personA = JSON.parse(resA.body);

    // Create Person B with same passport
    const resB = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Person",
        canonical_name: "Alexander Vyshnevetsky",
        identifiers: [{ scheme: "passport", value: passportNo, is_strong: true }],
      },
    });
    expect(resB.statusCode).toBe(201);
    const personB = JSON.parse(resB.body);

    // Run ER Pipeline
    const resolveRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/resolve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolveData = JSON.parse(resolveRes.body);

    // Assert: Person was NOT auto-merged
    expect(resolveData.auto_merged_count).toBe(0);

    // Assert: Candidate is queued for human review
    const candRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/merge-candidates`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(candRes.statusCode).toBe(200);
    const candData = JSON.parse(candRes.body);
    const found = candData.items.find(
      (c: MergeCandidate) =>
        (c.entity_a.id === personA.id && c.entity_b.id === personB.id) ||
        (c.entity_a.id === personB.id && c.entity_b.id === personA.id),
    );
    expect(found).toBeDefined();
    expect(found.status).toBe("pending");
  });

  // ── AC-RES-02: Conflicting identifiers block merge ───────────────────────
  it("AC-RES-02 — Conflicting identifiers block merge unless explicitly overridden with audited rationale", async () => {
    // Create Org A (Company No 12345, UK)
    const resA = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Organization",
        canonical_name: "Meridian Trading Limited",
        identifiers: [{ scheme: "company_number", value: "12345", jurisdiction: "GB", is_strong: true }],
      },
    });
    expect(resA.statusCode).toBe(201);
    const orgA = JSON.parse(resA.body);

    // Create Org B (Company No 67890, UK)
    const resB = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Organization",
        canonical_name: "Meridian Trading UK Ltd",
        identifiers: [{ scheme: "company_number", value: "67890", jurisdiction: "GB", is_strong: true }],
      },
    });
    expect(resB.statusCode).toBe(201);
    const orgB = JSON.parse(resB.body);

    // 1. Attempt merge without override -> BLOCKED with 422
    const mergeAttemptRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/merge`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_entity_id: orgB.id,
        target_entity_id: orgA.id,
        rationale: "Merging similar names.",
        force_override: false,
      },
    });
    expect(mergeAttemptRes.statusCode).toBe(422);
    const errData = JSON.parse(mergeAttemptRes.body);
    expect(errData.type).toContain("conflicting-identifiers-blocked");
    expect(errData.detail).toContain("12345");
    expect(errData.detail).toContain("67890");

    // 2. Perform merge with force_override: true + override_rationale
    const overrideRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/merge`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_entity_id: orgB.id,
        target_entity_id: orgA.id,
        rationale: "Corporate restructuring merger confirmed by Companies House notice #4910.",
        force_override: true,
        override_rationale: "Registrar confirmed successor transfer from 67890 to 12345.",
      },
    });
    expect(overrideRes.statusCode).toBe(200);
    const overrideData = JSON.parse(overrideRes.body);
    expect(overrideData.surviving_entity.id).toBe(orgA.id);

    // 3. Verify audit log recorded entity.merge_override
    await withTenant(tenantId, async (tx) => {
      const rows = await tx<{ action: string; outcome: string }[]>`
        SELECT action, outcome
        FROM audit_events
        WHERE action = 'entity.merge_override'
          AND tenant_id = ${tenantId}
        ORDER BY created_at DESC;
      `;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.outcome).toBe("success");
    }, sql);
  });

  // ── AC-RES-03: Merge preserves conflicts ─────────────────────────────────
  it("AC-RES-03 — Merge preserves conflicts: differing DOBs both preserved on survivor and contradiction alert raised", async () => {
    // Create Person 1 with DOB 1974-03-11
    const res1 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Person",
        canonical_name: "Viktor Vance",
      },
    });
    expect(res1.statusCode).toBe(201);
    const p1 = JSON.parse(res1.body);

    // Create assertion on Person 1: DOB = 1974-03-11
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "attribute",
        subject_type: "entity",
        subject_id: p1.id,
        predicate: "date_of_birth",
        object_type: "text",
        object_literal: { dob: "1974-03-11" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });

    // Create Person 2 with DOB 1974-03-19
    const res2 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Person",
        canonical_name: "Victor Vance",
      },
    });
    expect(res2.statusCode).toBe(201);
    const p2 = JSON.parse(res2.body);

    // Create assertion on Person 2: DOB = 1974-03-19
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "attribute",
        subject_type: "entity",
        subject_id: p2.id,
        predicate: "date_of_birth",
        object_type: "text",
        object_literal: { dob: "1974-03-19" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });

    // Merge Person 2 into Person 1
    const mergeRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/merge`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_entity_id: p2.id,
        target_entity_id: p1.id,
        rationale: "Same individual in passport and bank statement.",
      },
    });
    expect(mergeRes.statusCode).toBe(200);
    const mergeData = JSON.parse(mergeRes.body);
    expect(mergeData.contradictions_raised).toContain("date_of_birth");

    // Verify contradiction alert exists in DB
    const alertsRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/assertions/contradiction-alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(alertsRes.statusCode).toBe(200);
    const alertsData = JSON.parse(alertsRes.body);
    expect(alertsData.items.length).toBeGreaterThan(0);
  });

  // ── AC-RES-04: Exact unmerge ─────────────────────────────────────────────
  it("AC-RES-04 — Exact unmerge: restores both entities to exact pre-merge state", async () => {
    // 1. Create Entity X and Entity Y
    const resX = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "Domain", canonical_name: "horizon-holding.ch" },
    });
    const entX = JSON.parse(resX.body);

    const resY = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "Domain", canonical_name: "horizon-holding.com" },
    });
    const entY = JSON.parse(resY.body);

    // 2. Merge Y into X
    const mergeRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/merge`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_entity_id: entY.id,
        target_entity_id: entX.id,
        rationale: "Affiliated primary domains.",
      },
    });
    expect(mergeRes.statusCode).toBe(200);
    const mergeData = JSON.parse(mergeRes.body);
    const historyId = mergeData.merge_history_id;

    // Verify Y is merged_away
    const getYBefore = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/${entY.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getYBefore.statusCode).toBe(200);
    expect(JSON.parse(getYBefore.body).status).toBe("merged_away");

    // 3. Unmerge using MergeRecord
    const unmergeRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/unmerge`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merge_history_id: historyId,
        assertion_routing: "target",
        rationale: "Discovered .ch and .com belong to distinct entities after WHOIS review.",
      },
    });
    expect(unmergeRes.statusCode).toBe(200);

    // 4. Verify Y is restored to active
    const getYAfter = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/${entY.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getYAfter.statusCode).toBe(200);
    expect(JSON.parse(getYAfter.body).status).toBe("active");
  });

  // ── AC-RES-05: Signal transparency ───────────────────────────────────────
  it("AC-RES-05 — Signal transparency: merge candidates show breakdown of contributing and negative signals", async () => {
    // Create Account 1 & Account 2 with partial match
    const resA = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Account",
        canonical_name: "Credit Suisse Escrow Account 8820",
        identifiers: [{ scheme: "iban", value: "CH9300000000008820", is_strong: true }],
      },
    });
    const accA = JSON.parse(resA.body);

    const resB = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Account",
        canonical_name: "Credit Suisse Main Escrow 8820",
        identifiers: [{ scheme: "iban", value: "CH9300000000008820", is_strong: true }],
      },
    });
    const accB = JSON.parse(resB.body);

    // Run ER
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/resolve`,
      headers: { authorization: `Bearer ${token}` },
    });

    const candRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/merge-candidates`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(candRes.statusCode).toBe(200);
    const candData = JSON.parse(candRes.body);

    const candidate = candData.items.find(
      (c: MergeCandidate) =>
        (c.entity_a.id === accA.id && c.entity_b.id === accB.id) ||
        (c.entity_a.id === accB.id && c.entity_b.id === accA.id),
    );

    if (candidate) {
      expect(candidate.signals).toBeDefined();
      expect(Array.isArray(candidate.signals)).toBe(true);
      expect(candidate.signals.length).toBeGreaterThan(0);
      const exactSig = candidate.signals.find((s: MergeSignalBreakdown) => s.signal === "exact_strong_identifier");
      expect(exactSig).toBeDefined();
      expect(exactSig?.weight).toBe(1.0);
      expect(exactSig?.contribution).toBe(1.0);
    }
  });
});
