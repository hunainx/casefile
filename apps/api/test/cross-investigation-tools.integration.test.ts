import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { claudeCodeCimdTransport, mcpAccessToken, mcpPost, seedMcpPerson } from "./helpers/mcp-oauth.js";

/**
 * Phase 4A, section A (DEV-029, D82): no MCP tool reads another investigation of the same tenant.
 * A second investigation is seeded in the matter's tenant with a source, a content document,
 * a page of text, a chunk and an evidence record. Every one of the 9 tools is called with that
 * investigation's IDs (and its chunk text for search); each answers "not found" or returns
 * nothing from it. The same objects of the matter's own investigation are read as a control,
 * so a tool that returns nothing at all cannot pass.
 */

const OTHER_TEXT = "walledsecretphrase";
const OURS_TEXT = "matterownphrase";

interface Seeded {
  sourceId: string;
  contentDocumentId: string;
  evidenceId: string;
  filename: string;
}

describe("DEV-029: every MCP tool sees only MATTER_INVESTIGATION_ID", () => {
  let app: ReturnType<typeof buildApp>;
  let sql: postgres.Sql;
  let token: string;
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  const OTHER_INV = randomUUID();
  let ours: Seeded;
  let other: Seeded;
  const savedEnv: Record<string, string | undefined> = {};

  async function seedDocument(investigationId: string, label: string, text: string, admittedBy: string): Promise<Seeded> {
    const sourceId = randomUUID();
    const artifactId = randomUUID();
    const contentDocumentId = randomUUID();
    const blockId = randomUUID();
    const evidenceId = randomUUID();
    const filename = `${label}-${randomUUID().slice(0, 8)}.pdf`;
    const sha = createHash("sha256").update(filename).digest("hex");
    const pageText = `Page one of ${label}: ${text} appears here.`;
    await withTenant(T, async (tx) => {
      await tx`
        INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, status)
        VALUES (${sourceId}, ${T}, ${WS}, ${investigationId}, ${filename}, 'application/pdf', 100, ${sha}, ${`gs://casefile-localtest-sources/${T}/${sha}`}, 'indexed')`;
      await tx`INSERT INTO artifacts (id, tenant_id, source_id) VALUES (${artifactId}, ${T}, ${sourceId})`;
      await tx`INSERT INTO content_documents (id, tenant_id, artifact_id, full_text) VALUES (${contentDocumentId}, ${T}, ${artifactId}, ${pageText})`;
      await tx`
        INSERT INTO content_blocks (id, tenant_id, content_document_id, sequence, page, char_start, char_end, text)
        VALUES (${blockId}, ${T}, ${contentDocumentId}, 1, 1, 0, ${pageText.length}, ${pageText})`;
      await tx`
        INSERT INTO chunks (id, tenant_id, investigation_id, content_document_id, block_ids, char_end, text)
        VALUES (${randomUUID()}, ${T}, ${investigationId}, ${contentDocumentId}, ${`{${blockId}}`}, ${pageText.length}, ${pageText})`;
      await tx`
        INSERT INTO evidence (id, tenant_id, investigation_id, source_id, artifact_id, content_block_id, cited_text, span_hash, admitted_by)
        VALUES (${evidenceId}, ${T}, ${investigationId}, ${sourceId}, ${artifactId}, ${blockId}, ${text}, ${createHash("sha256").update(text).digest("hex")}, ${admittedBy})`;
    }, sql);
    return { sourceId, contentDocumentId, evidenceId, filename };
  }

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcpPost(app, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body).result as { isError?: boolean; content: { text: string }[] };
  };
  const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
  /** Refused the way an unknown ID is: an error saying "not found", nothing of the other investigation. */
  const expectNotFound = (r: { isError?: boolean; content: { text: string }[] }) => {
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/not found/);
    expect(text(r)).not.toContain(OTHER_TEXT);
    expect(text(r)).not.toContain(other.filename);
    expect(text(r)).not.toContain("Walled Other Case");
  };

  beforeAll(async () => {
    for (const k of ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID"]) savedEnv[k] = process.env[k];
    process.env.MATTER_TENANT_ID = T;
    process.env.MATTER_INVESTIGATION_ID = INV;
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql, oauth: { cimdTransport: claudeCodeCimdTransport } });
    await app.ready();
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'DEV-029 Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Matter WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${INV}, ${T}, ${WS}, 'The Matter', 'Phase 4A', 'collecting')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${OTHER_INV}, ${T}, ${WS}, 'Walled Other Case', 'must never be shown', 'collecting')`;
    }, sql);
    // ws_admin: all 9 tools, including get_download_link.
    const person = await seedMcpPerson(sql, { tenantId: T, workspaceId: WS, investigationId: INV, label: "dev029", wsRole: "ws_admin" });
    token = await mcpAccessToken(app, person);
    ours = await seedDocument(INV, "ours", OURS_TEXT, person.id);
    other = await seedDocument(OTHER_INV, "other", OTHER_TEXT, person.id);
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("tools/list offers the 9 tools this test covers", async () => {
    const res = await mcpPost(app, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = JSON.parse(res.body).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "get_document_page", "get_download_link", "get_evidence", "get_investigation", "get_source",
      "list_documents", "list_investigations", "matter_status", "search",
    ]);
  });

  it("1 matter_status counts only the matter's sources", async () => {
    const r = await call("matter_status", {});
    const body = JSON.parse(text(r));
    expect(body.investigation.id).toBe(INV);
    expect(body.sources.total).toBe(1);
    expect(text(r)).not.toContain("Walled Other Case");
  });

  it("2 list_investigations returns only the matter's investigation", async () => {
    const r = await call("list_investigations", {});
    expect(JSON.parse(text(r)).investigations.map((i: { id: string }) => i.id)).toEqual([INV]);
    expect(text(r)).not.toContain("Walled Other Case");
  });

  it("3 get_investigation with the other investigation's ID answers not found", async () => {
    expectNotFound(await call("get_investigation", { investigation_id: OTHER_INV }));
  });

  it("4 list_documents lists only the matter's source", async () => {
    const r = await call("list_documents", {});
    expect(JSON.parse(text(r)).documents.map((d: { id: string }) => d.id)).toEqual([ours.sourceId]);
    expect(text(r)).not.toContain(other.filename);
  });

  it("5 get_source with the other investigation's source ID answers not found", async () => {
    expect(JSON.parse(text(await call("get_source", { source_id: ours.sourceId }))).source.id, "control").toBe(ours.sourceId);
    expectNotFound(await call("get_source", { source_id: other.sourceId }));
  });

  it("6 get_document_page with the other investigation's source ID or content document ID answers not found", async () => {
    const control = await call("get_document_page", { document_id: ours.sourceId, page: 1 });
    expect(text(control), "control: the matter's own page is readable").toContain(OURS_TEXT);
    const controlByDoc = await call("get_document_page", { document_id: ours.contentDocumentId, page: 1 });
    expect(text(controlByDoc), "control by content document ID").toContain(OURS_TEXT);
    expectNotFound(await call("get_document_page", { document_id: other.sourceId, page: 1 }));
    expectNotFound(await call("get_document_page", { document_id: other.contentDocumentId, page: 1 }));
  });

  it("7 get_download_link with the other investigation's source ID answers not found", async () => {
    expectNotFound(await call("get_download_link", { document_id: other.sourceId }));
  });

  it("8 get_evidence with the other investigation's evidence ID answers not found", async () => {
    expect(JSON.parse(text(await call("get_evidence", { evidence_id: ours.evidenceId }))).evidence.id, "control").toBe(ours.evidenceId);
    expectNotFound(await call("get_evidence", { evidence_id: other.evidenceId }));
  });

  it("9 search for the other investigation's chunk text finds nothing", async () => {
    const control = JSON.parse(text(await call("search", { query: OURS_TEXT })));
    expect(control.total_hits, "control: the matter's own chunk is found").toBe(1);
    for (const args of [{ query: OTHER_TEXT }, { query: OTHER_TEXT, filters: { source_id: other.sourceId } }]) {
      const body = JSON.parse(text(await call("search", args)));
      expect(body.total_hits).toBe(0);
      expect(body.items).toEqual([]);
      // The query is echoed back; nothing else may carry the other investigation's text.
      expect(JSON.stringify({ ...body, query: "" })).not.toContain(OTHER_TEXT);
    }
  });
});
