import fs from "node:fs";

const envText = fs.readFileSync(".env", "utf8");
const tokenMatch = envText.match(/(?:MCP_TOKEN|CASEFILE_TOKEN)=(.+)/);
const invIdMatch = envText.match(/(?:MATTER_INVESTIGATION_ID|CASEFILE_INVESTIGATION_ID)=(.+)/);

if (!tokenMatch || !invIdMatch) {
  throw new Error("Missing MCP_TOKEN/CASEFILE_TOKEN or MATTER_INVESTIGATION_ID/CASEFILE_INVESTIGATION_ID in .env");
}

const token = tokenMatch[1]!.trim();
const invId = invIdMatch[1]!.trim();
const baseUrl = process.env.CASEFILE_API_URL || "http://127.0.0.1:3000";

async function main() {
  const res = await fetch(`${baseUrl}/v1/investigations/${invId}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ query: "investigation" }),
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("RESPONSE_JSON_START");
  console.log(JSON.stringify(data, null, 2));
  console.log("RESPONSE_JSON_END");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
