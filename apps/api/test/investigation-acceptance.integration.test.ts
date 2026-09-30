import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient } from "@casefile/db";
import type postgres from "postgres";

describe("apps/api — Investigation Acceptance Criteria Suite (PRD §56.1 AC-DEF-01..03)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let token: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    // Register tenant + user + workspace
    const email = `investigator-accept-${Date.now()}@casefile.test`;
    const password = "SuperSecretPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password,
        name: "Acceptance Investigator",
        orgName: "Acceptance Test Corp",
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
      payload: { name: "Acceptance Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = JSON.parse(wsRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("REQ-AC-DEF-01: Definition gate blocks transition to collecting without objective and questions", async () => {
    // 1. Given an investigation in draft with no objective and no questions
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Empty Gate Investigation",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const inv = JSON.parse(createRes.body);
    expect(inv.stage).toBe("draft");

    // 2. When attempting to transition to collecting
    const transRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: "collecting" },
    });

    // 3. Then the transition is rejected naming missing elements and remains in draft/defining
    expect(transRes.statusCode).toBe(400);
    const errBody = JSON.parse(transRes.body);
    expect(errBody.type).toContain("definition-gate-error");
    expect(Array.isArray(errBody.missing_elements)).toBe(true);
    expect(errBody.missing_elements).toContain("objective");
    expect(errBody.missing_elements.some((m: string) => m.includes("questions"))).toBe(true);

    // Verify stage unchanged
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${inv.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(getRes.body).stage).toBe("draft");
  });

  it("REQ-AC-DEF-02: Legitimacy requirement for private_individual subjects", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Legitimacy Investigation",
        objective: "Understand executive relationships",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const inv = JSON.parse(createRes.body);

    // 1. Given adding a subject of type private_individual without legitimacy_basis -> rejected
    const patchInvalid = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${inv.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        scope: {
          subjects: [
            {
              descriptor: "Jane Doe (Private Citizen)",
              subject_type: "private_individual",
              role: "witness",
              legitimacy_basis: "", // Missing
            },
          ],
        },
      },
    });
    expect(patchInvalid.statusCode).toBe(400);
    expect(JSON.parse(patchInvalid.body).detail).toContain("requires a legitimacy_basis");

    // 2. When saved with legitimacy_basis -> accepted and LegitimacyDeclared audit event emitted
    const patchValid = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${inv.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        scope: {
          subjects: [
            {
              descriptor: "Jane Doe (Private Citizen)",
              subject_type: "private_individual",
              role: "witness",
              legitimacy_basis: "Subpoena 2026-CV-8891 authorization",
            },
          ],
        },
      },
    });
    expect(patchValid.statusCode).toBe(200);
    const updated = JSON.parse(patchValid.body);
    expect(updated.scope.subjects.length).toBe(1);
    expect(updated.scope.subjects[0].legitimacy_basis).toBe("Subpoena 2026-CV-8891 authorization");
  });

  it("REQ-AC-DEF-03: Question materiality drives closure gate", async () => {
    // 1. Create investigation with objective and subject, and add a critical question
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Closure Gate Investigation",
        objective: "Evaluate commercial contract compliance",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const inv = JSON.parse(createRes.body);

    await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${inv.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        scope: {
          subjects: [{ descriptor: "Company X", subject_type: "organization", role: "primary_subject" }],
        },
      },
    });

    const qRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/questions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "Did Company X deliver the milestone by Dec 2025?",
        materiality: "critical",
      },
    });
    expect(qRes.statusCode).toBe(201);
    const q = JSON.parse(qRes.body);

    // 2. When attempting to transition to concluding while critical question is open -> rejected
    const transBlocked = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: "concluding" },
    });
    expect(transBlocked.statusCode).toBe(400);
    const blockedBody = JSON.parse(transBlocked.body);
    expect(blockedBody.type).toContain("closure-gate-error");
    expect(blockedBody.open_critical_questions.length).toBeGreaterThan(0);

    // 3. Mark the critical question unanswerable with a rationale
    const patchQ = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${inv.id}/questions/${q.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        status: "unanswerable",
        unanswerable_rationale: "Relevant communications destroyed per retention policy prior to notice",
      },
    });
    expect(patchQ.statusCode).toBe(200);

    // 4. Now transition to concluding succeeds
    const transAllowed = await app.inject({
      method: "POST",
      url: `/v1/investigations/${inv.id}/stage`,
      headers: { authorization: `Bearer ${token}` },
      payload: { stage: "concluding" },
    });
    expect(transAllowed.statusCode).toBe(200);
    expect(JSON.parse(transAllowed.body).stage).toBe("concluding");
  });
});
