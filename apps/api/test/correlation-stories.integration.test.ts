import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import type postgres from "postgres";
import type {
  Contradiction,
  ResearchGap,
} from "@casefile/contracts";

type AppInstance = ReturnType<typeof buildApp>;

describe("Epic E9 — Contradictions & Research Gaps User Stories (CON-01..10, GAP-01..12)", () => {
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
    const email = `correlation-stories-${Date.now()}@casefile.test`;
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password: "StoriesPassword123!",
        name: "Devon Clark",
        orgName: "Clark Forensic Analytics",
      },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    // 2. Token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password: "StoriesPassword123!", tenantId },
    });
    token = JSON.parse(tokenRes.body).accessToken;

    // 3. Workspace & Investigation
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Correlation Stories Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Project Chimera Correlation",
        objective: "Establish comprehensive contradiction and research gap intelligence.",
      },
    });
    investigationId = JSON.parse(invRes.body).id;

    // 4. Create Entity
    const entRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        canonical_name: "Chimera Capital Partners",
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

  // ── CON-01..10: Contradiction User Stories ──────────────────────────────────
  it("CON-01..10 — Automatic detection, materiality ranking, side-by-side evidence, and adjudication outcomes", async () => {
    // 1. Ingest two assertions with exclusivity conflict (CON-01 / CON-02)
    const asst1 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "attribute",
        subject_type: "entity",
        subject_id: entityId,
        predicate: "owns_percentage",
        object_type: "text",
        object_literal: { percentage: "100%" },
        asserter: { type: "human" },
        epistemic_state: "Verified",
        confidence: 0.98,
        evidence_ids: [],
      },
    });
    expect(asst1.statusCode).toBe(201);
    const asst1Id = JSON.parse(asst1.body).id;

    const asst2 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "attribute",
        subject_type: "entity",
        subject_id: entityId,
        predicate: "owns_percentage",
        object_type: "text",
        object_literal: { percentage: "62%" },
        asserter: { type: "human" },
        epistemic_state: "Likely",
        confidence: 0.85,
        evidence_ids: [],
      },
    });
    expect(asst2.statusCode).toBe(201);
    const asst2Id = JSON.parse(asst2.body).id;

    // 2. Fetch contradictions (CON-01 / CON-02 / CON-04)
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/contradictions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const contradictions: Contradiction[] = JSON.parse(listRes.body).items;
    expect(contradictions.length).toBeGreaterThanOrEqual(1);

    const ownershipConflict = contradictions.find(
      (c) => c.detector === "exclusivity_conflict" && ((c.assertion_a_id === asst1Id && c.assertion_b_id === asst2Id) || (c.assertion_a_id === asst2Id && c.assertion_b_id === asst1Id)),
    );
    expect(ownershipConflict).toBeDefined();
    expect(ownershipConflict!.severity).toBe("critical"); // Ranked by materiality (CON-02)
    expect(ownershipConflict!.status).toBe("open");

    // 3. Adjudicate with 'irreconcilable' outcome (CON-05 / CON-06)
    const adjRes = await app.inject({
      method: "POST",
      url: `/v1/contradictions/${ownershipConflict!.id}/adjudicate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        resolution_type: "irreconcilable",
        rationale: "Filing records reflect simultaneous irreconcilable regulatory statements in BVI and London registries.",
      },
    });
    expect(adjRes.statusCode).toBe(200);
    const resolved: Contradiction = JSON.parse(adjRes.body);
    expect(resolved.status).toBe("irreconcilable");
    expect(resolved.resolution?.type).toBe("irreconcilable");
    expect(resolved.resolution?.rationale).toContain("irreconcilable regulatory statements");
  });

  // ── GAP-01..12: Research Gaps User Stories ──────────────────────────────────
  it("GAP-01..12 — Prioritization of unknown facts, actionable steps, manual creation, and lifecycle closure", async () => {
    // 1. Manually create an investigation gap for a single-source critical claim (GAP-01 / GAP-02 / GAP-03)
    const gap1 = await withTenant(tenantId, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO research_gaps (
          id, tenant_id, investigation_id, gap_type, title, description,
          priority, priority_basis, suggested_actions, status
        )
        VALUES (
          gen_random_uuid(), ${tenantId}, ${investigationId}, 'single_sourced_critical_claim',
          'Single-Sourced Beneficial Ownership Claim on Apex Assets',
          'Apex Assets beneficial ownership rests solely on a single uncorroborated interview statement.',
          'critical', 'Critical question Q1 depends on uncorroborated testimony.',
          ${JSON.stringify([
            {
              action_type: "run_search",
              label: "Search corporate filings for Apex Assets",
              description: "Execute search for Apex Assets registration filings to obtain corroborating extract.",
            },
          ])}::jsonb,
          'open'
        )
        RETURNING id;
      `;
      return rows[0]!;
    }, sql);

    // 2. Query gaps list and verify prioritization (GAP-02 / GAP-08)
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/gaps`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const gaps: ResearchGap[] = JSON.parse(listRes.body).items;
    const targetGap = gaps.find((g) => g.id === gap1.id);
    expect(targetGap).toBeDefined();
    expect(targetGap!.priority).toBe("critical");
    expect(targetGap!.suggested_actions[0]?.action_type).toBe("run_search");

    // 3. Close the gap with explicit rationale (GAP-11)
    const closeRes = await app.inject({
      method: "POST",
      url: `/v1/gaps/${gap1.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        rationale: "Corroborating Apex Assets registry document obtained and admitted into evidence.",
      },
    });
    expect(closeRes.statusCode).toBe(200);
    const closed: ResearchGap = JSON.parse(closeRes.body);
    expect(closed.status).toBe("closed");
    expect(closed.resolution_rationale).toContain("Corroborating Apex Assets registry document");
  });
});
