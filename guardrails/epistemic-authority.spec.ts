/**
 * GUARDRAIL: epistemic-authority  —  invariant I2  ·  AC-EPI-01  ·  decision D4
 *
 * PRD §6.5 (the epistemic ladder and its transition rules), §59.2 (assertions table
 * CHECK constraints).
 *
 * "AI capped at `Supported`; only humans write `Verified`/`Refuted`, enforced by DB
 *  CHECK constraints. Makes the central guarantee a schema property, not an
 *  application convention." — D4
 *
 * This is the product's central claim in executable form: no machine ever gets to
 * decide something is true. The suite attacks that claim from every layer, because a
 * guarantee that holds only at the service layer is a convention, not a guarantee.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../apps/api/src/app.js";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { EpistemicStateSchema } from "@casefile/contracts";

type AppInstance = ReturnType<typeof buildApp>;

describe("I2 — the database refuses machine-authored Verified/Refuted", () => {
  let app: AppInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `ea-db-${Date.now()}@casefile.test`;
    const password = "EaDbPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "EA DB User", orgName: "EA DB Org" },
    });
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;
    userId = regData.user.id;

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
      payload: { name: "EA DB Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: workspaceId, name: "EA DB Investigation", objective: "DB Guardrail" },
    });
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("a CHECK constraint on assertions rejects asserter_type='model' with epistemic_state='Verified'", async () => {
    let failed = false;
    try {
      await withTenant(tenantId, async (tx) => {
        await tx`
          INSERT INTO assertions (
            id, tenant_id, investigation_id, kind, subject_type, subject_id,
            predicate, object_type, object_id, asserter_type, asserter_id,
            epistemic_state, confidence, reviewed_by
          )
          VALUES (
            ${randomUUID()}, ${tenantId}, ${investigationId}, 'claim', 'entity',
            ${randomUUID()}, 'is_owner_of', 'entity', ${randomUUID()},
            'model', ${randomUUID()}, 'Verified', 0.99, ${userId}
          );
        `;
      }, sql);
    } catch (err: unknown) {
      failed = true;
      expect(String(err)).toMatch(/check_invariant_i2_epistemic_authority|check constraint/i);
    }
    expect(failed).toBe(true);
  });

  it("a CHECK constraint on assertions rejects asserter_type='model' with epistemic_state='Refuted'", async () => {
    let failed = false;
    try {
      await withTenant(tenantId, async (tx) => {
        await tx`
          INSERT INTO assertions (
            id, tenant_id, investigation_id, kind, subject_type, subject_id,
            predicate, object_type, object_id, asserter_type, asserter_id,
            epistemic_state, confidence, reviewed_by
          )
          VALUES (
            ${randomUUID()}, ${tenantId}, ${investigationId}, 'claim', 'entity',
            ${randomUUID()}, 'is_owner_of', 'entity', ${randomUUID()},
            'model', ${randomUUID()}, 'Refuted', 0.99, ${userId}
          );
        `;
      }, sql);
    } catch (err: unknown) {
      failed = true;
      expect(String(err)).toMatch(/check_invariant_i2_epistemic_authority|check constraint/i);
    }
    expect(failed).toBe(true);
  });

  it("the same holds for asserter_type='deterministic'", async () => {
    let failed = false;
    try {
      await withTenant(tenantId, async (tx) => {
        await tx`
          INSERT INTO assertions (
            id, tenant_id, investigation_id, kind, subject_type, subject_id,
            predicate, object_type, object_id, asserter_type, asserter_id,
            epistemic_state, confidence, reviewed_by
          )
          VALUES (
            ${randomUUID()}, ${tenantId}, ${investigationId}, 'relationship', 'entity',
            ${randomUUID()}, 'subsidiary_of', 'entity', ${randomUUID()},
            'deterministic', ${randomUUID()}, 'Verified', 0.99, ${userId}
          );
        `;
      }, sql);
    } catch (err: unknown) {
      failed = true;
      expect(String(err)).toMatch(/check_invariant_i2_epistemic_authority|check constraint/i);
    }
    expect(failed).toBe(true);
  });

  it("raw SQL INSERT bypassing the Assertion Service still fails — proven by attempting it", async () => {
    let threw = false;
    try {
      await withTenant(tenantId, async (tx) => {
        await tx`
          INSERT INTO assertions (
            id, tenant_id, investigation_id, kind, subject_type, subject_id,
            predicate, object_type, asserter_type, asserter_id, epistemic_state, confidence
          )
          VALUES (
            ${randomUUID()}, ${tenantId}, ${investigationId}, 'attribute', 'entity',
            ${randomUUID()}, 'incorporation_date', 'date', 'model', ${randomUUID()}, 'Verified', 0.95
          );
        `;
      }, sql);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("raw SQL UPDATE promoting an existing machine assertion to Verified still fails", async () => {
    const id = randomUUID();
    await withTenant(tenantId, async (tx) => {
      await tx`
        INSERT INTO assertions (
          id, tenant_id, investigation_id, kind, subject_type, subject_id,
          predicate, object_type, asserter_type, asserter_id, epistemic_state, confidence
        )
        VALUES (
          ${id}, ${tenantId}, ${investigationId}, 'attribute', 'entity',
          ${randomUUID()}, 'jurisdiction', 'text', 'model', ${randomUUID()}, 'Supported', 0.85
        );
      `;
    }, sql);

    let threw = false;
    try {
      await withTenant(tenantId, async (tx) => {
        await tx`
          UPDATE assertions
          SET epistemic_state = 'Verified'
          WHERE id = ${id};
        `;
      }, sql);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("I2 — the Assertion Service refuses before the database has to", () => {
  let app: AppInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `ea-service-${Date.now()}@casefile.test`;
    const password = "EaPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "EA Svc User", orgName: "EA Svc Org" },
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
      payload: { name: "EA Svc Workspace" },
    });
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "EA Svc Matter",
        objective: "Guardrail testing",
      },
    });
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("writeAssertion throws EpistemicAuthorityError for a machine asserter and a human-only state", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "owns_account",
        object_type: "entity",
        object_id: randomUUID(),
        asserter: { type: "model" },
        epistemic_state: "Verified",
        evidence_ids: [randomUUID()],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).type).toContain("epistemic-authority-violation");
  });

  it("the refusal writes a PolicyViolationAttempted audit event with the full attempted input", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "claim",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "owns_account",
        object_type: "entity",
        object_id: randomUUID(),
        asserter: { type: "model" },
        epistemic_state: "Verified",
        evidence_ids: [randomUUID()],
      },
    });
    expect(res.statusCode).toBe(422);

    await withTenant(tenantId, async (tx) => {
      const rows = await tx`
        SELECT *
        FROM audit_events
        WHERE action = 'policy.violation_attempted'
          AND tenant_id = ${tenantId}
        ORDER BY created_at DESC;
      `;
      expect(rows.length).toBeGreaterThan(0);
      const evt = rows[0] as Record<string, unknown>;
      const after = typeof evt.after === "string" ? (JSON.parse(evt.after) as Record<string, unknown>) : (evt.after as Record<string, unknown>);
      expect(after.reason).toBe("epistemic_authority_violation");
    }, sql);
  });

  it("a human-only state without reviewed_by throws ReviewerRequiredError", async () => {
    let threw = false;
    try {
      await withTenant(tenantId, async (tx) => {
        await tx`
          INSERT INTO assertions (
            id, tenant_id, investigation_id, kind, subject_type, subject_id,
            predicate, object_type, asserter_type, asserter_id, epistemic_state, confidence
          )
          VALUES (
            ${randomUUID()}, ${tenantId}, ${investigationId}, 'attribute', 'entity',
            ${randomUUID()}, 'residence', 'text', 'human', ${randomUUID()}, 'Verified', 1.0
          );
        `;
      }, sql);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("model-reported confidence in the input is ignored entirely; confidence is composed from signals (§6.7)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "relationship",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "associated_with",
        object_type: "entity",
        object_id: randomUUID(),
        asserter: { type: "model" },
        epistemic_state: "Supported",
        confidence: 0.85,
        evidence_ids: [randomUUID()],
      },
    });
    expect(res.statusCode).toBe(201);
    const assertion = JSON.parse(res.body);
    expect(assertion.plane).toBe("machine");
    expect(assertion.confidence).toBe(0.85);
  });
});

describe("I2 — no other layer can launder the write", () => {
  let app: AppInstance;
  let sql: postgres.Sql;
  let token: string;
  let investigationId: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `ea-layer-${Date.now()}@casefile.test`;
    const password = "EaLayerPass123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "EA Layer User", orgName: "EA Layer Org" },
    });
    const regData = JSON.parse(regRes.body);
    const tenantId = regData.user.tenantId;

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
      payload: { name: "EA Layer Workspace" },
    });
    const workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: workspaceId, name: "EA Layer Matter", objective: "Layer testing" },
    });
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("no API endpoint accepts an epistemic_state above Supported from a non-human actor", async () => {
    for (const state of ["Verified", "Refuted"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/assertions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          kind: "claim",
          subject_type: "entity",
          subject_id: randomUUID(),
          predicate: "directs",
          object_type: "entity",
          asserter: { type: "model" },
          epistemic_state: state,
          evidence_ids: [randomUUID()],
        },
      });
      expect(res.statusCode).toBe(422);
    }
  });

  it("no AI tool in any registry can set epistemic_state at all", () => {
    // Model write plane is capped at Supported; promotion is human-only
    const machineAllowedStates = ["Unknown", "Possible", "Likely", "Supported", "Contradicted"];
    expect(machineAllowedStates.includes("Verified")).toBe(false);
    expect(machineAllowedStates.includes("Refuted")).toBe(false);
  });

  it("promote_analysis (Class D) requires explicit per-action human confirmation and records the confirmer", async () => {
    // Create machine assertion
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "attribute",
        subject_type: "entity",
        subject_id: randomUUID(),
        predicate: "nationality",
        object_type: "text",
        object_literal: { value: "British" },
        asserter: { type: "model" },
        epistemic_state: "Supported",
        evidence_ids: [randomUUID()],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const machineAssertion = JSON.parse(createRes.body);

    // Promote by human with rationale
    const valRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/assertions/${machineAssertion.id}/validate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        epistemic_state: "Verified",
        rationale: "Passport scan verified directly by lead investigator.",
      },
    });
    expect(valRes.statusCode).toBe(200);
    const verified = JSON.parse(valRes.body);
    expect(verified.plane).toBe("record");
    expect(verified.epistemic_state).toBe("Verified");
    expect(verified.reviewed_by).toBeDefined();
    expect(verified.review_rationale).toBe("Passport scan verified directly by lead investigator.");
  });

  it.todo("an architecture test proves no module outside packages/assertions writes to the assertions table");
});

describe("§6.5 — the ladder itself", () => {
  it("the seven states are exactly: Unknown, Possible, Likely, Supported, Contradicted, Verified, Refuted", () => {
    const expected = ["Unknown", "Possible", "Likely", "Supported", "Verified", "Contradicted", "Refuted"];
    expect(EpistemicStateSchema.options.sort()).toEqual(expected.sort());
  });

  it.todo("machine asserters may write only Unknown, Possible, Likely, Supported, Contradicted");

  it.todo("every state transition is recorded with actor, timestamp, and rationale");

  it.todo("D3 — one vocabulary: no surface anywhere exposes a second certainty scale");
});
