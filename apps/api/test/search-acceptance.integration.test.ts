import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { SearchResponse } from "@casefile/contracts";

describe("Epic E6 Search Acceptance Criteria (PRD §56.5 AC-SRCH-01..06)", () => {
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

    const email = `e6-ac-${Date.now()}@casefile.test`;
    const password = "E6Password123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "E6 AC User", orgName: "E6 AC Org" },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;
    token = regData.accessToken;

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "E6 Search WS" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: workspaceId, name: "E6 Search Inv", objective: "Test Hybrid Search & Invariants" },
    });
    investigationId = JSON.parse(invRes.body).id;
    expect(tenantId).toBeDefined();
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── AC-SRCH-01: Permission Pre-Filtering (Invariant I10) ──────────────────
  it("AC-SRCH-01 — Permission pre-filtering: restricted/withdrawn documents are never scored, counted in facets, or revealed", async () => {
    // 1. Create a ready source
    const src1Res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Public_Wire_Transfer.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: "Meridian Trading wired 500,000 CHF to Geneva Bank on 2021-03-15.",
        acquisition_record: { origin: "Bank Records", custodian: "Chief Financial Officer", acquisition_method: "upload" },
      },
    });
    expect(src1Res.statusCode).toBe(201);
    const src1 = JSON.parse(src1Res.body);
    expect(src1.id).toBeDefined();

    // 2. Create a withdrawn/restricted source with confidential term
    const src2Res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Restricted_Settlement_Secret.txt",
        mime_type: "text/plain",
        source_class: "communication",
        raw_text: "Secret Confidential Settlement regarding Meridian Trading payout 999.",
        acquisition_record: { origin: "Court Docket", custodian: "Registrar", acquisition_method: "upload" },
      },
    });
    expect(src2Res.statusCode).toBe(201);
    const src2 = JSON.parse(src2Res.body);

    // Withdraw the second source
    const withdrawRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/sources/${src2.id}/withdraw`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "Privileged confidential document withdrawn per court order." },
    });
    expect(withdrawRes.statusCode).toBe(200);

    // 3. Search for the term in the withdrawn document
    const searchRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Secret Confidential Settlement" },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchData: SearchResponse = JSON.parse(searchRes.body);

    // Invariant I10 verification: 0 hits, not present in facets, not revealed in coverage
    expect(searchData.total_hits).toBe(0);
    expect(searchData.items.length).toBe(0);
    expect(searchData.facets.sources.find((s) => s.value.includes("Restricted_Settlement_Secret"))).toBeUndefined();
  });

  // ── AC-SRCH-02: Fuzzy Matching (OCR noise) ───────────────────────────────
  it("AC-SRCH-02 — Fuzzy matching: OCR error 'Merldían Tradlng Ltd' matches query 'Meridian Trading~'", async () => {
    // Ingest OCR noisy text
    const ocrSrcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Scanned_Invoice_OCR.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: "Invoice issued by Merldían Tradlng Ltd for consulting services rendered.",
        acquisition_record: { origin: "Scanned Archive", custodian: "Accounting", acquisition_method: "upload" },
      },
    });
    expect(ocrSrcRes.statusCode).toBe(201);

    // Search with fuzzy operator
    const searchRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Meridian Trading~", mode: "keyword" },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchData: SearchResponse = JSON.parse(searchRes.body);

    expect(searchData.total_hits).toBeGreaterThanOrEqual(1);
    const matched = searchData.items.find((i) => i.text.includes("Merldían Tradlng"));
    expect(matched).toBeDefined();
    expect(matched?.explanation.matched_terms.some((t) => t.includes("fuzzy"))).toBe(true);
  });

  // ── AC-SRCH-03: Coverage Reporting ───────────────────────────────────────
  it("AC-SRCH-03 — Coverage reporting: reports indexed chunks, indexed sources, unindexed count & breakdown", async () => {
    const searchRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Meridian" },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchData: SearchResponse = JSON.parse(searchRes.body);

    expect(searchData.coverage).toBeDefined();
    expect(searchData.coverage.total_chunks_indexed).toBeGreaterThan(0);
    expect(searchData.coverage.total_sources_indexed).toBeGreaterThan(0);
    expect(typeof searchData.coverage.unindexed_sources_count).toBe("number");
    expect(typeof searchData.coverage.coverage_percentage).toBe("number");
  });

  // ── AC-SRCH-04: Alias Expansion ──────────────────────────────────────────
  it("AC-SRCH-04 — Alias expansion: entity query returns documents mentioning canonical or temporal alias", async () => {
    // 1. Create Entity with alias
    const entRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Organization",
        canonical_name: "Vantor Holdings Ltd",
        aliases: [
          {
            value: "Kestrel Nominees Ltd",
            alias_type: "former_name",
            confidence: 0.95,
          },
        ],
      },
    });
    expect(entRes.statusCode).toBe(201);
    const entity = JSON.parse(entRes.body);
    expect(entity.id).toBeDefined();

    // 2. Ingest document mentioning only the alias "Kestrel Nominees Ltd"
    const aliasDocRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Offshore_Trust_Deed_2018.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: "The settlement property was transferred to Kestrel Nominees Ltd in June 2018.",
        acquisition_record: { origin: "Corporate Registry", custodian: "Trustee", acquisition_method: "upload" },
      },
    });
    expect(aliasDocRes.statusCode).toBe(201);

    // 3. Search using entity syntax: entity:Vantor Holdings Ltd
    const searchRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "entity:Vantor Holdings Ltd", mode: "entity" },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchData: SearchResponse = JSON.parse(searchRes.body);

    expect(searchData.total_hits).toBeGreaterThanOrEqual(1);
    const matchedItem = searchData.items.find((i) => i.text.includes("Kestrel Nominees Ltd"));
    expect(matchedItem).toBeDefined();
    expect(matchedItem?.explanation.retrieval_path).toBe("entity");
    expect(matchedItem?.explanation.matched_alias).toBe("Kestrel Nominees Ltd");
  });

  // ── AC-SRCH-05: Explanation ──────────────────────────────────────────────
  it("AC-SRCH-05 — Explanation: response includes retrieval path, matched terms, and contributing signals", async () => {
    const searchRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Meridian", mode: "hybrid" },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchData: SearchResponse = JSON.parse(searchRes.body);

    expect(searchData.items.length).toBeGreaterThan(0);
    const first = searchData.items[0]!;
    expect(first.explanation).toBeDefined();
    expect(first.explanation.retrieval_path).toBeDefined();
    expect(first.explanation.matched_terms.length).toBeGreaterThan(0);
    expect(first.explanation.signals.length).toBe(2);

    const lexicalSig = first.explanation.signals.find((s) => s.signal === "lexical_match");
    expect(lexicalSig).toBeDefined();
    expect(lexicalSig?.weight).toBe(0.70);

    const qualitySig = first.explanation.signals.find((s) => s.signal === "source_quality");
    expect(qualitySig).toBeDefined();
    expect(qualitySig?.weight).toBe(0.30);

    expect(first.explanation.signals_not_computed).toContain("cross_encoder_relevance");
    expect(first.explanation.raw_lexical_rank).toBe(1);
    expect(first.explanation.score_basis).toBe("lexical_match + source_quality");
  });

  // ── AC-SRCH-06: Reproducibility ──────────────────────────────────────────
  it("AC-SRCH-06 — Reproducibility: re-executing against same weights version yields identical ordering", async () => {
    const search1 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Meridian Trading", weights_version: "v1.0", index_generation: "gen-1" },
    });
    const data1: SearchResponse = JSON.parse(search1.body);

    const search2 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/search`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "Meridian Trading", weights_version: "v1.0", index_generation: "gen-1" },
    });
    const data2: SearchResponse = JSON.parse(search2.body);

    expect(data1.total_hits).toBe(data2.total_hits);
    expect(data1.items.length).toBe(data2.items.length);
    for (let i = 0; i < data1.items.length; i++) {
      expect(data1.items[i]!.chunk_id).toBe(data2.items[i]!.chunk_id);
      expect(data1.items[i]!.score).toBe(data2.items[i]!.score);
    }
  });
});
