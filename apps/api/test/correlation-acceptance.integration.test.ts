import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import type postgres from "postgres";
import type {
  Contradiction,
  ResearchGap,
  SuppressionRule,
} from "@casefile/contracts";

type AppInstance = ReturnType<typeof buildApp>;

describe("Epic E9 — Contradictions & Research Gaps Acceptance Tests (AC-CON-01..04, AC-GAP-01..03)", () => {
  let app: AppInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let entityId: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // 1. Register User & Org
    const email = `correlation-acceptance-${Date.now()}@casefile.test`;
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password: "CorrelationPassword123!",
        name: "Arthur Vance",
        orgName: "Vance Intelligence Analytics",
      },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    // 2. Token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password: "CorrelationPassword123!", tenantId },
    });
    token = JSON.parse(tokenRes.body).accessToken;

    // 3. Workspace & Investigation
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Correlation Analysis Unit" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Project Meridian Contradictions & Gaps",
        objective: "Detect structural contradictions and unaddressed evidence gaps in Meridian Trading Ltd.",
      },
    });
    investigationId = JSON.parse(invRes.body).id;

    // 4. Create focal target entity
    const entRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        canonical_name: "Meridian Trading Ltd",
        type: "Organization",
        is_focal: true,
      },
    });
    expect(entRes.statusCode).toBe(201);
    entityId = JSON.parse(entRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── AC-CON-01: Precision Differences are NOT Contradictions ─────────────────
  it("AC-CON-01 — Given two assertions dating an event 'March 2019' and '3 March 2019' -> No contradiction is raised", async () => {
    // Admit Assertion 1: "March 2019"
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "event",
        subject_type: "entity",
        subject_id: entityId,
        predicate: "facility_agreement_executed",
        object_type: "text",
        object_literal: { raw: "Facility agreement executed" },
        valid_from: { raw: "March 2019" },
        asserter: { type: "human" },
        epistemic_state: "Likely",
        confidence: 0.85,
        evidence_ids: [],
      },
    });

    // Admit Assertion 2: "3 March 2019" (more specific date in same month)
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "event",
        subject_type: "entity",
        subject_id: entityId,
        predicate: "facility_agreement_executed",
        object_type: "text",
        object_literal: { raw: "Facility agreement executed" },
        valid_from: { raw: "3 March 2019" },
        asserter: { type: "human" },
        epistemic_state: "Supported",
        confidence: 0.9,
        evidence_ids: [],
      },
    });

    // Query Contradictions
    const res = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/contradictions`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const dateConflicts = body.items.filter(
      (c: Contradiction) => c.detector === "temporal_conflict" && c.description.includes("facility_agreement_executed"),
    );
    expect(dateConflicts.length).toBe(0);
  });

  // ── AC-CON-02: Temporal Impossibility / Divergent Dates Detected ────────────
  it("AC-CON-02 — Given two assertions dating the same event '2019-03-03' and '2019-03-07' -> Contradiction raised with temporal_conflict", async () => {
    // Admit Assertion A: 2019-03-03
    const asstA = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "event",
        subject_type: "entity",
        subject_id: entityId,
        predicate: "funds_disbursed",
        object_type: "text",
        object_literal: { raw: "Funds disbursed" },
        valid_from: { raw: "2019-03-03" },
        asserter: { type: "human" },
        epistemic_state: "Supported",
        confidence: 0.88,
        evidence_ids: [],
      },
    });
    if (asstA.statusCode !== 201) {
      console.error("asstA FAILED:", asstA.statusCode, asstA.body);
    }
    expect(asstA.statusCode).toBe(201);
    const asstAId = JSON.parse(asstA.body).id;

    // Admit Assertion B: 2019-03-07 (contradictory day for same event)
    const asstB = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "event",
        subject_type: "entity",
        subject_id: entityId,
        predicate: "funds_disbursed",
        object_type: "text",
        object_literal: { raw: "Funds disbursed" },
        valid_from: { raw: "2019-03-07" },
        asserter: { type: "human" },
        epistemic_state: "Verified",
        confidence: 0.99,
        evidence_ids: [],
      },
    });
    expect(asstB.statusCode).toBe(201);
    const asstBId = JSON.parse(asstB.body).id;

    // Trigger & Fetch Contradictions
    const res = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/contradictions`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const conflict = body.items.find(
      (c: Contradiction) =>
        c.detector === "temporal_conflict" &&
        ((c.assertion_a_id === asstAId && c.assertion_b_id === asstBId) ||
          (c.assertion_a_id === asstBId && c.assertion_b_id === asstAId)),
    );

    expect(conflict).toBeDefined();
    expect(conflict.status).toBe("open");
    expect(conflict.severity).toBe("critical"); // Touches Verified assertion
    expect(conflict.severity_basis).toContain("Verified");
    expect(conflict.description).toContain("2019-03-03");
    expect(conflict.description).toContain("2019-03-07");
  });

  // ── AC-CON-03: Mandatory Rationale on Adjudication ──────────────────────────
  it("AC-CON-03 — Given an open contradiction, resolving without rationale is rejected with HTTP 400", async () => {
    // List contradictions to find an open one
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/contradictions`,
      headers: { authorization: `Bearer ${token}` },
    });
    const contradiction: Contradiction = JSON.parse(listRes.body).items[0];
    expect(contradiction).toBeDefined();

    // Attempt resolution with empty rationale
    const res = await app.inject({
      method: "POST",
      url: `/v1/contradictions/${contradiction.id}/adjudicate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        resolution_type: "a_correct",
        rationale: "",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.detail).toContain("rationale");
  });

  // ── AC-CON-04: False Positive Dismissal Creates Suppression Rule ────────────
  it("AC-CON-04 — Given a contradiction dismissed as false positive with a suppression rule -> subsequent detection suppresses it", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/contradictions`,
      headers: { authorization: `Bearer ${token}` },
    });
    const contradiction: Contradiction = JSON.parse(listRes.body).items[0];

    // Adjudicate as false_positive with suppression rule
    const adjRes = await app.inject({
      method: "POST",
      url: `/v1/contradictions/${contradiction.id}/adjudicate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        resolution_type: "false_positive",
        rationale: "Both dates represent dual tranches of a single capital facility.",
        create_suppression_rule: true,
      },
    });

    expect(adjRes.statusCode).toBe(200);
    const updated: Contradiction = JSON.parse(adjRes.body);
    expect(updated.status).toBe("dismissed");
    expect(updated.suppression_rule_id).toBeDefined();

    // Verify suppression rules list
    const rulesRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/contradictions/suppression-rules`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rulesRes.statusCode).toBe(200);
    const rules: SuppressionRule[] = JSON.parse(rulesRes.body).items;
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules[0]!.active).toBe(true);
  });

  // ── AC-GAP-01: Missing Referenced Document Detection ────────────────────────
  it("AC-GAP-01 — Given a document containing 'as set out in the Side Letter dated 12 August 2019' -> Gap referenced_but_absent is raised", async () => {
    const rawText = "The management fees and bonus structure are determined as set out in the Side Letter dated 12 August 2019 between the partners.";

    // Ingest Primary Agreement referencing absent Side Letter
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Partnership_Framework_Agreement.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        raw_text: rawText,
        acquisition_record: {
          origin: "Client Production",
          custodian: "Arthur Vance",
          acquisition_method: "upload",
        },
      },
    });

    // Query Research Gaps
    const gapsRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/gaps`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(gapsRes.statusCode).toBe(200);
    const gaps: ResearchGap[] = JSON.parse(gapsRes.body).items;
    const missingDocGap = gaps.find(
      (g) => g.gap_type === "referenced_but_absent" && g.title.toLowerCase().includes("side letter"),
    );

    expect(missingDocGap).toBeDefined();
    expect(missingDocGap!.status).toBe("open");
    expect(missingDocGap!.priority).toBe("high");
    expect(missingDocGap!.suggested_actions.length).toBeGreaterThan(0);
  });

  // ── AC-GAP-02: Gap Auto-Closure on Document Ingestion ───────────────────────
  it("AC-GAP-02 — Given an open gap for missing Side Letter, ingesting the matching document automatically closes the gap", async () => {
    // 1. Confirm gap is open
    const gapsResBefore = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/gaps`,
      headers: { authorization: `Bearer ${token}` },
    });
    const gapsBefore: ResearchGap[] = JSON.parse(gapsResBefore.body).items;
    const targetGap = gapsBefore.find(
      (g) => g.gap_type === "referenced_but_absent" && g.title.toLowerCase().includes("side letter"),
    );
    expect(targetGap).toBeDefined();
    expect(targetGap!.status).toBe("open");

    // 2. Ingest the missing Side Letter document
    const sideLetterText = "This Side Letter dated 12 August 2019 sets out the executive management fee calculation.";
    const ingestRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Side_Letter_2019_08_12.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        raw_text: sideLetterText,
        acquisition_record: {
          origin: "Supplemental Production",
          custodian: "Arthur Vance",
          acquisition_method: "upload",
        },
      },
    });
    expect(ingestRes.statusCode).toBe(201);

    // 3. Verify gap has transitioned to closed
    const gapsResAfter = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/gaps`,
      headers: { authorization: `Bearer ${token}` },
    });
    const gapsAfter: ResearchGap[] = JSON.parse(gapsResAfter.body).items;
    const closedGap = gapsAfter.find((g) => g.id === targetGap!.id);

    expect(closedGap).toBeDefined();
    expect(closedGap!.status).toBe("closed");
    expect(closedGap!.resolution_rationale).toContain("Automatically resolved");
  });

  // ── AC-GAP-03: Accepted as Unresolvable Flows with Rationale ─────────────────
  it("AC-GAP-03 — Given a gap marked accepted_as_unresolvable with rationale -> Rationale is recorded and persisted", async () => {
    // Create an investigative gap (e.g. offshore bank account holder)
    const gapRes = await withTenant(tenantId, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO research_gaps (
          id, tenant_id, investigation_id, gap_type, title, description,
          priority, priority_basis, status
        )
        VALUES (
          gen_random_uuid(), ${tenantId}, ${investigationId}, 'missing_counterparty',
          'Beneficial Owner of Panamanian Escrow Account',
          'Panamanian registry extract does not identify beneficial ownership of escrow holding account.',
          'critical', 'Core question on illicit financial pipeline cannot be answered without escrow identity.', 'open'
        )
        RETURNING id;
      `;
      return rows[0]!;
    }, sql);

    // Accept gap as unresolvable
    const rationale = "Panama banking secrecy laws and dissolved legal entity preclude court-ordered disclosure.";
    const acceptRes = await app.inject({
      method: "POST",
      url: `/v1/gaps/${gapRes.id}/accept-unresolvable`,
      headers: { authorization: `Bearer ${token}` },
      payload: { rationale },
    });

    expect(acceptRes.statusCode).toBe(200);
    const updatedGap: ResearchGap = JSON.parse(acceptRes.body);
    expect(updatedGap.status).toBe("accepted_as_unresolvable");
    expect(updatedGap.resolution_rationale).toBe(rationale);
  });
});
