import fs from "node:fs";
import path from "node:path";

async function main() {
  const envPath = path.resolve(process.cwd(), ".env");
  const envContent = fs.readFileSync(envPath, "utf8");
  const newTokenMatch = envContent.match(/MCP_TOKEN=(.+)/);
  const newToken = newTokenMatch && newTokenMatch[1] ? newTokenMatch[1].trim() : "";
  const oldToken = process.argv[2] || "mcp_sec_compromised_old_token_revoked";
  const baseUrl = process.env.CASEFILE_API_URL || "http://127.0.0.1:3000";

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };

  console.log("=== Probe 1: OLD Compromised Token ===");
  console.log(`Token: ${oldToken.slice(0, 8)}…`);
  const resOld = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${oldToken}`,
    },
    body: JSON.stringify(payload),
  });
  console.log("HTTP Status:", resOld.status, resOld.statusText);
  const dataOld = await resOld.json().catch(() => null);
  console.log(JSON.stringify(dataOld, null, 2));

  console.log("\n=== Probe 2: NEW Rotated Token ===");
  console.log(`Token: ${newToken.slice(0, 8)}…`);
  const resNew = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${newToken}`,
    },
    body: JSON.stringify(payload),
  });
  console.log("HTTP Status:", resNew.status, resNew.statusText);
  const dataNew = await resNew.json().catch(() => null);
  console.log(JSON.stringify(dataNew, null, 2));
}

main();
