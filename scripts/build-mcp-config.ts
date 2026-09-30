/**
 * Matter MCP Client Config Generator
 * Invoked: pnpm tsx scripts/build-mcp-config.ts
 * Reads .env matter configuration and generates Claude Desktop and Cursor MCP client JSON configuration files.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { matterConfig } from "../matter.config.js";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  const env: Record<string, string> = {};
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        env[key] = val;
      }
    }
  }
  return env;
}

function main() {
  const env = loadEnv();
  const repoRoot = process.cwd();
  const slug = matterConfig.matterSlug;

  const dbUrl = env["DATABASE_URL"] || "postgresql://casefile_app.<SUPABASE_PROJECT_REF>:<PASSWORD>@aws-0-<SUPABASE_REGION>.pooler.supabase.com:5432/postgres";
  const tenantId = env["MATTER_TENANT_ID"] || "00000000-0000-0000-0000-000000000000";
  const investigationId = env["MATTER_INVESTIGATION_ID"] || "00000000-0000-0000-0000-000000000000";
  // The remote connector is the exact MCP_PUBLIC_URL; each person signs in with their own
  // Casefile account when Claude first uses it (OAuth, D69/D73). There is no shared token.
  const mcpUrl = env["MCP_PUBLIC_URL"] || `${env["CASEFILE_API_URL"] || "<CASEFILE_API_URL>"}/mcp`;

  const stdioConfig = {
    mcpServers: {
      [`casefile-${slug}`]: {
        command: "npx",
        args: ["-y", "tsx", resolve(repoRoot, "packages/mcp/src/cli.ts").replace(/\\/g, "/")],
        env: {
          DATABASE_URL: dbUrl,
          MATTER_TENANT_ID: tenantId,
          MATTER_INVESTIGATION_ID: investigationId,
          // D77: the stdio server runs as this real user and refuses to start without one.
          MCP_LOCAL_USER_ID: env["MCP_LOCAL_USER_ID"] || "<YOUR_CASEFILE_USER_ID>",
        },
      },
    },
  };

  const remoteConfig = {
    mcpServers: {
      [`casefile-${slug}`]: {
        url: mcpUrl,
      },
    },
  };

  const combinedConfig = {
    mcpServers: {
      [`casefile-${slug}-stdio`]: stdioConfig.mcpServers[`casefile-${slug}`],
      [`casefile-${slug}-remote`]: remoteConfig.mcpServers[`casefile-${slug}`],
    },
  };

  console.log("================================================================================");
  console.log(`CLAUDE DESKTOP MCP CONFIGURATION FOR: ${matterConfig.matterName}`);
  console.log("================================================================================");
  console.log("\nOption 1: Local Stdio Transport (Direct DB via CLI)");
  console.log("Paste into %APPDATA%\\Claude\\claude_desktop_config.json (Windows) or");
  console.log("~/Library/Application Support/Claude/claude_desktop_config.json (macOS):\n");
  console.log(JSON.stringify(stdioConfig, null, 2));

  console.log("\n--------------------------------------------------------------------------------");
  console.log("\nOption 2: Remote HTTPS Transport (Deployed Cloud Run Service)");
  console.log("For remote MCP clients connecting over HTTPS (Claude asks you to sign in on first use):\n");
  console.log(JSON.stringify(remoteConfig, null, 2));
  console.log("================================================================================");

  return combinedConfig;
}

export { main as buildMcpConfig };

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename || "")) {
  main();
}
