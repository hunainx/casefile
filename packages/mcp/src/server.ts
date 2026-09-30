import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withTenant, createDbClient } from "@casefile/db";
import { checkLocalMcpUser, type McpCaller } from "./access.js";
import { registerMatterTools } from "./dispatch.js";

/**
 * The stdio MCP server (packages/mcp/src/cli.ts). Operator-only: it runs on the operator's own
 * computer with the database credentials in its environment and opens no network port (the MCP
 * spec takes stdio credentials from the environment, not OAuth).
 *
 * Since Phase 3 (D77) it runs as a real user, MCP_LOCAL_USER_ID, with the same checks as /mcp:
 * the eligibility check (active, workspace member, not walled, MCP-capable role) is re-run in
 * every call's transaction, every tool is decided by the per-tool role table, and every call or
 * refusal writes the same audit rows, marked auth_mode "stdio".
 */
export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
  tenantId: string;
  investigationId: string;
  /** MCP_LOCAL_USER_ID. */
  userId: string;
  dbClient?: ReturnType<typeof createDbClient>;
}

export const STDIO_AUTH_MODE = "stdio";

export function createCasefileMcpServer(options: CreateMcpServerOptions) {
  const db = options.dbClient || createDbClient();

  const server = new Server(
    { name: options.name || "casefile-mcp", version: options.version || "1.0.0" },
    { capabilities: { tools: {} } },
  );

  registerMatterTools(server, {
    async caller(tx): Promise<McpCaller> {
      const user = await checkLocalMcpUser(tx, { tenantId: options.tenantId, investigationId: options.investigationId, userId: options.userId });
      if (!user.ok) throw new Error(`Refused: ${user.problem}`);
      return {
        ...user.access,
        tenantId: options.tenantId,
        investigationId: options.investigationId,
        userId: options.userId,
        sessionId: null,
        clientId: null,
        authMode: STDIO_AUTH_MODE,
      };
    },
    inTx: (fn) => withTenant(options.tenantId, fn, db),
    requestId: () => `req_stdio_${randomUUID().replace(/-/g, "")}`,
    // Each call has its own transaction: a failed audit write rolls it back and the handler's
    // error reaches the client as a JSON-RPC error, so no output leaves without its row.
    onAuditFailure: () => undefined,
  });

  return {
    server,
    async startStdio() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}
