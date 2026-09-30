import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient } from "@casefile/db";
import type postgres from "postgres";

describe("apps/api — Investigation User Stories Suite (PRD §55.3 INV-01..18)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let token: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `lead-inv-${Date.now()}@casefile.test`;
    const password = "LeadInvestigatorPass123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password,
        name: "Lead Investigator",
        orgName: "Stories Test Corp",
      },
    });
    expect(regRes.statusCode).toBe(201);
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password, tenantId },
    });
    expect(tokenRes.statusCode).toBe(200);
    token = JSON.parse(tokenRes.body).accessToken;

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Investigation Stories Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = JSON.parse(wsRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("REQ-INV-01 & REQ-INV-03: Create investigation in under 30s with objective", async () => {
    const startTime = Date.now();
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Project Fast-Track Investigation",
        objective: "Determine unauthorized disclosure of confidential trade secrets",
        sensitivity: "restricted",
      },
    });
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(30000); // Under 30s
    expect(createRes.statusCode).toBe(201);
    const inv = JSON.parse(createRes.body);
    expect(inv.id).toBeDefined();
    expect(inv.name).toBe("Project Fast-Track Investigation");
    expect(inv.objective).toBe("Determine unauthorized disclosure of confidential trade secrets");
    expect(inv.sensitivity).toBe("restricted");
  });

  it("REQ-INV-02: Start investigation from a template with pre-populated questions and scope defaults", async () => {
    // 1. Create a template
    const tplRes = await app.inject({
      method: "POST",
      url: "/v1/investigation-templates",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Corporate Fraud Template",
        description: "Standard corporate fraud inquiry template",
        questions: [
          { text: "Were undisclosed related-party payments made?", materiality: "critical" },
          { text: "Who authorized the bank wire transfers?", materiality: "important" },
        ],
        scope_defaults: {
          inclusions: ["Bank statements", "Email records", "Invoices"],
          jurisdictions: ["US", "GB"],
        },
      },
    });
    expect(tplRes.statusCode).toBe(201);
    const tpl = JSON.parse(tplRes.body);

    // 2. Create investigation starting from template
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Acme Corp Fraud Inquiry",
        template_id: tpl.id,
      },
    });
    expect(invRes.statusCode).toBe(201);
    const inv = JSON.parse(invRes.body);
    expect(inv.scope.inclusions).toContain("Bank statements");

    // 3. Verify questions were pre-seeded
    const qListRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${inv.id}/questions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(qListRes.statusCode).toBe(200);
    const questions = JSON.parse(qListRes.body).items;
    expect(questions.length).toBe(2);
    expect(questions[0].text).toBe("Were undisclosed related-party payments made?");
    expect(questions[0].materiality).toBe("critical");
  });

  it("REQ-INV-04, REQ-INV-05, REQ-INV-06: Add questions, decompose with sub-questions, and set materiality", async () => {
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Question Hierarchy Investigation",
        objective: "Assess supply chain integrity",
      },
    });
    const inv = JSON.parse(invRes.body);

    // 1. Add parent question (critical)
    const parentQRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/questions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "Did Vantor Holdings control Meridian Trading between 2019 and 2022?",
        materiality: "critical",
      },
    });
    expect(parentQRes.statusCode).toBe(201);
    const parentQ = JSON.parse(parentQRes.body);
    expect(parentQ.materiality).toBe("critical");

    // 2. Add sub-question decomposing parent
    const subQRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/questions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "What percentage of Meridian voting shares did Vantor executives hold in 2020?",
        parent_question_id: parentQ.id,
        materiality: "important",
      },
    });
    expect(subQRes.statusCode).toBe(201);
    const subQ = JSON.parse(subQRes.body);
    expect(subQ.parent_question_id).toBe(parentQ.id);
  });

  it("REQ-INV-07, REQ-INV-08, REQ-INV-09: Declare scope, subjects with roles, and legitimacy basis", async () => {
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Scope Declaration Investigation",
      },
    });
    const inv = JSON.parse(invRes.body);

    const updateRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${inv.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        scope: {
          inclusions: ["Internal financial audits", "Vendor agreements"],
          exclusions: ["Personal employee health records"],
          jurisdictions: ["US-DE", "US-NY"],
          subjects: [
            {
              descriptor: "Meridian Trading LLC",
              subject_type: "organization",
              role: "primary_subject",
            },
            {
              descriptor: "John Doe (CFO)",
              subject_type: "private_individual",
              role: "related_party",
              legitimacy_basis: "Board of Directors Special Committee Authorization Res #42",
            },
          ],
        },
      },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);
    expect(updated.scope.exclusions).toContain("Personal employee health records");
    expect(updated.scope.subjects.length).toBe(2);
  });

  it("REQ-INV-10: View investigation health with its epistemic components", async () => {
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Health Test Investigation",
      },
    });
    const inv = JSON.parse(invRes.body);

    const healthRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${inv.id}/health`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(healthRes.statusCode).toBe(200);
    const health = JSON.parse(healthRes.body);
    expect(health.status).toBeDefined();
    expect(health.components.question_coverage).toBeDefined();
    expect(health.components.evidence_integrity).toBe(100);
    expect(health.components.contradiction_posture).toBe(100);
  });

  it("REQ-INV-11, REQ-INV-12, REQ-INV-13, REQ-INV-14: Lifecycle stage progression, suspension, archive and reopen", async () => {
    // 1. Create with full definition
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Lifecycle Investigation",
        objective: "Complete lifecycle testing",
      },
    });
    const inv = JSON.parse(invRes.body);

    await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${inv.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        scope: {
          subjects: [{ descriptor: "Target Corp", subject_type: "organization", role: "primary_subject" }],
        },
      },
    });
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/questions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "Is Target Corp compliant?", materiality: "important" },
    });

    // 2. Advance stage to collecting
    const advRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: "collecting" },
    });
    expect(advRes.statusCode).toBe(200);
    expect(JSON.parse(advRes.body).stage).toBe("collecting");

    // 3. Suspend investigation with reason (INV-12)
    const suspRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        stage: "suspended",
        suspension_reason: "Pending outside counsel review of jurisdiction",
      },
    });
    expect(suspRes.statusCode).toBe(200);
    expect(JSON.parse(suspRes.body).stage).toBe("suspended");
    expect(JSON.parse(suspRes.body).suspension_reason).toBe("Pending outside counsel review of jurisdiction");

    // 4. Archive investigation (INV-13)
    const archRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: "archived" },
    });
    expect(archRes.statusCode).toBe(200);
    expect(JSON.parse(archRes.body).stage).toBe("archived");

    // 5. Reopen archived investigation with justification (INV-14)
    const reopenRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        stage: "defining",
        reopen_justification: "New whistleblower evidence received on Matter #401",
      },
    });
    expect(reopenRes.statusCode).toBe(200);
    expect(JSON.parse(reopenRes.body).stage).toBe("defining");
    expect(JSON.parse(reopenRes.body).reopen_justification).toBe("New whistleblower evidence received on Matter #401");
  });

  it("REQ-INV-15 & REQ-INV-16: List investigations and generate investigation brief", async () => {
    // 1. List investigations (INV-15)
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listData = JSON.parse(listRes.body);
    expect(Array.isArray(listData.items)).toBe(true);
    expect(listData.items.length).toBeGreaterThan(0);

    const targetInvId = listData.items[0].id;

    // 2. Generate brief (INV-16)
    const briefRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${targetInvId}/brief`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(briefRes.statusCode).toBe(200);
    const brief = JSON.parse(briefRes.body);
    expect(brief.investigation_id).toBe(targetInvId);
    expect(brief.summary).toBeDefined();
    expect(brief.stats.total_questions).toBeDefined();
  });

  it("REQ-INV-17 & REQ-INV-18: Manage investigation members with roles and set legal hold", async () => {
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Membership & Hold Investigation",
      },
    });
    const inv = JSON.parse(invRes.body);

    // 1. Create a second user in same tenant
    const user2Res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: `investigator-team2-${Date.now()}@casefile.test`,
        password: "TeamMemberPassword123!",
        name: "Team Member Two",
        orgName: "Stories Test Corp",
      },
    });
    expect(user2Res.statusCode).toBe(201);
    const teamUser = JSON.parse(user2Res.body).user;

    // 2. Add team member with role 'reviewer'
    const addMemRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/members`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        user_id: teamUser.id,
        role: "reviewer",
      },
    });
    expect(addMemRes.statusCode).toBe(201);
    expect(JSON.parse(addMemRes.body).role).toBe("reviewer");

    // 3. List members
    const memListRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${inv.id}/members`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(memListRes.statusCode).toBe(200);
    const members = JSON.parse(memListRes.body).items;
    expect(members.length).toBe(2); // creator (lead) + new reviewer

    // 4. Set legal hold flag (INV-18)
    const holdRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${inv.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { legal_hold: true },
    });
    expect(holdRes.statusCode).toBe(200);
    expect(JSON.parse(holdRes.body).legal_hold).toBe(true);

    // 5. Remove team member
    const delMemRes = await app.inject({
      method: "DELETE",
      url: `/v1/investigations/${inv.id}/members/${teamUser.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delMemRes.statusCode).toBe(200);
  });
});
