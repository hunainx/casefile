import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { buildApp } from "../../../apps/api/src/app.js";
import { createDbClient, withTenant } from "@casefile/db";
import { claudeCodeCimdTransport, mcpAccessToken, seedMcpPerson } from "../../../apps/api/test/helpers/mcp-oauth.js";
import {
  computeSha256,
  getObjectStore,
  setObjectStore,
  ensureEmulatorBucket,
  type TenantScopedKey,
} from "@casefile/storage";

/**
 * /mcp on the MCP SDK's Streamable HTTP transport (Phase 1 of docs/PLAN-MCP-AUTH.md, D67):
 * protocol negotiation, notifications, statelessness, the auth gate in front of every
 * method, D64 ordering, and a real SDK client calling every tool over HTTP.
 * Since Phase 2B (D73) every request carries a real OAuth access token, obtained through the
 * sign-in flow by apps/api/test/helpers/mcp-oauth.ts.
 */
describe("MCP Streamable HTTP transport (/mcp)", () => {
  let app: ReturnType<typeof buildApp>;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let mcpToken = "";
  const ids = {
    tenant: randomUUID(),
    workspace: randomUUID(),
    investigation: randomUUID(),
    user: randomUUID(),
    source: randomUUID(),
    artifact: randomUUID(),
    doc: randomUUID(),
    block: randomUUID(),
    chunk: randomUUID(),
    evidence: randomUUID(),
  };

  // D64 probe: how many tenant transactions are open, and how many were open when the
  // first byte of the current response was written to the socket.
  let openTransactions = 0;
  let transactionsStarted = 0;
  let openAtFirstByte: number | undefined;

  const JSON_ACCEPT = "application/json, text/event-stream";
  const authed = () => ({ authorization: `Bearer ${mcpToken}`, accept: JSON_ACCEPT });

  beforeAll(async () => {
    process.env.MATTER_TENANT_ID = ids.tenant;
    process.env.MATTER_INVESTIGATION_ID = ids.investigation;

    const sql = createDbClient();
    db = sql;
    const countingDb = new Proxy(sql, {
      get(target, prop, receiver) {
        if (prop === "begin") {
          return (...args: unknown[]) => {
            openTransactions += 1;
            transactionsStarted += 1;
            return (target.begin as (...a: unknown[]) => Promise<unknown>)(...args).finally(() => {
              openTransactions -= 1;
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    app = buildApp({ db: countingDb, oauth: { cimdTransport: claudeCodeCimdTransport } });
    app.addHook("onRequest", async (_req, reply) => {
      const res = reply.raw;
      for (const method of ["writeHead", "write", "end"] as const) {
        const original = res[method] as (...a: unknown[]) => unknown;
        (res as unknown as Record<string, unknown>)[method] = function (this: unknown, ...a: unknown[]) {
          if (openAtFirstByte === undefined) openAtFirstByte = openTransactions;
          return original.apply(this, a);
        };
      }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const text = "Meridian Trading transferred 500,000 USD to Zurich escrow account on 12 May 2021.";
    const bytes = new TextEncoder().encode(text);
    const sha = computeSha256(bytes);
    const bucket = process.env.GCS_BUCKET_SOURCES!;
    const key = `${ids.tenant}/sources/${ids.source}/facility_agreement.txt`;
    await ensureEmulatorBucket(bucket);
    setObjectStore(null);
    await getObjectStore().put(key as TenantScopedKey, bytes, { contentType: "text/plain" });
    const uri = `gs://${bucket}/${key}`;
    const quote = "Meridian Trading transferred 500,000 USD";

    await withTenant(ids.tenant, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${ids.tenant}, ${ids.tenant}, 'Transport Test Org')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${ids.workspace}, ${ids.tenant}, 'Transport Test WS')`;
      await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${ids.user}, ${ids.tenant}, 'transport@test.local', 'Transport Tester')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage, created_by)
               VALUES (${ids.investigation}, ${ids.tenant}, ${ids.workspace}, 'Transport Case', 'Transport tests', 'collecting', ${ids.user})`;
      await tx`INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, source_class, status, created_by)
               VALUES (${ids.source}, ${ids.tenant}, ${ids.workspace}, ${ids.investigation}, 'facility_agreement.txt', 'text/plain', ${bytes.length}, ${sha}, ${uri}, 'primary_record', 'admitted', ${ids.user})`;
      await tx`INSERT INTO artifacts (id, tenant_id, source_id, kind, storage_uri) VALUES (${ids.artifact}, ${ids.tenant}, ${ids.source}, 'primary', ${uri})`;
      await tx`INSERT INTO content_documents (id, tenant_id, artifact_id, doc_type, full_text) VALUES (${ids.doc}, ${ids.tenant}, ${ids.artifact}, 'contract', ${text})`;
      await tx`INSERT INTO content_blocks (id, tenant_id, content_document_id, sequence, block_type, text, char_start, char_end, page)
               VALUES (${ids.block}, ${ids.tenant}, ${ids.doc}, 1, 'paragraph', ${text}, 0, ${text.length}, 1)`;
      await tx`INSERT INTO chunks (id, tenant_id, investigation_id, content_document_id, text) VALUES (${ids.chunk}, ${ids.tenant}, ${ids.investigation}, ${ids.doc}, ${text})`;
      await tx`INSERT INTO evidence (id, tenant_id, investigation_id, source_id, content_block_id, locator, cited_text, span_hash, evidence_type, weight, integrity_status, status, version, admitted_by)
               VALUES (${ids.evidence}, ${ids.tenant}, ${ids.investigation}, ${ids.source}, ${ids.block}, '{"page": 1}'::jsonb, ${quote}, ${computeSha256(new TextEncoder().encode(quote))}, 'documentary', 'strong', 'intact', 'active', 1, ${ids.user})`;
    }, sql);

    // ws_admin: all 9 tools (plan section 3), so every tool below can be called.
    const admin = await seedMcpPerson(sql, { tenantId: ids.tenant, workspaceId: ids.workspace, investigationId: ids.investigation, label: "transport", wsRole: "ws_admin" });
    mcpToken = await mcpAccessToken(app, admin);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.end();
  });

  beforeEach(() => {
    openAtFirstByte = undefined;
  });

  function post(payload: unknown, headers: Record<string, string> = authed(), url = "/mcp") {
    return app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
  }

  function initialize(protocolVersion: string) {
    return post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "transport-test", version: "0.0.0" } },
    });
  }

  it("initialize negotiates the current protocol version the client asks for", async () => {
    const res = await initialize(LATEST_PROTOCOL_VERSION);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(body.result.protocolVersion).not.toBe("2024-11-05");
    expect(body.result.serverInfo).toEqual({ name: "casefile-mcp", version: "1.0.0" });
    expect(body.result.capabilities.tools).toEqual({});
  });

  it("initialize answers an unknown future version with the latest version it supports", async () => {
    const res = await initialize("2099-01-01");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("notifications/initialized gets 202 with no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
  });

  it("tools/list returns exactly the 9 read tools", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.statusCode).toBe(200);
    const names = JSON.parse(res.body).result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(9);
    expect([...names].sort()).toEqual(
      [
        "get_document_page",
        "get_download_link",
        "get_evidence",
        "get_investigation",
        "get_source",
        "list_documents",
        "list_investigations",
        "matter_status",
        "search",
      ],
    );
  });

  it("is stateless: no Mcp-Session-Id is issued and a request needs no prior initialize", async () => {
    const init = await initialize(LATEST_PROTOCOL_VERSION);
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    // A brand-new request, as another Cloud Run instance would see it: no session, no init.
    const res = await post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "matter_status", arguments: {} } },
      { ...authed(), "mcp-protocol-version": LATEST_PROTOCOL_VERSION },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(JSON.parse(res.body).result.isError).toBeUndefined();
  });

  it("replies with plain JSON, not an SSE stream, even when the client accepts SSE", async () => {
    const res = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "matter_status", arguments: {} } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^application\/json/);
    expect(String(res.headers["content-type"])).not.toContain("text/event-stream");
  });

  it("serves clients that send no Accept header and refuses ones that accept neither JSON nor SSE", async () => {
    const noAccept = await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { authorization: `Bearer ${mcpToken}` });
    expect(noAccept.statusCode).toBe(200);
    const htmlOnly = await post({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { authorization: `Bearer ${mcpToken}`, accept: "text/html" });
    expect(htmlOnly.statusCode).toBe(406);
  });

  // One it() per case, written out: guardrails/verify-integrity.spec.ts compares the it()
  // blocks in the source with the tests vitest collected.
  describe("auth gate runs before the method check", () => {
    type Method = "POST" | "GET" | "DELETE";

    async function expectUnauthorized(method: Method, url: string, token?: string) {
      const res = await app.inject({
        method,
        url,
        headers: { accept: JSON_ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(method === "POST" ? { payload: { jsonrpc: "2.0", id: 7, method: "tools/list" } } : {}),
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error.code).toBe(-32001);
    }

    async function expectMethodNotAllowed(method: "GET" | "DELETE", url: string) {
      const res = await app.inject({ method, url, headers: authed() });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("POST");
      expect(JSON.parse(res.body).error.message).toBe("Method not allowed.");
    }

    const WRONG = "not_an_access_token_0000000000000";

    it("POST /mcp without a token → 401", () => expectUnauthorized("POST", "/mcp"));
    it("POST /mcp/ without a token → 401", () => expectUnauthorized("POST", "/mcp/"));
    it("GET /mcp without a token → 401", () => expectUnauthorized("GET", "/mcp"));
    it("GET /mcp/ without a token → 401", () => expectUnauthorized("GET", "/mcp/"));
    it("DELETE /mcp without a token → 401", () => expectUnauthorized("DELETE", "/mcp"));
    it("DELETE /mcp/ without a token → 401", () => expectUnauthorized("DELETE", "/mcp/"));
    it("POST /mcp with a wrong token → 401", () => expectUnauthorized("POST", "/mcp", WRONG));
    it("POST /mcp/ with a wrong token → 401", () => expectUnauthorized("POST", "/mcp/", WRONG));
    it("GET /mcp with a wrong token → 401", () => expectUnauthorized("GET", "/mcp", WRONG));
    it("GET /mcp/ with a wrong token → 401", () => expectUnauthorized("GET", "/mcp/", WRONG));
    it("DELETE /mcp with a wrong token → 401", () => expectUnauthorized("DELETE", "/mcp", WRONG));
    it("DELETE /mcp/ with a wrong token → 401", () => expectUnauthorized("DELETE", "/mcp/", WRONG));

    it("GET /mcp with a valid token → 405, POST only", () => expectMethodNotAllowed("GET", "/mcp"));
    it("GET /mcp/ with a valid token → 405, POST only", () => expectMethodNotAllowed("GET", "/mcp/"));
    it("DELETE /mcp with a valid token → 405, POST only", () => expectMethodNotAllowed("DELETE", "/mcp"));
    it("DELETE /mcp/ with a valid token → 405, POST only", () => expectMethodNotAllowed("DELETE", "/mcp/"));
  });

  describe("D64: the response is written only after the tenant transaction commits", () => {
    async function expectNoOpenTransactionAtFirstByte(payload: Record<string, unknown>) {
      const startedBefore = transactionsStarted;
      const res = await post(payload);
      expect(res.statusCode).toBe(200);
      expect(transactionsStarted - startedBefore, "the request must run inside a tenant transaction").toBeGreaterThan(0);
      expect(openAtFirstByte, "a byte was written while the request's transaction was still open").toBe(0);
    }

    it("tools/call: no transaction is open when the first response byte is written", () =>
      expectNoOpenTransactionAtFirstByte({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search", arguments: { query: "escrow" } } }));
    it("tools/list: no transaction is open when the first response byte is written", () =>
      expectNoOpenTransactionAtFirstByte({ jsonrpc: "2.0", id: 10, method: "tools/list" }));
    it("initialize: no transaction is open when the first response byte is written", () =>
      expectNoOpenTransactionAtFirstByte({ jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "d64", version: "0" } } }));
  });

  it("a real MCP SDK client connects over HTTP and calls every tool", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
    });
    const client = new McpClient({ name: "casefile-transport-test", version: "0.0.0" });
    // The SDK's own client transport type trips exactOptionalPropertyTypes (sessionId?: string).
    await client.connect(transport as Parameters<typeof client.connect>[0]); // initialize + notifications/initialized
    try {
      expect(client.getServerVersion()).toEqual({ name: "casefile-mcp", version: "1.0.0" });
      expect(transport.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      expect(transport.sessionId).toBeUndefined();

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(9);

      const calls: Array<[string, Record<string, unknown>]> = [
        ["matter_status", {}],
        ["list_investigations", {}],
        ["get_investigation", { investigation_id: ids.investigation }],
        ["list_documents", {}],
        ["get_source", { source_id: ids.source }],
        ["get_document_page", { document_id: ids.source, page: 1 }],
        ["get_download_link", { document_id: ids.source }],
        ["get_evidence", { evidence_id: ids.evidence }],
        ["search", { query: "escrow" }],
      ];
      expect(calls.map(([n]) => n).sort()).toEqual(tools.map((t) => t.name).sort());
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as Array<{ type: string; text: string }>;
        expect(result.isError, `${name}: ${content[0]?.text}`).toBeFalsy();
        expect(content[0]?.type).toBe("text");
        expect(() => JSON.parse(content[0]!.text)).not.toThrow();
      }
    } finally {
      await client.close();
    }
  });
});
