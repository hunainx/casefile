import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient } from "@casefile/db";
import type postgres from "postgres";

describe("apps/api — Investigation API Endpoints Suite (Notes, Tasks, Templates)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let token: string;
  let investigationId: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `api-investigations-${Date.now()}@casefile.test`;
    const password = "ApiInvestigatorPass123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password,
        name: "Api Investigator",
        orgName: "API Test Corp",
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
      payload: { name: "Investigation Core Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "General Core Investigation",
        objective: "Core functionality test suite",
      },
    });
    expect(invRes.statusCode).toBe(201);
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("REQ-API-GET-V1-INVESTIGATIONS & REQ-API-POST-V1-INVESTIGATIONS: Contract and pagination", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/investigations?limit=1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const body = JSON.parse(listRes.body);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(1);
  });

  it("PRD §8.5: Notes are attachable to targets with mentions and distinct from evidence", async () => {
    // 1. Create a note on investigation
    const noteRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/notes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        target_type: "investigation",
        target_id: investigationId,
        content: "Met with forensic accountant. Need review of wire transfer logs from Q3. #accountant @lead",
        mentions: ["#accountant", "@lead"],
      },
    });
    expect(noteRes.statusCode).toBe(201);
    const note = JSON.parse(noteRes.body);
    expect(note.id).toBeDefined();
    expect(note.content).toContain("wire transfer logs");
    expect(note.mentions).toContain("@lead");

    // 2. List notes
    const listNotesRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/notes`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listNotesRes.statusCode).toBe(200);
    const notesList = JSON.parse(listNotesRes.body).items;
    expect(notesList.length).toBeGreaterThan(0);
  });

  it("PRD §8.6: Tasks track lightweight work items with priority, status and target link", async () => {
    // 1. Create a task
    const taskRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Request wire transaction ledger from Banco Central",
        description: "Focus on transfers exceeding $100k between 2021 and 2023",
        priority: "high",
        target_type: "investigation",
        target_id: investigationId,
      },
    });
    expect(taskRes.statusCode).toBe(201);
    const task = JSON.parse(taskRes.body);
    expect(task.id).toBeDefined();
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("high");

    // 2. Update task status to in_progress
    const patchTaskRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "in_progress" },
    });
    expect(patchTaskRes.statusCode).toBe(200);
    expect(JSON.parse(patchTaskRes.body).status).toBe("in_progress");

    // 3. List tasks
    const listTasksRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listTasksRes.statusCode).toBe(200);
    const tasksList = JSON.parse(listTasksRes.body).items;
    expect(tasksList.length).toBeGreaterThan(0);
  });

  it("PRD §8.7: Templates define reusable question sets and scope defaults", async () => {
    const listTplRes = await app.inject({
      method: "GET",
      url: "/v1/investigation-templates",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listTplRes.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(listTplRes.body).items)).toBe(true);
  });
});
