import { signJwt } from "../../apps/api/src/auth/crypto.js";

const baseUrl = process.env.CASEFILE_API_URL || "http://127.0.0.1:3000";
const tenantId = process.env.MATTER_TENANT_ID || "00000000-0000-0000-0000-000000000000";
const userId = process.env.MATTER_USER_ID || "00000000-0000-0000-0000-000000000001";
const invId = process.env.MATTER_INVESTIGATION_ID || "00000000-0000-0000-0000-000000000002";

async function run() {
  const token = signJwt({
    sub: userId,
    tid: tenantId,
    sid: "00000000-0000-0000-0000-000000000001",
    roles: ["ws_admin", "lead_inv"],
    mfa: true,
  });

  const res = await fetch(`${baseUrl}/v1/investigations/${invId}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ query: "investigation" }),
  });
  console.log("Search HTTP Status:", res.status);
  const data = await res.json();
  console.log("RESPONSE_JSON_START");
  console.log(JSON.stringify(data, null, 2));
  console.log("RESPONSE_JSON_END");
}

run().catch((e) => console.error(e));
