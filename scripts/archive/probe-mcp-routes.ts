export {};

const baseUrl = process.env.CASEFILE_API_URL || "http://127.0.0.1:3000";

async function probe() {
  console.log("Probing Live Cloud Run MCP Endpoints:");
  for (const path of ["/mcp", "/mcp/"]) {
    try {
      const res = await fetch(baseUrl + path);
      console.log(`GET ${path} -> HTTP ${res.status} (${res.statusText})`);
      if (res.status === 200) {
        const data = await res.json();
        console.log(`Response:`, data);
      }
    } catch (err) {
      console.error(`GET ${path} failed:`, err);
    }
  }
}

probe();
