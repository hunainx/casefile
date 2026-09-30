import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { SearchRequestSchema, AssembleManifestRequestSchema } from "@casefile/contracts";
import { handleSearch, handleGetSource, handleGetDocumentPage, SearchToolSchema } from "@casefile/mcp";
import { executeSearch } from "../src/services/search-engine.js";
import { assembleContextManifest } from "../src/services/investigation-memory.js";
import type postgres from "postgres";

/**
 * BIGDATA-2B (D94): text is stored once, in content_blocks.text. A new chunk that is exactly one
 * block has chunks.text NULL; a new document whose text the blocks give back exactly has
 * content_documents.full_text NULL. Old rows keep the text in all three places.
 *
 * One matter holds one document of each kind, with the same shape (two lines, the second at
 * char 1 past the end of the first), and every reader of chunk or document text
 * (docs/PLAN-BIG-DATA.md section 12) must give the same text for both:
 *   MCP search · REST search engine · investigation memory tier 4 · /extract by source (I9 at
 *   exact offsets) · /extract by chunk · GET /sources/:id (its chunks) · MCP get_source and
 *   get_document_page (blocks, unchanged).
 */
describe("apps/api — every reader of chunk and document text, for old rows and text-once rows (BIGDATA-2B)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let userId: string;
  let investigationId: string;
  let token: string;

  type Doc = { word: string; sourceId: string; chunkIds: string[]; line1: string; line2: string; full: string };
  const docs: Record<"old" | "new", Doc> = {} as Record<"old" | "new", Doc>;

  const seed = async (kind: "old" | "new", word: string) => {
    const line1 = `Fake ${kind} memo about the ${word} shipment.`;
    const line2 = `Second line: ${word} Freight signed the delivery note.`;
    const full = `${line1}\n${line2}`;
    const src = randomUUID(), art = randomUUID(), doc = randomUUID(), b1 = randomUUID(), b2 = randomUUID(), c1 = randomUUID(), c2 = randomUUID();
    const wsRows = await withTenant(tenantId, (tx) => tx<{ workspace_id: string }[]>`SELECT workspace_id FROM investigations WHERE id = ${investigationId}`, sql);
    await withTenant(tenantId, async (tx) => {
      await tx`INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, status, source_class, created_by)
               VALUES (${src}, ${tenantId}, ${wsRows[0]!.workspace_id}, ${investigationId}, ${`${kind}-style.docx`}, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                       ${full.length}, ${"a".repeat(63) + (kind === "old" ? "1" : "2")}, ${`gcs://casefile-localtest-sources/${tenantId}/${kind}`}, 'indexed', 'primary_record', ${userId})`;
      await tx`INSERT INTO artifacts (id, tenant_id, source_id, kind, parser, storage_uri, created_by) VALUES (${art}, ${tenantId}, ${src}, 'primary', 'docx_parser', ${`gcs://casefile-localtest-sources/${tenantId}/${kind}`}, ${userId})`;
      await tx`INSERT INTO content_documents (id, tenant_id, artifact_id, doc_type, full_text, created_by)
               VALUES (${doc}, ${tenantId}, ${art}, 'word_document', ${kind === "old" ? full : null}, ${userId})`;
      await tx`INSERT INTO content_blocks (id, tenant_id, content_document_id, sequence, block_type, section_path, page, char_start, char_end, text, created_by)
               VALUES (${b1}, ${tenantId}, ${doc}, 1, 'paragraph', 'Document Body', 1, 0, ${line1.length}, ${line1}, ${userId}),
                      (${b2}, ${tenantId}, ${doc}, 2, 'paragraph', 'Document Body', 1, ${line1.length + 1}, ${full.length}, ${line2}, ${userId})`;
      for (const [cid, bid, text, cs, ce] of [[c1, b1, line1, 0, line1.length], [c2, b2, line2, line1.length + 1, full.length]] as const) {
        await tx`INSERT INTO chunks (id, tenant_id, investigation_id, content_document_id, block_ids, char_start, char_end, text, contextual_header, token_count, doc_type, created_by)
                 VALUES (${cid}, ${tenantId}, ${investigationId}, ${doc}, ${[bid]}, ${cs}, ${ce}, ${kind === "old" ? text : null}, ${`Document '${kind}-style.docx'`}, 10, 'word_document', ${userId})`;
      }
    }, sql);
    docs[kind] = { word, sourceId: src, chunkIds: [c1, c2], line1, line2, full };
  };

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `text-once-${Date.now()}@casefile.test`;
    const password = "TextOnceReaders123!";
    const reg = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Text Once Reader", orgName: "Text Once Fake Org" } });
    expect(reg.statusCode).toBe(201);
    tenantId = JSON.parse(reg.body).user.tenantId;
    userId = JSON.parse(reg.body).user.id;
    const tok = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } });
    token = JSON.parse(tok.body).accessToken;
    const ws = await app.inject({ method: "POST", url: "/v1/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: "Text once WS" } });
    const inv = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: JSON.parse(ws.body).id, name: "Text once", objective: "BIGDATA-2B readers" },
    });
    investigationId = JSON.parse(inv.body).id;
    await seed("old", "Zephyrine");
    await seed("new", "Vantorel");
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  const ctx = () => ({ tenantId, investigationId, userId, roles: ["lead_inv"] });

  /** MCP search returns the chunk text */
  const mcpSearch = async (kind: "old" | "new") => {
      const d = docs[kind];
      const out = await withTenant(tenantId, (tx) => handleSearch(tx, ctx(), SearchToolSchema.parse({ query: d.word })), sql);
      expect(out.items.map((i) => (i as { text: string }).text).sort()).toEqual([d.line1, d.line2].sort());
  };

  /** the REST search engine returns the chunk text */
  const restSearch = async (kind: "old" | "new") => {
      const d = docs[kind];
      const out = await withTenant(tenantId, (tx) => executeSearch(tx, tenantId, investigationId, userId, SearchRequestSchema.parse({ query: d.word, mode: "keyword" })), sql);
      expect(out.items.map((i) => i.text).sort()).toEqual([d.line1, d.line2].sort());
  };

  /** investigation memory (tier 4) returns the chunk text */
  const memory = async (kind: "old" | "new") => {
      const d = docs[kind];
      const m = await withTenant(tenantId, (tx) => assembleContextManifest(tx, tenantId, investigationId, userId, AssembleManifestRequestSchema.parse({ operation: "test", target_chunk_ids: d.chunkIds })), sql);
      expect(m.tier4.map((c) => c.text).sort()).toEqual([d.line1, d.line2].sort());
  };

  /** GET /sources/:id returns the chunks with their text */
  const getSource = async (kind: "old" | "new") => {
      const d = docs[kind];
      const res = await app.inject({ method: "GET", url: `/v1/investigations/${investigationId}/sources/${d.sourceId}`, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as { chunks: Array<{ text: string }>; blocks: Array<{ text: string }> };
      expect(body.chunks.map((c) => c.text).sort()).toEqual([d.line1, d.line2].sort());
      expect(body.blocks.map((b) => b.text)).toEqual([d.line1, d.line2]);
  };

  /** /extract by source verifies a quote at its exact offset in the document text (I9) */
  const extractBySource = async (kind: "old" | "new") => {
      const d = docs[kind];
      const quote = `${d.word} Freight`;
      const at = d.full.indexOf(quote, d.line1.length);
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/extract`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: d.sourceId,
          items: [
            { kind: "entity", entity_type: "Organization", canonical_name: `${d.word} Freight`, quoted_span: quote, char_start: at, char_end: at + quote.length },
            { kind: "entity", entity_type: "Organization", canonical_name: "Not In Text Ltd", quoted_span: "Not In Text Ltd", char_start: 0, char_end: 15 },
          ],
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as { verified_count: number; discarded_count: number; created_entities: unknown[] };
      expect([body.verified_count, body.discarded_count]).toEqual([1, 1]);
      const mention = await withTenant(tenantId, (tx) => tx<{ char_start: number; char_end: number }[]>`
        SELECT char_start, char_end FROM entity_mentions WHERE source_id = ${d.sourceId}`, sql);
      expect(mention).toEqual([{ char_start: at, char_end: at + quote.length }]);
  };

  /** /extract by chunk verifies a quote in the chunk text */
  const extractByChunk = async (kind: "old" | "new") => {
      const d = docs[kind];
      const quote = `${d.word} Freight`;
      const at = d.line2.indexOf(quote);
      const res = await app.inject({
        method: "POST",
        url: `/v1/investigations/${investigationId}/extract`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          source_id: d.sourceId,
          chunk_id: d.chunkIds[1],
          items: [{ kind: "entity", entity_type: "Organization", canonical_name: `${d.word} Freight Chunk`, quoted_span: quote, char_start: at, char_end: at + quote.length }],
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((JSON.parse(res.body) as { verified_count: number }).verified_count).toBe(1);
  };

  /** MCP get_source and get_document_page return the block text (blocks keep it in both) */
  const blocks = async (kind: "old" | "new") => {
      const d = docs[kind];
      const src = await withTenant(tenantId, (tx) => handleGetSource(tx, ctx(), { source_id: d.sourceId }), sql);
      expect(src.content_blocks.map((b) => b.text)).toEqual([d.line1, d.line2]);
      const page = await withTenant(tenantId, (tx) => handleGetDocumentPage(tx, ctx(), { document_id: d.sourceId, page: 1 }), sql);
      expect(page.blocks.map((b) => b.text)).toEqual([d.line1, d.line2]);
  };

  describe("old rows (text in three places)", () => {
    it("MCP search returns the chunk text", () => mcpSearch("old"));
    it("the REST search engine returns the chunk text", () => restSearch("old"));
    it("investigation memory (tier 4) returns the chunk text", () => memory("old"));
    it("GET /sources/:id returns the chunks with their text", () => getSource("old"));
    it("/extract by source verifies a quote at its exact offset in the document text (I9)", () => extractBySource("old"));
    it("/extract by chunk verifies a quote in the chunk text", () => extractByChunk("old"));
    it("MCP get_source and get_document_page return the block text (blocks keep it in both)", () => blocks("old"));
  });

  describe("text-once rows (chunks.text and full_text NULL)", () => {
    it("MCP search returns the chunk text", () => mcpSearch("new"));
    it("the REST search engine returns the chunk text", () => restSearch("new"));
    it("investigation memory (tier 4) returns the chunk text", () => memory("new"));
    it("GET /sources/:id returns the chunks with their text", () => getSource("new"));
    it("/extract by source verifies a quote at its exact offset in the document text (I9)", () => extractBySource("new"));
    it("/extract by chunk verifies a quote in the chunk text", () => extractByChunk("new"));
    it("MCP get_source and get_document_page return the block text (blocks keep it in both)", () => blocks("new"));
  });
});
