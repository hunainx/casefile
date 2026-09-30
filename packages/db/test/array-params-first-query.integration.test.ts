import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createDbClient, getDbUrl, withTenant } from "../src/index.js";
import { storeWebAuthnCredential } from "../../../apps/api/src/auth/service.js";
import { insertChunkRows, insertContentBlockRows, type ChunkRow, type ContentBlockRow } from "../../../tools/ingest-cli/src/batch-insert.js";

/**
 * Array parameters on a new client's first query (D68).
 *
 * postgres.js learns array types by querying pg_type when its first connection opens. The
 * query that opened the connection is built before that lookup has been applied, so
 * `sql.array([...])` — which picks its array type while the query is being built — is sent
 * as plain text ("a,b") and rejected as a malformed array literal. That is why
 * guardrails/no-sql-array.spec.ts bans it; the two demonstrations below are the only calls
 * it allows, and they are expected to FAIL.
 *
 * Plain JS arrays are not affected: their type comes from the server's description of the
 * statement, which arrives after the lookup. Every repo query that binds a JS array (found by
 * a TypeScript audit of all 588 postgres tagged templates, recorded in D68) runs below,
 * verbatim, as the FIRST query on a new client with no driver patch, and must pass.
 */
describe("array parameters on a new client's first query (D68)", () => {
  // Superuser on the local test cluster: RLS would otherwise hide the fixtures from a
  // statement that must run before anything (including withTenant's set_config) on its client.
  const ownerUrl = process.env.DATABASE_URL_TEST_OWNER!;
  const setup = createDbClient(getDbUrl());
  const t = randomUUID();
  const ws = randomUUID();
  const inv = randomUUID();
  const user = randomUUID();
  const src = randomUUID();
  const art = randomUUID();
  const doc = randomUUID();
  const block = randomUUID();
  const chunk = randomUUID();
  const ev1 = randomUUID();
  const ev2 = randomUUID();
  const entA = randomUUID();
  const entB = randomUUID();

  /** Runs `fn` as the very first query of a brand-new client, then closes it. */
  async function firstQuery<T>(fn: (sql: ReturnType<typeof createDbClient>) => Promise<T>): Promise<T> {
    const fresh = createDbClient(ownerUrl, { max: 1 });
    try {
      return await fn(fresh);
    } finally {
      await fresh.end();
    }
  }

  beforeAll(async () => {
    await withTenant(t, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${t}, ${t}, 'Array Param Org')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${ws}, ${t}, 'Array Param WS')`;
      await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${user}, ${t}, 'arrays@test.local', 'Array Tester')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage, created_by)
               VALUES (${inv}, ${t}, ${ws}, 'Array Case', 'Array params', 'collecting', ${user})`;
      await tx`INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, source_class, status, created_by)
               VALUES (${src}, ${t}, ${ws}, ${inv}, 'a.txt', 'text/plain', 1, ${"0".repeat(64)}, 'gs://casefile-localtest-sources/a.txt', 'primary_record', 'admitted', ${user})`;
      await tx`INSERT INTO artifacts (id, tenant_id, source_id, kind, storage_uri) VALUES (${art}, ${t}, ${src}, 'primary', 'gs://casefile-localtest-sources/a.txt')`;
      await tx`INSERT INTO content_documents (id, tenant_id, artifact_id, doc_type, full_text) VALUES (${doc}, ${t}, ${art}, 'memo', 'a')`;
      await tx`INSERT INTO content_blocks (id, tenant_id, content_document_id, sequence, block_type, text, char_start, char_end, page)
               VALUES (${block}, ${t}, ${doc}, 1, 'paragraph', 'a', 0, 1, 1)`;
      await tx`INSERT INTO chunks (id, tenant_id, investigation_id, content_document_id, text) VALUES (${chunk}, ${t}, ${inv}, ${doc}, 'a')`;
      for (const id of [ev1, ev2]) {
        await tx`INSERT INTO evidence (id, tenant_id, investigation_id, source_id, content_block_id, locator, cited_text, span_hash, evidence_type, weight, integrity_status, status, version, admitted_by)
                 VALUES (${id}, ${t}, ${inv}, ${src}, ${block}, '{"page": 1}'::jsonb, 'a', ${"1".repeat(64)}, 'documentary', 'strong', 'intact', 'active', 1, ${user})`;
      }
      for (const [id, name] of [[entA, "Alpha Ltd"], [entB, "Beta Ltd"]] as const) {
        await tx`INSERT INTO entities (id, tenant_id, investigation_id, type, canonical_name, created_by)
                 VALUES (${id}, ${t}, ${inv}, 'Organization', ${name}, ${user})`;
      }
    }, setup);
  });

  afterAll(async () => {
    await setup.end();
  });

  describe("the driver bug the guardrail protects against (expected failures)", () => {
    it("sql.array() of strings FAILS as the first query on a new client: sent as text \"a,b\"", async () => {
      await expect(
        firstQuery((sql) => sql`SELECT ${sql.array(["a", "b"])}::text[] AS k`),
      ).rejects.toThrow('malformed array literal: "a,b"');
    });

    it("sql.array() of UUIDs FAILS as the first query on a new client: declared as a single value", async () => {
      await expect(
        firstQuery((sql) => sql`SELECT id FROM evidence WHERE id = ANY(${sql.array([ev1, ev2], 2950)})`),
      ).rejects.toThrow("op ANY/ALL (array) requires array on right side");
    });
  });

  describe("every repo query that binds a JS array, as the first query on a new client", () => {
    // The production statement itself: storeWebAuthnCredential is what verifyWebAuthnRegistration
    // calls (DEV-021, resolved in Phase 2A), run here on a brand-new client.
    it("apps/api/src/auth/service.ts storeWebAuthnCredential — webauthn_credentials.transports text[]", async () => {
      const credentialId = `cred_${randomUUID()}`;
      await firstQuery((sql) =>
        storeWebAuthnCredential(sql, {
          id: credentialId,
          tenantId: t,
          userId: user,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          transports: ["usb", "nfc"],
          name: "Default Passkey",
        }),
      );
      const [row] = await withTenant(t, (tx) => tx`SELECT transports FROM webauthn_credentials WHERE id = ${credentialId}`, setup);
      expect(row!.transports).toEqual(["usb", "nfc"]);
    });

    it("apps/api/src/routes/assertions.ts:192 — evidence id = ANY(uuid[])", async () => {
      const evidenceIds = [ev1, ev2];
      const evRows = await firstQuery((tx) => tx<{ id: string; span_hash: string; locator: unknown; content_block_id: string | null; block_text: string | null }[]>`
            SELECT e.id, e.span_hash, e.locator, e.content_block_id, b.text AS block_text
            FROM evidence e
            LEFT JOIN content_blocks b ON b.id = e.content_block_id
            WHERE e.id = ANY(${evidenceIds})
              AND e.investigation_id = ${inv}
              AND e.tenant_id = ${t}
      `);
      expect(evRows.map((r) => r.id).sort()).toEqual([ev1, ev2].sort());
    });

    it("apps/api/src/routes/assertions.ts:263 — assertions.evidence_ids uuid[] (create)", async () => {
      const assertionId = randomUUID();
      const [row] = await firstQuery((tx) => tx`
        INSERT INTO assertions (
          id, tenant_id, investigation_id, kind, subject_type, subject_id,
          predicate, object_type, object_id, object_literal, valid_from,
          valid_to, asserter_type, asserter_id, epistemic_state,
          confidence, plane, evidence_ids, derivation, review_state,
          reviewed_by, reviewed_at, created_by
        )
        VALUES (
          ${assertionId}, ${t}, ${inv}, ${"claim"},
          ${"entity"}, ${entA}, ${"transferred_funds_to"},
          ${"entity"}, ${entB},
          ${null}::jsonb,
          ${null}::jsonb,
          ${null}::jsonb,
          ${"human"}, ${user}, ${"Supported"},
          ${0.8}, ${"record"}, ${[ev1, ev2]},
          ${JSON.stringify({})}::jsonb, ${"unreviewed"},
          ${null}, ${null},
          ${user}
        )
        RETURNING *;
      `);
      expect([...row!.evidence_ids].sort()).toEqual([ev1, ev2].sort());
    });

    it("apps/api/src/routes/assertions.ts:503 — assertions.evidence_ids uuid[] (supersede)", async () => {
      const oldId = randomUUID();
      await withTenant(t, (tx) => tx`
        INSERT INTO assertions (id, tenant_id, investigation_id, kind, subject_type, subject_id, predicate, object_type, asserter_type, asserter_id, created_by)
        VALUES (${oldId}, ${t}, ${inv}, 'claim', 'entity', ${entA}, 'old', 'entity', 'human', ${user}, ${user})`, setup);
      const newId = randomUUID();
      const [row] = await firstQuery((tx) => tx`
        INSERT INTO assertions (
          id, tenant_id, investigation_id, kind, subject_type, subject_id,
          predicate, object_type, object_id, object_literal, valid_from,
          valid_to, asserter_type, asserter_id, epistemic_state,
          confidence, plane, evidence_ids, derivation, created_by, supersedes
        )
        VALUES (
          ${newId}, ${t}, ${inv}, ${"claim"},
          ${"entity"}, ${entA}, ${"transferred_funds_to"},
          ${"entity"}, ${entB},
          ${null}::jsonb,
          ${null}::jsonb,
          ${null}::jsonb,
          ${"human"}, ${user}, ${"Supported"},
          ${0.8}, ${"record"}, ${[ev2]},
          ${JSON.stringify({})}::jsonb, ${user}, ${oldId}
        )
        RETURNING *;
      `);
      expect(row!.evidence_ids).toEqual([ev2]);
    });

    it("apps/api/src/routes/relationships.ts:135 — relationships.evidence_ids uuid[]", async () => {
      const relId = randomUUID();
      const [row] = await firstQuery((tx) => tx`
        INSERT INTO relationships (
          id, tenant_id, investigation_id, source_entity_id, target_entity_id,
          type, direction, valid_from, valid_to, current_status,
          attributes, discovery_channel, inference_pattern, evidence_ids,
          epistemic_state, confidence, created_by
        )
        VALUES (
          ${relId}, ${t}, ${inv}, ${entA},
          ${entB}, ${"paid"}, ${"directed"},
          ${null}::jsonb,
          ${null}::jsonb,
          ${"active"}, ${JSON.stringify({})}::jsonb,
          ${"stated"}, ${null},
          ${[ev1, ev2]}, ${"Supported"}, ${0.85},
          ${user}
        )
        RETURNING *;
      `);
      expect([...row!.evidence_ids].sort()).toEqual([ev1, ev2].sort());
    });

    it("apps/api/src/services/investigation-memory.ts:219 — chunk id = ANY(uuid[])", async () => {
      const targetChunkIds = [chunk];
      const chunkRows = await firstQuery((tx) => tx<{ id: string; source_id: string; text: string; contextual_header: string | null }[]>`
      SELECT c.id, a.source_id, c.text, c.contextual_header
      FROM chunks c
      JOIN content_documents cd ON cd.id = c.content_document_id
      JOIN artifacts a ON a.id = cd.artifact_id
      WHERE c.id = ANY(${targetChunkIds}) AND c.investigation_id = ${inv} AND c.tenant_id = ${t};
    `);
      expect(chunkRows.map((r) => r.id)).toEqual([chunk]);
      expect(chunkRows[0]!.source_id).toBe(src);
    });

    it("apps/api/src/routes/memory.ts:111 — entities is_focal = (id = ANY(uuid[]))", async () => {
      const focalEntityIds = [entB];
      await firstQuery((tx) => tx`
          UPDATE entities
          SET is_focal = (id = ANY(${focalEntityIds}))
          WHERE investigation_id = ${inv} AND tenant_id = ${t};
        `);
      const rows = await withTenant(t, (tx) => tx<{ id: string; is_focal: boolean }[]>`
        SELECT id, is_focal FROM entities WHERE investigation_id = ${inv}`, setup);
      expect(Object.fromEntries(rows.map((r) => [r.id, r.is_focal]))).toEqual({ [entA]: false, [entB]: true });
    });

    it("apps/api/test/live-ingest.integration.test.ts:570 — content_blocks id = ANY(uuid[]) (test code)", async () => {
      const blockIds = [block];
      const blockLookup = await firstQuery((tx) => tx`
          SELECT id, text FROM content_blocks WHERE id = ANY(${blockIds}::uuid[]);
        `);
      expect(blockLookup.map((r) => r.id)).toEqual([block]);
    });
  });

  describe("the ingest's multi-row INSERTs (tools/ingest-cli/src/batch-insert.ts, D89), as the first query on a new client", () => {
    it("insertChunkRows — chunks.block_ids uuid[] inside the row helper, 1,537 rows (batches of 1000, 512, 16, 8, 1)", async () => {
      const rows: ChunkRow[] = Array.from({ length: 1537 }, (_, i) => ({
        id: randomUUID(),
        tenant_id: t,
        investigation_id: inv,
        content_document_id: doc,
        block_ids: [randomUUID(), ...(i % 3 === 0 ? [randomUUID()] : [])],
        char_start: i,
        char_end: i + 1,
        text: `chunk ${i}`,
        contextual_header: `Document 'batch.txt', Section ${i}`,
        token_count: 1,
        doc_type: "document",
        created_by: user,
      }));
      const statements = await firstQuery((sql) => insertChunkRows(sql, rows));
      expect(statements).toBe(5);
      const stored = await withTenant(t, (tx) => tx<{ id: string; block_ids: string[] }[]>`
        SELECT id, block_ids FROM chunks WHERE id = ANY(${rows.map((r) => r.id)})`, setup);
      const byId = new Map(stored.map((r) => [r.id, r.block_ids]));
      expect(stored.length).toBe(rows.length);
      for (const r of rows) expect(byId.get(r.id)).toEqual(r.block_ids);
    });

    it("insertContentBlockRows — 1,001 rows (batches of 1000 and 1)", async () => {
      const rows: ContentBlockRow[] = Array.from({ length: 1001 }, (_, i) => ({
        id: randomUUID(),
        tenant_id: t,
        content_document_id: doc,
        sequence: i + 2,
        block_type: "paragraph",
        section_path: i % 2 ? null : `Section ${i}`,
        page: i % 2 ? null : 1,
        char_start: i,
        char_end: i + 1,
        text: `block ${i}`,
        language: "en",
        ocr_confidence: null,
        created_by: user,
      }));
      const statements = await firstQuery((sql) => insertContentBlockRows(sql, rows));
      expect(statements).toBe(2);
      const stored = await withTenant(t, (tx) => tx<{ id: string; sequence: number; section_path: string | null; page: number | null; text: string }[]>`
        SELECT id, sequence, section_path, page, text FROM content_blocks WHERE id = ANY(${rows.map((r) => r.id)}) ORDER BY sequence`, setup);
      expect(stored.map((r) => [r.id, r.sequence, r.section_path, r.page, r.text])).toEqual(
        rows.map((r) => [r.id, r.sequence, r.section_path, r.page, r.text]),
      );
    });
  });
});
