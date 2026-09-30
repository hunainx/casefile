#!/usr/bin/env node
import { createDbClient, withTenant } from "@casefile/db";
import { checkLocalMcpUser } from "./access.js";
import { createCasefileMcpServer } from "./server.js";

/**
 * The operator-only stdio MCP server. No network port: it talks to one MCP client over
 * stdin/stdout and reaches the database with the credentials in its environment.
 *
 * It runs as the real user MCP_LOCAL_USER_ID (D77) and refuses to start unless that user is an
 * active, MCP-eligible user of MATTER_TENANT_ID — the same check as sign-in.
 */
async function main() {
  const tenantId = process.env.MATTER_TENANT_ID;
  const investigationId = process.env.MATTER_INVESTIGATION_ID;

  if (!tenantId || !investigationId) {
    console.error("FATAL: MATTER_TENANT_ID and MATTER_INVESTIGATION_ID environment variables are required.");
    process.exit(1);
  }

  const db = createDbClient();
  const user = await withTenant(
    tenantId,
    (tx) => checkLocalMcpUser(tx, { tenantId, investigationId, userId: process.env.MCP_LOCAL_USER_ID }),
    db,
  );
  if (!user.ok) {
    console.error(`FATAL: the stdio MCP server refuses to start: ${user.problem}.`);
    await db.end();
    process.exit(1);
  }
  console.error(`casefile-mcp (stdio): running as ${user.email} (${process.env.MCP_LOCAL_USER_ID}), role ${user.access.effectiveRole}.`);

  const mcp = createCasefileMcpServer({
    name: "casefile-mcp",
    version: "1.0.0",
    tenantId,
    investigationId,
    userId: process.env.MCP_LOCAL_USER_ID!,
    dbClient: db,
  });

  await mcp.startStdio();
}

main().catch((err) => {
  console.error("MCP Server Error:", err);
  process.exit(1);
});
