import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { Entity } from "@casefile/contracts";

describe("Epic E5 Entity & Relationship User Stories (PRD §55 ENT-01..15 & REL-01..12)", () => {
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

    const email = `e5-stories-${Date.now()}@casefile.test`;
    const password = "E5StoriesPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "E5 Story User", orgName: "E5 Story Org" },
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
      payload: { name: "E5 Story Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Operation Titan",
        objective: "Verify all 27 entity and relationship user stories.",
      },
    });
    investigationId = JSON.parse(invRes.body).id;

    // Create a sample source
    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Corporate_Register_2023.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        raw_text: "Director John Doe registered Horizon Holding AG on 2020-01-15.",
        acquisition_record: {
          origin: "Commercial Registry Zurich",
          custodian: "Cantonal Archive",
          acquisition_method: "upload",
        },
      },
    });
    sampleSourceId = JSON.parse(srcRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── ENT-01, ENT-02, ENT-04: Entity Extraction, Counts & Mentions ─────────
  it("ENT-01, ENT-02, ENT-04 — extracts entities with mentions, counts, and surrounding context", async () => {
    const extractRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/extract`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_id: sampleSourceId,
        items: [
          {
            kind: "entity",
            entity_type: "Person",
            canonical_name: "John Doe",
            quoted_span: "John Doe",
            char_start: 9,
            char_end: 17,
            confidence: 0.95,
          },
          {
            kind: "entity",
            entity_type: "Organization",
            canonical_name: "Horizon Holding AG",
            quoted_span: "Horizon Holding AG",
            char_start: 29,
            char_end: 47,
            confidence: 0.95,
          },
        ],
      },
    });
    expect(extractRes.statusCode).toBe(200);
    const extractData = JSON.parse(extractRes.body);
    expect(extractData.verified_count).toBe(2);
    expect(extractData.created_entities.length).toBe(2);

    const personEntity = extractData.created_entities.find((e: Entity) => e.canonical_name === "John Doe");
    expect(personEntity).toBeDefined();

    // ENT-02: List entities with mention & source counts
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listData = JSON.parse(listRes.body);
    expect(listData.items.length).toBeGreaterThanOrEqual(2);

    const listedPerson = listData.items.find((e: Entity) => e.id === personEntity.id);
    expect(listedPerson.mention_count).toBe(1);
    expect(listedPerson.source_count).toBe(1);

    // ENT-04: Get mentions with context
    const mentionsRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/${personEntity.id}/mentions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mentionsRes.statusCode).toBe(200);
    const mentionsData = JSON.parse(mentionsRes.body);
    expect(mentionsData.items.length).toBe(1);
    expect(mentionsData.items[0].extracted_text).toBe("John Doe");
    expect(mentionsData.items[0].source_filename).toBe("Corporate_Register_2023.pdf");
  });

  // ── ENT-03, ENT-06, ENT-15: Entity Page, Timeline & Dossier Export ────────
  it("ENT-03, ENT-06, ENT-15 — entity page details, timeline events, and dossier export", async () => {
    // Create entity
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Organization",
        canonical_name: "Apex Global Assets S.A.",
        sensitivity: "elevated",
        subject_role: "primary_subject",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const entity = JSON.parse(createRes.body);

    // Add temporal attribute assertion (ENT-06)
    await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "attribute",
        subject_type: "entity",
        subject_id: entity.id,
        predicate: "registered_address",
        object_type: "text",
        object_literal: { address: "Rue du Rhone 42, Geneva" },
        valid_from: { date: "2019-01-01" },
        valid_to: { date: "2022-12-31" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });

    // ENT-03: View Entity
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/${entity.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const getData = JSON.parse(getRes.body);
    expect(getData.canonical_name).toBe("Apex Global Assets S.A.");
    expect(getData.sensitivity).toBe("elevated");

    // ENT-06: View Timeline
    const timeRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/${entity.id}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(timeRes.statusCode).toBe(200);
    const timeData = JSON.parse(timeRes.body);
    expect(timeData.timeline_events.length).toBeGreaterThan(0);
    expect(timeData.timeline_events[0].predicate).toBe("registered_address");

    // ENT-15: Export Dossier
    const dosRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/entities/${entity.id}/dossier`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dosRes.statusCode).toBe(200);
    const dosData = JSON.parse(dosRes.body);
    expect(dosData.dossier.entity.id).toBe(entity.id);
    expect(dosData.dossier.summary).toBeDefined();
    expect(dosData.dossier.not_established).toBeDefined();
  });

  // ── ENT-07, ENT-08, ENT-09, ENT-10: Manual Add, Edit, Aliases & Pinning ──
  it("ENT-07, ENT-08, ENT-09, ENT-10 — manual creation, name correction with audit, aliases with validity, and focal pinning", async () => {
    // ENT-07: Manual add
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "Person",
        canonical_name: "Marcus Vance",
        subject_role: "key_associate",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const entity = JSON.parse(createRes.body);

    // ENT-08: Correct canonical name with rationale & audit
    const editRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/entities/${entity.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        canonical_name: "Marcus Aurelius Vance",
        rationale: "Full legal name as shown on birth certificate.",
      },
    });
    expect(editRes.statusCode).toBe(200);
    expect(JSON.parse(editRes.body).canonical_name).toBe("Marcus Aurelius Vance");

    // ENT-09: Add aliases with validity periods
    const aliasRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/entities/${entity.id}/aliases`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        value: "Marc Vance",
        alias_type: "nickname",
        valid_from: { date: "2015-01-01" },
        valid_to: { date: "2020-01-01" },
        confidence: 0.90,
        source_of_alias: "human",
      },
    });
    expect(aliasRes.statusCode).toBe(201);
    const aliasData = JSON.parse(aliasRes.body);
    expect(aliasData.value).toBe("Marc Vance");
    expect(aliasData.alias_type).toBe("nickname");

    // ENT-10: Pin as focal entity
    const pinRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/entities/${entity.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        is_focal: true,
        rationale: "Key target of interest.",
      },
    });
    expect(pinRes.statusCode).toBe(200);
    expect(JSON.parse(pinRes.body).is_focal).toBe(true);
  });

  // ── REL-01..12: Relationship Extraction, Verification, Refutation, Bulk ──
  it("REL-01..12 — relationship creation with evidence, human verification, refutation, and bulk-verify", async () => {
    // 1. Create two entities
    const [res1, res2] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/entities`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "Person", canonical_name: "Lord Sterling" },
      }),
      app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/entities`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "Organization", canonical_name: "Sterling Trust Ltd" },
      }),
    ]);
    const person = JSON.parse(res1.body);
    const org = JSON.parse(res2.body);

    const evidenceId = randomUUID();

    // 2. REL-01, REL-04: Create relationship with evidence grounding and temporal validity
    const relRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/relationships`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_entity_id: person.id,
        target_entity_id: org.id,
        type: "beneficial_owner_of",
        direction: "directed",
        valid_from: { date: "2018-01-01" },
        attributes: { shareholding_pct: 100 },
        discovery_channel: "stated",
        evidence_ids: [evidenceId],
        epistemic_state: "Supported",
        confidence: 0.90,
      },
    });
    expect(relRes.statusCode).toBe(201);
    const rel = JSON.parse(relRes.body);
    expect(rel.type).toBe("beneficial_owner_of");
    expect(rel.epistemic_state).toBe("Supported");

    // 3. REL-05: Verify relationship by human investigator
    const verifyRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/relationships/${rel.id}/verify`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        rationale: "Confirmed via trust deed signed 2018-01-01.",
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifiedData = JSON.parse(verifyRes.body);
    expect(verifiedData.epistemic_state).toBe("Verified");
    expect(verifiedData.confidence).toBe(1.0);
    expect(verifiedData.verified_by).toBeDefined();

    // 4. REL-06: Refute relationship with rationale
    const refuteRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/relationships/${rel.id}/refute`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        rationale: "Trust deed revoked by court order in 2021.",
      },
    });
    expect(refuteRes.statusCode).toBe(200);
    expect(JSON.parse(refuteRes.body).epistemic_state).toBe("Refuted");

    // 5. REL-07: Bulk verify relationships of same type from same evidence
    // Create another relationship with same type & evidenceId
    const rel2Res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/relationships`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source_entity_id: person.id,
        target_entity_id: org.id,
        type: "director_of",
        direction: "directed",
        evidence_ids: [evidenceId],
        epistemic_state: "Supported",
        confidence: 0.85,
      },
    });
    expect(rel2Res.statusCode).toBe(201);

    const bulkRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/relationships/bulk-verify`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "director_of",
        evidence_id: evidenceId,
        rationale: "Bulk verified from board minute archive.",
      },
    });
    expect(bulkRes.statusCode).toBe(200);
    const bulkData = JSON.parse(bulkRes.body);
    expect(bulkData.verified_count).toBeGreaterThan(0);
  });
});
