import fs from "node:fs";
import path from "node:path";

async function main() {
  const baseUrl = process.env.CASEFILE_API_URL || "http://127.0.0.1:3000";
  const envPath = path.resolve(process.cwd(), ".env");
  const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const match = envContent.match(/MCP_TOKEN=(.+)/);
  const validToken = match && match[1] ? match[1].trim() : process.env.MCP_TOKEN || "";
  const wrongToken = "mcp_sec_wrong_invalid_secret_token_123";

  const listPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };

  console.log("================================================================================");
  console.log("PROBING LIVE CLOUD RUN MCP SERVER: " + baseUrl);
  console.log("================================================================================");

  // ── Probe 1: Valid MCP_TOKEN ──────────────────────────────────────────────
  console.log("\n1. Probe with VALID MCP_TOKEN (Authorization: Bearer <valid_token>):");
  try {
    const res1 = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + validToken,
      },
      body: JSON.stringify(listPayload),
    });
    console.log("Status Code:", res1.status, res1.statusText);
    const data1 = await res1.json();
    console.log("Response Body:\n" + JSON.stringify(data1, null, 2));
  } catch (err) {
    console.error("Probe 1 Error:", err);
  }

  // ── Probe 2: No Authorization Header ──────────────────────────────────────
  console.log("\n--------------------------------------------------------------------------------");
  console.log("2. Probe with NO Authorization header:");
  try {
    const res2 = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(listPayload),
    });
    console.log("Status Code:", res2.status, res2.statusText);
    const data2 = await res2.json().catch(() => null);
    console.log("Response Body:\n" + JSON.stringify(data2, null, 2));
  } catch (err) {
    console.error("Probe 2 Error:", err);
  }

  // ── Probe 3: Wrong Token ──────────────────────────────────────────────────
  console.log("\n--------------------------------------------------------------------------------");
  console.log("3. Probe with WRONG MCP_TOKEN (Authorization: Bearer <wrong_token>):");
  try {
    const res3 = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + wrongToken,
      },
      body: JSON.stringify(listPayload),
    });
    console.log("Status Code:", res3.status, res3.statusText);
    const data3 = await res3.json().catch(() => null);
    console.log("Response Body:\n" + JSON.stringify(data3, null, 2));
  } catch (err) {
    console.error("Probe 3 Error:", err);
  }
  console.log("================================================================================");
}

main();
