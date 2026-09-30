import { readFileSync, existsSync } from "node:fs";

const envText = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const tokenMatch = envText.match(/MCP_TOKEN=(.+)/);
const token = tokenMatch?.[1]?.trim() || process.env.MCP_TOKEN || "";
const invMatch = envText.match(/MATTER_INVESTIGATION_ID=(.+)/);
const invId = invMatch?.[1]?.trim() || process.env.MATTER_INVESTIGATION_ID || "";
const baseUrl = process.env.CASEFILE_API_URL || "http://127.0.0.1:3000";


interface McpRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    serverInfo?: { name: string; version: string };
    protocolVersion?: string;
  };
  error?: { code: number; message: string };
}

async function testLiveMcp() {
  console.log("=== Testing Live MCP Over HTTPS ===");

  // 1. initialize
  const initRes = await fetch(`${baseUrl}/mcp/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  console.log(`1. initialize -> HTTP ${initRes.status}`);
  console.log(await initRes.json());

  // 2. tools/list
  const listRes = await fetch(`${baseUrl}/mcp/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  console.log(`\n2. tools/list -> HTTP ${listRes.status}`);
  const listData = (await listRes.json()) as McpRpcResponse;
  const tools = listData.result?.tools || [];
  console.log(`Registered Tools (${tools.length}):`, tools.map((t) => t.name));

  // 3. tools/call -> matter_status
  const statusRes = await fetch(`${baseUrl}/mcp/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-casefile-investigation-id": invId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "matter_status", arguments: {} },
    }),
  });
  console.log(`\n3. tools/call (matter_status) -> HTTP ${statusRes.status}`);
  const statusData = (await statusRes.json()) as McpRpcResponse;
  console.log(statusData.result?.content?.[0]?.text);

  // 4. tools/call -> search
  const searchRes = await fetch(`${baseUrl}/mcp/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-casefile-investigation-id": invId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search", arguments: { query: "investigation" } },
    }),
  });
  console.log(`\n4. tools/call (search) -> HTTP ${searchRes.status}`);
  const searchData = (await searchRes.json()) as McpRpcResponse;
  console.log(searchData.result?.content?.[0]?.text);
}

testLiveMcp();
