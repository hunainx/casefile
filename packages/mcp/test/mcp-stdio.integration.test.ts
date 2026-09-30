import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type postgres from "postgres";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { seedMcpPerson, type McpPerson } from "../../../apps/api/test/helpers/mcp-oauth.js";

/**
 * Phase 3 (plan section 5, D77): the stdio CLI (packages/mcp/src/cli.ts) runs as the real user
 * named by MCP_LOCAL_USER_ID, with the same eligibility check, per-tool role checks and audit
 * rows as /mcp. Without a valid MCP_LOCAL_USER_ID it refuses to start. It opens no port.
 */

const ROOT = resolve(__dirname, "../../..");
const TSX_CLI = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = resolve(ROOT, "packages/mcp/src/cli.ts");
const EIGHT = ["get_document_page", "get_evidence", "get_investigation", "get_source", "list_documents", "list_investigations", "matter_status", "search"];

describe("stdio MCP CLI runs as a real user (Phase 3)", () => {
  let db: postgres.Sql;
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  let investigator: McpPerson;
  let suspended: McpPerson;
  let viewer: McpPerson;

  function cliEnv(overrides: Record<string, string | undefined>): Record<string, string> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: getDbUrl(),
      MATTER_TENANT_ID: T,
      MATTER_INVESTIGATION_ID: INV,
      NODE_ENV: "development",
      VITEST: undefined,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  }

  function expectRefusal(overrides: Record<string, string | undefined>, reason: RegExp) {
    const res = spawnSync(process.execPath, [TSX_CLI, CLI], { cwd: ROOT, env: cliEnv(overrides), input: "", encoding: "utf8", timeout: 20_000, windowsHide: true });
    const stderr = `${res.stderr ?? ""}${res.error ? `\n${res.error.message}` : ""}`;
    expect(res.status, `cli.ts must exit non-zero (null = still running when killed)\n${stderr}`).not.toBeNull();
    expect(res.status, stderr).not.toBe(0);
    expect(stderr).toMatch(reason);
  }

  beforeAll(async () => {
    db = createDbClient(getDbUrl());
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Stdio Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Matter WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${INV}, ${T}, ${WS}, 'Stdio Case', 'Phase 3', 'collecting')`;
    }, db);
    investigator = await seedMcpPerson(db, { tenantId: T, workspaceId: WS, label: "stdio-inv", wsRole: "investigator" });
    suspended = await seedMcpPerson(db, { tenantId: T, workspaceId: WS, label: "stdio-susp", wsRole: "investigator", status: "suspended" });
    viewer = await seedMcpPerson(db, { tenantId: T, workspaceId: WS, label: "stdio-viewer", wsRole: "viewer" });
  });

  afterAll(async () => {
    await db.end();
  });

  it("refuses to start without MCP_LOCAL_USER_ID", () => expectRefusal({ MCP_LOCAL_USER_ID: undefined }, /MCP_LOCAL_USER_ID/));
  it("refuses to start for a user who is not in the matter", () => expectRefusal({ MCP_LOCAL_USER_ID: randomUUID() }, /MCP_LOCAL_USER_ID/));
  it("refuses to start for a suspended user", () => expectRefusal({ MCP_LOCAL_USER_ID: suspended.id }, /not active/));
  it("refuses to start for a user whose role allows no MCP tools (viewer)", () => expectRefusal({ MCP_LOCAL_USER_ID: viewer.id }, /viewer/));

  it("as an investigator: 8 tools listed, get_download_link refused, every call audited as that user", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, CLI], cwd: ROOT, env: cliEnv({ MCP_LOCAL_USER_ID: investigator.id }), stderr: "pipe" });
    const client = new McpClient({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport as Parameters<typeof client.connect>[0]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(EIGHT);
      const status = await client.callTool({ name: "matter_status", arguments: {} });
      expect(status.isError, JSON.stringify(status.content)).toBeFalsy();
      const invs = await client.callTool({ name: "list_investigations", arguments: {} });
      expect(invs.isError).toBeFalsy();
      const refused = await client.callTool({ name: "get_download_link", arguments: { document_id: randomUUID() } });
      expect(refused.isError).toBe(true);
      expect((refused.content as Array<{ text: string }>)[0]!.text).toMatch(/does not allow get_download_link/);
    } finally {
      await client.close();
    }
    const rows = await withTenant(T, (tx) => tx<{ action: string; actor_id: string; after: unknown }[]>`
      SELECT action, actor_id, after FROM audit_events
      WHERE tenant_id = ${T} AND actor_id = ${investigator.id} AND (action = 'mcp.tool_call' OR action LIKE 'auth.deny:%') ORDER BY seq`, db);
    expect(rows.map((r) => r.action)).toEqual(["mcp.tool_call", "mcp.tool_call", "auth.deny:export.create"]);
    for (const r of rows) {
      const after = typeof r.after === "string" ? JSON.parse(r.after) : r.after;
      expect(after.auth_mode).toBe("stdio");
    }
  });
});
