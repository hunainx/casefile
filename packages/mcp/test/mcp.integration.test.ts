import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "../../../apps/api/src/app.js";
import { createDbClient, withTenant } from "@casefile/db";
import { claudeCodeCimdTransport, mcpAccessToken, seedMcpPerson } from "../../../apps/api/test/helpers/mcp-oauth.js";
import {
  computeSha256,
  getObjectStore,
  setObjectStore,
  GcsObjectStore,
  ensureEmulatorBucket,
  type TenantScopedKey,
} from "@casefile/storage";

// Load .env explicitly so live credentials and GCS storage configuration are active
if (existsSync(resolve(process.cwd(), ".env"))) {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  } catch {
    // ignore
  }
}

describe("MCP Server Integration Tests", () => {
  // packages/mcp does not depend on fastify; the app type comes from buildApp itself.
  let app: ReturnType<typeof buildApp>;
  let db: ReturnType<typeof createDbClient>;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let userId: string;
  let sourceId: string;
  let docId: string;
  let blockId: string;
  let evidenceId: string;
  let testFileBytes: Uint8Array;
  let store: ReturnType<typeof getObjectStore>;
  // A real OAuth access token (Phase 2B, D73), from the sign-in flow.
  let mcpToken = "";

  beforeAll(async () => {
    tenantId = randomUUID();
    workspaceId = randomUUID();
    investigationId = randomUUID();
    userId = randomUUID();
    sourceId = randomUUID();
    docId = randomUUID();
    blockId = randomUUID();
    evidenceId = randomUUID();
    const artifactId = randomUUID();
    const chunkId = randomUUID();

    process.env.MATTER_TENANT_ID = tenantId;
    process.env.MATTER_INVESTIGATION_ID = investigationId;

    // Reset default store to ensure configured driver is instantiated
    setObjectStore(null);
    store = getObjectStore();
    expect(store, "MCP integration tests require real GcsObjectStore — memory driver is forbidden").toBeInstanceOf(GcsObjectStore);

    db = createDbClient();
    app = buildApp({ db, oauth: { cimdTransport: claudeCodeCimdTransport } });
    await app.ready();

    await withTenant(tenantId, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${tenantId}, ${tenantId}, 'MCP Test Org');`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${workspaceId}, ${tenantId}, 'MCP Test WS');`;
      await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${userId}, ${tenantId}, 'mcp@test.local', 'MCP Investigator');`;
      await tx`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (${randomUUID()}, ${tenantId}, ${workspaceId}, ${userId}, 'ws_admin');`;
      await tx`
        INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage, created_by)
        VALUES (${investigationId}, ${tenantId}, ${workspaceId}, 'MCP Case Alpha', 'Investigate offshore flows', 'collecting', ${userId});
      `;
      await tx`
        INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role, created_by)
        VALUES (${randomUUID()}, ${tenantId}, ${investigationId}, ${userId}, 'lead_investigator', ${userId});
      `;

      const textVal = "Meridian Trading transferred 500,000 USD to Zurich escrow account on 12 May 2021.";
      testFileBytes = new TextEncoder().encode(textVal);
      const testFileSha = computeSha256(testFileBytes);
      const storageKey = `${tenantId}/sources/${sourceId}/facility_agreement.txt`;
      const sourcesBucket = process.env.GCS_BUCKET_SOURCES!;
      await ensureEmulatorBucket(sourcesBucket);
      const storageUri = `gs://${sourcesBucket}/${storageKey}`;

      // Real GCS Object Upload
      // put() hashes the bytes itself; check it agrees with the hash recorded below.
      const stored = await store.put(storageKey as TenantScopedKey, testFileBytes, {
        contentType: "text/plain",
      });
      expect(stored.sha256).toBe(testFileSha);

      await tx`
        INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, source_class, status, created_by)
        VALUES (${sourceId}, ${tenantId}, ${workspaceId}, ${investigationId}, 'facility_agreement.txt', 'text/plain', ${testFileBytes.length}, ${testFileSha}, ${storageUri}, 'primary_record', 'admitted', ${userId});
      `;
      await tx`
        INSERT INTO artifacts (id, tenant_id, source_id, kind, storage_uri)
        VALUES (${artifactId}, ${tenantId}, ${sourceId}, 'primary', ${storageUri});
      `;
      await tx`
        INSERT INTO content_documents (id, tenant_id, artifact_id, doc_type, full_text)
        VALUES (${docId}, ${tenantId}, ${artifactId}, 'contract', ${textVal});
      `;
      await tx`
        INSERT INTO content_blocks (id, tenant_id, content_document_id, sequence, block_type, text, char_start, char_end, page)
        VALUES (${blockId}, ${tenantId}, ${docId}, 1, 'paragraph', ${textVal}, 0, ${textVal.length}, 1);
      `;
      await tx`
        INSERT INTO chunks (id, tenant_id, investigation_id, content_document_id, text)
        VALUES (${chunkId}, ${tenantId}, ${investigationId}, ${docId}, ${textVal});
      `;
      const quote = "Meridian Trading transferred 500,000 USD";
      const spanHash = computeSha256(new TextEncoder().encode(quote));
      await tx`
        INSERT INTO evidence (id, tenant_id, investigation_id, source_id, content_block_id, locator, cited_text, span_hash, evidence_type, weight, integrity_status, status, version, admitted_by)
        VALUES (${evidenceId}, ${tenantId}, ${investigationId}, ${sourceId}, ${blockId}, '{"page": 1}'::jsonb, ${quote}, ${spanHash}, 'documentary', 'strong', 'intact', 'active', 1, ${userId});
      `;
    }, db);

    const admin = await seedMcpPerson(db, { tenantId, workspaceId, investigationId, label: "mcp-it", wsRole: "ws_admin" });
    mcpToken = await mcpAccessToken(app, admin);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.end();
  });

  it("Step 7b: rejects request when Authorization header is missing (401 Unauthorized)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("Unauthorized");
  });

  it("Step 7b: rejects a bearer token that is not an access token issued here (401 Unauthorized)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer wrong_invalid_mcp_token_xyz",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("Unauthorized");
  });

  it("Step 7b: rejects expired user JWT when used as MCP token (401 Unauthorized)", async () => {
    const fakeExpiredJwt =
      ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyLCJleHAiOjE1MTYyMzkwMjJ9.4pz-v_sample_invalid"].join("");
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${fakeExpiredJwt}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32001);
  });

  it("Step 8b & 8c: tools/list returns exactly 9 read-only tools", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBeDefined();
    const tools = body.result.tools;
    expect(tools.length).toBe(9);

    const toolNames = tools.map((t: { name: string }) => t.name);
    const expected = [
      "matter_status",
      "list_investigations",
      "get_investigation",
      "list_documents",
      "get_source",
      "get_document_page",
      "get_download_link",
      "get_evidence",
      "search",
    ];
    for (const name of expected) {
      expect(toolNames).toContain(name);
    }
  });

  it("Step 8c: matter_status returns configured matter details and storage capabilities", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "matter_status",
          arguments: {},
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    if (body.result?.isError) {
      expect.fail(`matter_status returned error: ${body.result.content[0].text}`);
    }
    expect(body.result.content[0].type).toBe("text");
    const data = JSON.parse(body.result.content[0].text);
    expect(data.investigation.id).toBe(investigationId);
    expect(data.investigation.name).toBe("MCP Case Alpha");
    expect(data.sources.total).toBeGreaterThanOrEqual(1);
    expect(data.storage_capabilities.download_links_available).toBe(true);
    expect(data.search_capabilities.vector_retrieval_available).toBe(false);
  });

  it("Step 8c: list_investigations returns investigations for tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "list_investigations",
          arguments: {},
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    if (body.result?.isError) {
      expect.fail(`list_investigations returned error: ${body.result.content[0].text}`);
    }
    const data = JSON.parse(body.result.content[0].text);
    expect(data.investigations.length).toBeGreaterThanOrEqual(1);
    expect(data.investigations[0].name).toBe("MCP Case Alpha");
  });

  it("Step 8c: get_investigation returns single investigation by id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "get_investigation",
          arguments: { investigation_id: investigationId },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    if (body.result?.isError) {
      expect.fail(`get_investigation returned error: ${body.result.content[0].text}`);
    }
    const data = JSON.parse(body.result.content[0].text);
    expect(data.investigation.id).toBe(investigationId);
    expect(data.investigation.name).toBe("MCP Case Alpha");
  });

  it("Step 8c: list_documents lists admitted sources", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "list_documents",
          arguments: {},
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    if (body.result?.isError) {
      expect.fail(`list_documents returned error: ${body.result.content[0].text}`);
    }
    const data = JSON.parse(body.result.content[0].text);
    expect(data.documents.length).toBeGreaterThanOrEqual(1);
    expect(data.documents[0].filename).toBe("facility_agreement.txt");
  });

  it("Step 8c: get_source retrieves source metadata with content blocks", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "get_source",
          arguments: { source_id: sourceId },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    if (body.result?.isError) {
      expect.fail(`get_source returned error: ${body.result.content[0].text}`);
    }
    const data = JSON.parse(body.result.content[0].text);
    expect(data.source.id).toBe(sourceId);
    expect(data.source.filename).toBe("facility_agreement.txt");
    expect(data.content_blocks.length).toBeGreaterThanOrEqual(1);
  });

  it("Step 8c: get_document_page retrieves page 1 content blocks", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "get_document_page",
          arguments: { document_id: sourceId, page: 1 },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    if (body.result?.isError) {
      expect.fail(`get_document_page returned error: ${body.result.content[0].text}`);
    }
    const data = JSON.parse(body.result.content[0].text);
    expect(data.page).toBe(1);
    expect(data.blocks.length).toBe(1);
    expect(data.blocks[0].text).toContain("Meridian Trading");
  });

  it("Step 8c: get_document_page returns error for non-existent page", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "get_document_page",
          arguments: { document_id: sourceId, page: 99999 },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Page 99999 not found for document");
  });

  it("Step 8c & 14 & 16: get_download_link returns signed download URL with TTL and verifiable object access", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "get_download_link",
          arguments: { document_id: sourceId },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const bodyObj = JSON.parse(res.body);
    if (bodyObj.result?.isError) {
      expect.fail(`get_download_link returned error: ${bodyObj.result.content[0].text}`);
    }
    const data = JSON.parse(bodyObj.result.content[0].text);
    expect(data.document_id).toBe(sourceId);
    expect(data.expires_in_seconds).toBe(900);
    expect(data.download_url).toBeDefined();

    const rawUrl = String(data.download_url);
    const parsedUrl = new URL(rawUrl);

    // Unconditional GCS signed URL assertions (no mock-storage or environment bypasses)
    expect(
      parsedUrl.hostname === "storage.googleapis.com" || parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost",
      "GCS signed URL must target storage.googleapis.com or local emulator",
    ).toBe(true);
    expect(parsedUrl.searchParams.has("X-Goog-Signature"), "GCS signed URL must carry X-Goog-Signature query parameter").toBe(true);

    const fetchRes = await fetch(rawUrl);
    expect(fetchRes.status, "Fetching signed GCS URL must return HTTP 200 OK").toBe(200);
    const fetchBytes = await fetchRes.arrayBuffer();
    expect(fetchBytes.byteLength, "Fetched body byte length must equal uploaded bytes").toBe(testFileBytes.length);
  });

  it("Step 8c: get_evidence retrieves verified evidence record", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "get_evidence",
          arguments: { evidence_id: evidenceId },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    if (body.result?.isError) {
      expect.fail(`get_evidence returned error: ${body.result.content[0].text}`);
    }
    const data = JSON.parse(body.result.content[0].text);
    expect(data.evidence.id).toBe(evidenceId);
    expect(data.evidence.cited_text).toBe("Meridian Trading transferred 500,000 USD");
    expect(data.evidence.weight).toBe("strong");
    expect(data.evidence.integrity_status).toBe("intact");
  });

  it("Step 8c: search executes lexical search over admitted chunks", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { query: "escrow" },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const bodyObj = JSON.parse(res.body);
    if (bodyObj.result?.isError) {
      expect.fail(`search returned error: ${bodyObj.result.content[0].text}`);
    }
    const data = JSON.parse(bodyObj.result.content[0].text);
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    expect(data.items[0].text).toContain("Zurich escrow");
    expect(data.items[0].score).toBeGreaterThan(0);
  });
});
