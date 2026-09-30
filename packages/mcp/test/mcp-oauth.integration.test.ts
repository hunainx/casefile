import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { buildApp } from "../../../apps/api/src/app.js";
import { AuthService } from "../../../apps/api/src/auth/service.js";
import { signJwt } from "../../../apps/api/src/auth/crypto.js";
import { createDbClient, withTenant } from "@casefile/db";
import { computeSha256, getObjectStore, setObjectStore, ensureEmulatorBucket, type TenantScopedKey } from "@casefile/storage";
import { nextTotpCode } from "../../../apps/api/test/helpers/totp.js";
import {
  CLAUDE_CODE_CLIENT,
  MCP_RESOURCE,
  claimsToResign,
  claudeCodeCimdTransport,
  jwtClaims,
  mcpAccessToken,
  mcpPost,
  seedMcpPerson,
  signInForMcp,
  type McpPerson,
} from "../../../apps/api/test/helpers/mcp-oauth.js";

/**
 * Phase 2B (docs/PLAN-MCP-AUTH.md sections 2, 3, 4 and 7): /mcp takes only the OAuth access
 * token, checked on every request against the database; every tool is checked against the
 * caller's role; every allowed call and every denial is audited before the reply is sent.
 * Every token here comes from the real sign-in flow (apps/api/test/helpers/mcp-oauth.ts).
 */

const WWW_AUTH_NO_TOKEN =
  'Bearer resource_metadata="https://mcp.casefile.test/.well-known/oauth-protected-resource/mcp", scope="casefile.read"';

const ALL_TOOLS = [
  "get_document_page",
  "get_download_link",
  "get_evidence",
  "get_investigation",
  "get_source",
  "list_documents",
  "list_investigations",
  "matter_status",
  "search",
];
const EIGHT_TOOLS = ALL_TOOLS.filter((t) => t !== "get_download_link");

interface Matter {
  tenant: string;
  workspace: string;
  investigation: string;
  source: string;
  evidence: string;
  owner: string;
  /** A phrase that appears only in this matter's documents. */
  marker: string;
  name: string;
}

function newMatter(label: string): Matter {
  return {
    tenant: randomUUID(),
    workspace: randomUUID(),
    investigation: randomUUID(),
    source: randomUUID(),
    evidence: randomUUID(),
    owner: randomUUID(),
    marker: `${label}-only-phrase-${randomUUID().slice(0, 8)}`,
    name: `${label} Matter Case`,
  };
}

describe("/mcp requires the OAuth access token and checks every tool against the role (Phase 2B)", () => {
  let app: ReturnType<typeof buildApp>;
  let db: postgres.Sql;
  const A = newMatter("Alpha");
  const B = newMatter("Bravo");
  const savedEnv: Record<string, string | undefined> = {};

  /** The deployment serves one matter; switch which one (routes read the env per request). */
  function serve(m: Matter) {
    process.env.MATTER_TENANT_ID = m.tenant;
    process.env.MATTER_INVESTIGATION_ID = m.investigation;
  }

  async function seedMatter(m: Matter) {
    const text = `Meridian Trading transferred 500,000 USD to Zurich escrow account. ${m.marker}.`;
    const bytes = new TextEncoder().encode(text);
    const bucket = process.env.GCS_BUCKET_SOURCES!;
    const key = `${m.tenant}/sources/${m.source}/facility_agreement.txt`;
    await ensureEmulatorBucket(bucket);
    await getObjectStore().put(key as TenantScopedKey, bytes, { contentType: "text/plain" });
    const uri = `gs://${bucket}/${key}`;
    const quote = "Meridian Trading transferred 500,000 USD";
    const artifact = randomUUID();
    const doc = randomUUID();
    const block = randomUUID();
    await withTenant(m.tenant, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${m.tenant}, ${m.tenant}, ${`${m.name} Org`})`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${m.workspace}, ${m.tenant}, 'Matter WS')`;
      await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${m.owner}, ${m.tenant}, ${`owner-${m.owner.slice(0, 8)}@casefile.test`}, 'Matter owner')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage)
               VALUES (${m.investigation}, ${m.tenant}, ${m.workspace}, ${m.name}, 'Phase 2B tests', 'collecting')`;
      await tx`INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, source_class, status)
               VALUES (${m.source}, ${m.tenant}, ${m.workspace}, ${m.investigation}, ${`${m.marker}.txt`}, 'text/plain', ${bytes.length}, ${computeSha256(bytes)}, ${uri}, 'primary_record', 'admitted')`;
      await tx`INSERT INTO artifacts (id, tenant_id, source_id, kind, storage_uri) VALUES (${artifact}, ${m.tenant}, ${m.source}, 'primary', ${uri})`;
      await tx`INSERT INTO content_documents (id, tenant_id, artifact_id, doc_type, full_text) VALUES (${doc}, ${m.tenant}, ${artifact}, 'contract', ${text})`;
      await tx`INSERT INTO content_blocks (id, tenant_id, content_document_id, sequence, block_type, text, char_start, char_end, page)
               VALUES (${block}, ${m.tenant}, ${doc}, 1, 'paragraph', ${text}, 0, ${text.length}, 1)`;
      await tx`INSERT INTO chunks (id, tenant_id, investigation_id, content_document_id, text) VALUES (${randomUUID()}, ${m.tenant}, ${m.investigation}, ${doc}, ${text})`;
      await tx`INSERT INTO evidence (id, tenant_id, investigation_id, source_id, content_block_id, locator, cited_text, span_hash, evidence_type, weight, integrity_status, status, version, admitted_by)
               VALUES (${m.evidence}, ${m.tenant}, ${m.investigation}, ${m.source}, ${block}, '{"page": 1}'::jsonb, ${quote}, ${computeSha256(new TextEncoder().encode(quote))}, 'documentary', 'strong', 'intact', 'active', 1, ${m.owner})`;
    }, db);
  }

  function person(m: Matter, label: string, wsRole: string, invRole?: string): Promise<McpPerson> {
    return seedMcpPerson(db, { tenantId: m.tenant, workspaceId: m.workspace, investigationId: m.investigation, label, wsRole, ...(invRole ? { invRole } : {}) });
  }

  function toolArgs(m: Matter): Record<string, Record<string, unknown>> {
    return {
      matter_status: {},
      list_investigations: {},
      get_investigation: { investigation_id: m.investigation },
      list_documents: {},
      get_source: { source_id: m.source },
      get_document_page: { document_id: m.source, page: 1 },
      get_download_link: { document_id: m.source },
      get_evidence: { evidence_id: m.evidence },
      search: { query: "escrow" },
    };
  }

  let rpcId = 1000;
  async function callTool(token: string | undefined, name: string, args: Record<string, unknown>) {
    return mcpPost(app, token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  }

  async function listTools(token: string): Promise<string[]> {
    const res = await mcpPost(app, token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/list" });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body).result.tools as Array<{ name: string }>).map((t) => t.name).sort();
  }

  /** Every tool in `allowed` works; get_download_link is refused unless allowed. */
  async function expectRole(token: string, allowed: string[]) {
    expect(await listTools(token)).toEqual([...allowed].sort());
    const args = toolArgs(B);
    for (const name of allowed) {
      const res = await callTool(token, name, args[name]!);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(200);
      const result = JSON.parse(res.body).result;
      expect(result.isError, `${name}: ${result.content?.[0]?.text}`).toBeFalsy();
      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    }
    for (const name of ALL_TOOLS.filter((t) => !allowed.includes(t))) {
      const res = await callTool(token, name, args[name]!);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(200);
      const result = JSON.parse(res.body).result;
      expect(result.isError, `${name} must be refused`).toBe(true);
      expect(result.content[0].text).toMatch(/does not allow/);
      expect(res.body).not.toContain(B.marker);
    }
  }

  async function expectNoToken(p: McpPerson) {
    const r = await signInForMcp(app, p);
    expect(r.status, r.body).toBe(403);
    expect(r.body).toMatch(/no token was issued/);
    expect(r.tokens).toBeUndefined();
  }

  function expectUnauthorized(res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
    expect(res.statusCode, res.body).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain('resource_metadata="https://mcp.casefile.test/.well-known/oauth-protected-resource/mcp"');
    expect(String(res.headers["www-authenticate"])).toContain('scope="casefile.read"');
    expect(JSON.parse(res.body).error.code).toBe(-32001);
  }

  /** All 9 tools with `token` against the served matter: each 401, and nothing of `m` leaks. */
  async function expectAllToolsRefused(token: string, m: Matter) {
    const args = toolArgs(m);
    for (const name of ALL_TOOLS) {
      const res = await callTool(token, name, args[name]!);
      expectUnauthorized(res);
      for (const secret of [m.marker, m.name, m.source, m.evidence]) expect(res.body, `${name} leaked ${secret}`).not.toContain(secret);
    }
    const list = await mcpPost(app, token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/list" });
    expectUnauthorized(list);
  }

  /** A token with the same session and user but claims changed and re-signed with the matter's secret. */
  function resign(token: string, patch: Record<string, unknown>, ttlSeconds = 900): string {
    return signJwt({ ...claimsToResign(token), ...patch }, ttlSeconds);
  }

  async function auditRows(m: Matter, userId: string, action: string) {
    return withTenant(m.tenant, (tx) => tx<{ actor_id: string; object_display: string; outcome: string; after: Record<string, unknown> | string | null; denial_reason: string | null }[]>`
      SELECT actor_id, object_display, outcome, after, denial_reason FROM audit_events
      WHERE tenant_id = ${m.tenant} AND actor_id = ${userId} AND action = ${action}
      ORDER BY seq`, db);
  }

  beforeAll(async () => {
    for (const k of ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID", "MCP_TOKEN"]) savedEnv[k] = process.env[k];
    setObjectStore(null);
    db = createDbClient();
    app = buildApp({ db, oauth: { cimdTransport: claudeCodeCimdTransport } });
    await app.ready();
    await seedMatter(A);
    await seedMatter(B);
    serve(B);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("no token: 401 with the sign-in hint", () => {
    it("POST /mcp", async () => {
      const res = await mcpPost(app, undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe(WWW_AUTH_NO_TOKEN);
    });

    it("GET /mcp", async () => {
      const res = await app.inject({ method: "GET", url: "/mcp" });
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe(WWW_AUTH_NO_TOKEN);
    });

    it("POST /mcp/", async () => {
      const res = await mcpPost(app, undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "/mcp/");
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe(WWW_AUTH_NO_TOKEN);
    });
  });

  describe("rejected with 401", () => {
    it("a bad signature", async () => {
      const token = await mcpAccessToken(app, await person(B, "badsig", "investigator"));
      const [h, p, s] = token.split(".");
      const res = await callTool(`${h}.${p}.${s!.slice(0, -2)}${s!.endsWith("AA") ? "BB" : "AA"}`, "matter_status", {});
      expectUnauthorized(res);
      expect(String(res.headers["www-authenticate"])).toContain('error="invalid_token"');
    });

    it("an expired token", async () => {
      const token = await mcpAccessToken(app, await person(B, "expired", "investigator"));
      expectUnauthorized(await callTool(resign(token, {}, -1), "matter_status", {}));
    });

    it("a REST API token (no aud)", async () => {
      const p = await person(B, "resttoken", "investigator");
      const token = await mcpAccessToken(app, p);
      expectUnauthorized(await callTool(signJwt(claimsToResign(token, ["aud", "scope", "cid"])), "matter_status", {}));
    });

    it("a token for another audience", async () => {
      const token = await mcpAccessToken(app, await person(B, "otheraud", "investigator"));
      expectUnauthorized(await callTool(resign(token, { aud: "https://other.casefile.test/mcp" }), "matter_status", {}));
    });

    it("the old static MCP_TOKEN", async () => {
      process.env.MCP_TOKEN = "test_mcp_static_secret_token_12345";
      try {
        expectUnauthorized(await callTool("test_mcp_static_secret_token_12345", "matter_status", {}));
      } finally {
        delete process.env.MCP_TOKEN;
      }
    });

    it("a valid token sent in the query string", async () => {
      const token = await mcpAccessToken(app, await person(B, "query", "investigator"));
      const res = await app.inject({
        method: "POST",
        url: `/mcp?access_token=${encodeURIComponent(token)}`,
        headers: { accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "matter_status", arguments: {} } },
      });
      expectUnauthorized(res);
      expect(res.body).not.toContain(B.name);
    });

    it("a valid token in the header when the query string carries one too", async () => {
      const token = await mcpAccessToken(app, await person(B, "both", "investigator"));
      const res = await app.inject({
        method: "POST",
        url: `/mcp?access_token=${encodeURIComponent(token)}`,
        headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "matter_status", arguments: {} } },
      });
      expectUnauthorized(res);
    });

    it("a session revoked through DELETE /v1/auth/sessions/:id: the very next call", async () => {
      const p = await person(B, "revoked", "investigator");
      const token = await mcpAccessToken(app, p);
      expect(JSON.parse((await callTool(token, "matter_status", {})).body).result.isError).toBeFalsy();
      // The user signs in to the REST API (password, then TOTP with the challenge token) and
      // revokes the Claude connection from their session list.
      const step = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email: p.email, password: p.password, tenantId: B.tenant } })).body);
      const rest = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: step.challengeToken, totpCode: await nextTotpCode(p.secret) } });
      expect(rest.statusCode, rest.body).toBe(200);
      const del = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${String(jwtClaims(token).sid)}`, headers: { authorization: `Bearer ${JSON.parse(rest.body).accessToken}` } });
      expect(del.statusCode, del.body).toBe(200);
      expectUnauthorized(await callTool(token, "matter_status", {}));
    });

    it("a deactivated user: the very next call", async () => {
      const p = await person(B, "deactivated", "investigator");
      const token = await mcpAccessToken(app, p);
      expect(JSON.parse((await callTool(token, "matter_status", {})).body).result.isError).toBeFalsy();
      await withTenant(B.tenant, (tx) => tx`UPDATE users SET status = 'suspended' WHERE id = ${p.id}`, db);
      expectUnauthorized(await callTool(token, "matter_status", {}));
    });

    it("a user removed from the matter's workspace", async () => {
      const p = await person(B, "removed", "investigator");
      const token = await mcpAccessToken(app, p);
      await withTenant(B.tenant, (tx) => tx`DELETE FROM workspace_members WHERE user_id = ${p.id}`, db);
      expectUnauthorized(await callTool(token, "matter_status", {}));
    });

    it("a user put behind an ethical wall", async () => {
      const p = await person(B, "walled", "investigator");
      const token = await mcpAccessToken(app, p);
      await withTenant(B.tenant, (tx) => tx`INSERT INTO ethical_walls (id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason)
                                             VALUES (${randomUUID()}, ${B.tenant}, ${B.workspace}, 'user', ${p.id}, ${B.investigation}, 'Conflict (test)')`, db);
      expectUnauthorized(await callTool(token, "matter_status", {}));
    });

    it("a user whose role no longer allows MCP (demoted to viewer)", async () => {
      const p = await person(B, "demoted", "investigator");
      const token = await mcpAccessToken(app, p);
      await withTenant(B.tenant, (tx) => tx`UPDATE workspace_members SET role = 'viewer' WHERE user_id = ${p.id}`, db);
      expectUnauthorized(await callTool(token, "matter_status", {}));
    });

    it("a token whose session is a REST session, not an OAuth connection", async () => {
      const p = await person(B, "restsession", "investigator");
      const token = await mcpAccessToken(app, p);
      const restSid = randomUUID();
      await withTenant(B.tenant, (tx) => tx`INSERT INTO auth_sessions (id, tenant_id, user_id, session_family_id, refresh_token_hash, expires_at)
                                             VALUES (${restSid}, ${B.tenant}, ${p.id}, ${randomUUID()}, ${randomUUID().replace(/-/g, "")}, NOW() + INTERVAL '1 hour')`, db);
      expectUnauthorized(await callTool(resign(token, { sid: restSid }), "matter_status", {}));
    });

    it("a token whose client does not match its connection", async () => {
      const token = await mcpAccessToken(app, await person(B, "othercid", "investigator"));
      expectUnauthorized(await callTool(resign(token, { cid: "https://client.casefile.test/cimd.json" }), "matter_status", {}));
    });

    it("the access token issued before a refresh, once the connection has rotated", async () => {
      const p = await person(B, "rotated", "investigator");
      const r = await signInForMcp(app, p);
      const old = r.tokens!;
      const refreshed = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: old.refresh_token!, client_id: CLAUDE_CODE_CLIENT, resource: MCP_RESOURCE }).toString(),
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expectUnauthorized(await callTool(old.access_token, "matter_status", {}));
      expect(JSON.parse((await callTool(JSON.parse(refreshed.body).access_token, "matter_status", {})).body).result.isError).toBeFalsy();
    });
  });

  it("a token without the casefile.read scope gets 403 insufficient_scope", async () => {
    const token = await mcpAccessToken(app, await person(B, "scope", "investigator"));
    const res = await callTool(resign(token, { scope: "openid" }), "matter_status", {});
    expect(res.statusCode, res.body).toBe(403);
    expect(String(res.headers["www-authenticate"])).toContain('error="insufficient_scope"');
    expect(String(res.headers["www-authenticate"])).toContain('scope="casefile.read"');
    expect(res.body).not.toContain(B.name);
  });

  describe("tenant isolation: a tenant A token against tenant B's matter", () => {
    it("a validly signed tenant A token → 401 on every tool, no tenant B rows", async () => {
      serve(A);
      let token: string;
      try {
        token = await mcpAccessToken(app, await person(A, "alpha-signed", "ws_admin"));
        expect(JSON.parse((await callTool(token, "search", { query: "escrow" })).body).result.content[0].text).toContain(A.marker);
      } finally {
        serve(B);
      }
      await expectAllToolsRefused(token, B);
    });

    it("a tenant A token with its tid changed to tenant B (signature untouched) → 401 on every tool", async () => {
      serve(A);
      let token: string;
      try {
        token = await mcpAccessToken(app, await person(A, "alpha-forged", "ws_admin"));
      } finally {
        serve(B);
      }
      const [h, , s] = token.split(".");
      const forged = Buffer.from(JSON.stringify({ ...jwtClaims(token), tid: B.tenant })).toString("base64url");
      await expectAllToolsRefused(`${h}.${forged}.${s}`, B);
    });

    it("a token signed with the matter's secret claiming tenant B for a tenant A user and session → 401 on every tool", async () => {
      serve(A);
      let token: string;
      try {
        token = await mcpAccessToken(app, await person(A, "alpha-resigned", "ws_admin"));
      } finally {
        serve(B);
      }
      await expectAllToolsRefused(resign(token, { tid: B.tenant }), B);
    });

    it("tenant B's own user sees tenant B's rows (the markers above would show a leak)", async () => {
      const token = await mcpAccessToken(app, await person(B, "bravo-own", "ws_admin"));
      const res = await callTool(token, "search", { query: "escrow" });
      expect(res.body).toContain(B.marker);
      expect(res.body).not.toContain(A.marker);
    });
  });

  describe("role matrix (plan section 3)", () => {
    it("ws_admin: all 9 tools", async () => expectRole(await mcpAccessToken(app, await person(B, "r-wsadmin", "ws_admin")), ALL_TOOLS));
    it("lead_inv: all 9 tools", async () => expectRole(await mcpAccessToken(app, await person(B, "r-leadinv", "lead_inv")), ALL_TOOLS));
    it("investigation role lead_investigator replaces workspace investigator (D48): all 9 tools", async () =>
      expectRole(await mcpAccessToken(app, await person(B, "r-invlead", "investigator", "lead_investigator")), ALL_TOOLS));
    it("investigator: 8 tools, get_download_link refused", async () => expectRole(await mcpAccessToken(app, await person(B, "r-investigator", "investigator")), EIGHT_TOOLS));
    it("analyst: 8 tools, get_download_link refused", async () => expectRole(await mcpAccessToken(app, await person(B, "r-analyst", "analyst")), EIGHT_TOOLS));
    it("reviewer: 8 tools, get_download_link refused", async () => expectRole(await mcpAccessToken(app, await person(B, "r-reviewer", "reviewer")), EIGHT_TOOLS));
    it("contributor: 8 tools, get_download_link refused", async () => expectRole(await mcpAccessToken(app, await person(B, "r-contributor", "contributor")), EIGHT_TOOLS));
    it("investigation role investigator replaces workspace ws_admin (D48): 8 tools", async () =>
      expectRole(await mcpAccessToken(app, await person(B, "r-wsadmin-invinv", "ws_admin", "investigator")), EIGHT_TOOLS));
    it("viewer: no token", async () => expectNoToken(await person(B, "r-viewer", "viewer")));
    it("auditor: no token", async () => expectNoToken(await person(B, "r-auditor", "auditor")));
    it("org_admin: no token", async () => expectNoToken(await person(B, "r-orgadmin", "org_admin")));
    it("investigation role viewer replaces workspace ws_admin (D48): no token", async () => expectNoToken(await person(B, "r-wsadmin-invviewer", "ws_admin", "viewer")));
  });

  describe("audit: committed before the reply", () => {
    it("an allowed call writes one row with the real user as actor, readable as soon as the reply arrives", async () => {
      const p = await person(B, "audit-ok", "investigator");
      const token = await mcpAccessToken(app, p);
      const res = await callTool(token, "get_source", { source_id: B.source });
      expect(JSON.parse(res.body).result.isError).toBeFalsy();
      const rows = await auditRows(B, p.id, "mcp.tool_call");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.object_display).toBe("get_source");
      expect(rows[0]!.outcome).toBe("success");
      // packages/audit stores before/after as a JSON string inside the jsonb column.
      const after = typeof rows[0]!.after === "string" ? JSON.parse(rows[0]!.after) : rows[0]!.after;
      expect(after).toMatchObject({ tool: "get_source", arguments: { source_id: B.source }, client_id: CLAUDE_CODE_CLIENT });
    });

    it("a tool that fails is still audited, with outcome failure", async () => {
      const p = await person(B, "audit-fail", "investigator");
      const token = await mcpAccessToken(app, p);
      const res = await callTool(token, "get_document_page", { document_id: B.source, page: 99999 });
      expect(JSON.parse(res.body).result.isError).toBe(true);
      const rows = await auditRows(B, p.id, "mcp.tool_call");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("failure");
    });

    it("a denied call writes the policy-denial event and no tool-call row", async () => {
      const p = await person(B, "audit-deny", "investigator");
      const token = await mcpAccessToken(app, p);
      const res = await callTool(token, "get_download_link", { document_id: B.source });
      expect(JSON.parse(res.body).result.isError).toBe(true);
      const denials = await auditRows(B, p.id, "auth.deny:export.create");
      expect(denials).toHaveLength(1);
      expect(denials[0]!.outcome).toBe("denied");
      expect(denials[0]!.denial_reason).toBe("approval_required");
      expect(await auditRows(B, p.id, "mcp.tool_call")).toHaveLength(0);
    });

    it("tools/list and initialize are not tool calls and write no tool-call row", async () => {
      const p = await person(B, "audit-list", "investigator");
      const token = await mcpAccessToken(app, p);
      await listTools(token);
      await mcpPost(app, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      expect(await auditRows(B, p.id, "mcp.tool_call")).toHaveLength(0);
    });
  });

  it("the Claude connection is one of the user's sessions, and tool calls run as that user", async () => {
    const p = await person(B, "identity", "reviewer");
    const token = await mcpAccessToken(app, p);
    const claims = jwtClaims(token);
    const rows = await withTenant(B.tenant, (tx) => AuthService.listSessions(tx, p.id, B.tenant), db);
    expect(rows.map((r) => r.id)).toContain(String(claims.sid));
    await callTool(token, "matter_status", {});
    const audit = await auditRows(B, p.id, "mcp.tool_call");
    expect(audit[0]!.actor_id).toBe(p.id);
  });
});
