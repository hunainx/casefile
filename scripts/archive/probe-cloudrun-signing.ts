import fs from "node:fs";

const envContent = fs.readFileSync(".env", "utf8");
let mcpToken = "";
let baseUrl = process.env.CASEFILE_API_URL || "";
for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed.startsWith("MCP_TOKEN=")) {
    mcpToken = trimmed.slice("MCP_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
  }
  if (!baseUrl && trimmed.startsWith("CASEFILE_API_URL=")) {
    baseUrl = trimmed.slice("CASEFILE_API_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
}

async function probeCloudRun() {
  console.log("=== 1. Calling matter_status on Cloud Run ===");
  const statusRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "matter_status", arguments: {} },
    }),
  });
  console.log("matter_status HTTP:", statusRes.status);
  const statusData = await statusRes.json();
  console.log("matter_status response:", JSON.stringify(statusData, null, 2));

  console.log("\n=== 2. Calling list_documents on Cloud Run ===");
  const docsRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_documents", arguments: {} },
    }),
  });
  console.log("list_documents HTTP:", docsRes.status);
  const docsData = (await docsRes.json()) as { result?: { content?: { text?: string }[] } };
  console.log("list_documents response:", JSON.stringify(docsData, null, 2));

  let docId = "";
  if (docsData.result?.content?.[0]?.text) {
    try {
      const parsed = JSON.parse(docsData.result.content[0].text) as { documents?: { id: string }[] };
      if (parsed.documents && parsed.documents.length > 0 && parsed.documents[0]) {
        docId = parsed.documents[0].id;
      }
    } catch {
      // Ignored non-json text
    }
  }

  if (!docId) {
    console.log("No document found, using dummy UUID for probe");
    docId = "00000000-0000-0000-0000-000000000001";
  }

  console.log(`\n=== 3. Calling get_download_link for docId=${docId} on Cloud Run ===`);
  const dlRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_download_link", arguments: { document_id: docId } },
    }),
  });
  console.log("get_download_link HTTP:", dlRes.status);
  const dlData = (await dlRes.json()) as { result?: { content?: { text?: string }[] } };
  console.log("get_download_link response:", JSON.stringify(dlData, null, 2));

  if (dlData.result?.content?.[0]?.text) {
    try {
      const parsed = JSON.parse(dlData.result.content[0].text) as { download_url?: string };
      if (parsed.download_url) {
        const fetchUrl = parsed.download_url;
        console.log("\n=== 4. Fetching Download URL directly ===");
        const fRes = await fetch(fetchUrl);
        console.log("Direct Fetch HTTP Status:", fRes.status);
      }
    } catch {
      // Ignored non-json text
    }
  }
}

probeCloudRun();
