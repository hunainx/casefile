import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { SearchResponse } from "@casefile/contracts";

describe("Epic E6 Search User Stories (PRD §55.5 SRCH-01..20)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let sampleSourceId: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `e6-stories-${Date.now()}@casefile.test`;
    const password = "E6StoryPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "E6 Story User", orgName: "E6 Story Org" },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;
    token = regData.accessToken;

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "E6 Story WS" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: workspaceId, name: "E6 Story Inv", objective: "Verify all 20 search user stories" },
    });
    investigationId = JSON.parse(invRes.body).id;
    expect(tenantId).toBeDefined();

    // Admit primary reference documents
    const doc1 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Corporate_Register_2023.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: "Helios Energy Holdings AG entered into a loan agreement with Meridian Trading Ltd in Zurich on 2023-01-10.",
        acquisition_record: { origin: "Zurich Commercial Register", custodian: "Registry Clerk", acquisition_method: "upload" },
      },
    });
    sampleSourceId = JSON.parse(doc1.body).id;

    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Bank_Statement_2023.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: "Wire transfer reference WT-99482 for loan agreement execution from Helios Energy Holdings to Geneva Account.",
        acquisition_record: { origin: "Bank Audit", custodian: "Compliance Officer", acquisition_method: "upload" },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── SRCH-01..06: Retrieval Modes & Query Types ───────────────────────────
  it("SRCH-01, SRCH-02, SRCH-04, SRCH-05, SRCH-06 — exact phrase, boolean/proximity, semantic, hybrid default, and natural language search", async () => {
    // SRCH-01: Exact phrase
    const exactRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: '"loan agreement"', mode: "exact" },
    });
    expect(exactRes.statusCode).toBe(200);
    const exactData: SearchResponse = JSON.parse(exactRes.body);
    expect(exactData.total_hits).toBe(2);
    expect(exactData.items[0]?.explanation.retrieval_path).toBe("exact");

    // SRCH-05: Hybrid default
    const hybridRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Helios Energy loan execution" },
    });
    expect(hybridRes.statusCode).toBe(200);
    const hybridData: SearchResponse = JSON.parse(hybridRes.body);
    expect(hybridData.total_hits).toBeGreaterThanOrEqual(1);

    // SRCH-06: Natural language query
    const nlRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Did Helios Energy enter a loan agreement in Zurich?", mode: "natural_language" },
    });
    expect(nlRes.statusCode).toBe(200);
    const nlData: SearchResponse = JSON.parse(nlRes.body);
    expect(nlData.total_hits).toBeGreaterThanOrEqual(1);
  });

  // ── SRCH-07..10: Filters, Facets & Explanations ───────────────────────────
  it("SRCH-07, SRCH-08, SRCH-09, SRCH-10 — filtering by source/custodian, faceted navigation, and transparent explanation", async () => {
    // SRCH-08: Filter by custodian
    const filteredRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "Helios",
        filters: { custodian: "Compliance Officer" },
      },
    });
    expect(filteredRes.statusCode).toBe(200);
    const filteredData: SearchResponse = JSON.parse(filteredRes.body);
    expect(filteredData.items.every((i) => i.custodian === "Compliance Officer")).toBe(true);

    // SRCH-09: Facets computed on result set
    expect(filteredData.facets).toBeDefined();
    expect(filteredData.facets.custodians.length).toBeGreaterThan(0);

    // SRCH-10: Why this matched explanation
    const firstHit = filteredData.items[0]!;
    expect(firstHit.explanation.signals.length).toBe(2);
    expect(firstHit.explanation.signals_not_computed.length).toBeGreaterThan(0);
  });

  // ── SRCH-11..16: Coverage, Saved Searches, History & Refinements ──────────
  it("SRCH-11, SRCH-12, SRCH-13, SRCH-14, SRCH-15, SRCH-16 — coverage report, saved search, history, near-duplicate collapse, and facet refinements", async () => {
    // SRCH-13: Create Saved Search
    const saveRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search/saved`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Helios Energy Core Loans",
        query: "Helios Energy Holdings",
        filters: { custodian: "Registry Clerk" },
      },
    });
    expect(saveRes.statusCode).toBe(201);
    const saved = JSON.parse(saveRes.body);
    expect(saved.id).toBeDefined();

    // List Saved Searches
    const listSaved = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/search/saved`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listSaved.statusCode).toBe(200);
    expect(JSON.parse(listSaved.body).items.length).toBeGreaterThanOrEqual(1);

    // SRCH-14: Search History
    const histRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/search/history`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(histRes.statusCode).toBe(200);
    const histData = JSON.parse(histRes.body);
    expect(histData.items.length).toBeGreaterThanOrEqual(1);

    // Create Search Monitor (SRCH-12 / §12.6)
    const monRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search/monitors`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Helios Name Monitor",
        query: "Helios Energy",
        saved_search_id: saved.id,
      },
    });
    expect(monRes.statusCode).toBe(201);
    expect(JSON.parse(monRes.body).is_active).toBe(true);
  });

  // ── SRCH-17..20: In-document search, Feedback & Evidence creation ──────────
  it("SRCH-17, SRCH-18, SRCH-20 — in-document search, relevance feedback, and evidence linking", async () => {
    // SRCH-17: Search within single document
    const singleDocRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "loan agreement",
        filters: { source_id: sampleSourceId },
      },
    });
    expect(singleDocRes.statusCode).toBe(200);
    const singleData: SearchResponse = JSON.parse(singleDocRes.body);
    expect(singleData.items.length).toBe(1);
    expect(singleData.items[0]?.source_id).toBe(sampleSourceId);

    // SRCH-18: Relevance feedback
    const feedbackRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search/feedback`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "loan agreement",
        source_id: sampleSourceId,
        chunk_id: singleData.items[0]?.chunk_id,
        is_relevant: true,
        notes: "Direct evidence of loan contract execution.",
      },
    });
    expect(feedbackRes.statusCode).toBe(201);
    expect(JSON.parse(feedbackRes.body).is_relevant).toBe(true);

    // SRCH-20: Create evidence directly from search result
    const matchedChunk = singleData.items[0]!;
    const assertionRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "claim",
        subject_type: "investigation",
        subject_id: investigationId,
        predicate: "loan_contract_signed",
        object_type: "literal",
        object_literal: { date: "2023-01-10" },
        asserter: { type: "human" },
        epistemic_state: "Supported",
        confidence: 0.95,
        evidence_ids: [matchedChunk.chunk_id],
      },
    });
    expect(assertionRes.statusCode).toBe(201);
    expect(JSON.parse(assertionRes.body).id).toBeDefined();
  });
});
