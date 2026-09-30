export {};

const baseUrl = process.env.CASEFILE_API_URL || "http://127.0.0.1:3000";

interface RouteCheck {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  expectedType: "Public" | "Authenticated";
}

const routes: RouteCheck[] = [
  // Public Health endpoints
  { method: "GET", path: "/health", expectedType: "Public" },
  { method: "GET", path: "/ready", expectedType: "Public" },
  { method: "GET", path: "/healthz", expectedType: "Public" },
  { method: "GET", path: "/healthz/", expectedType: "Public" },
  // Public Auth endpoints (called without token)
  { method: "POST", path: "/v1/auth/register", body: {}, expectedType: "Public" },
  { method: "POST", path: "/v1/auth/token", body: {}, expectedType: "Public" },
  { method: "POST", path: "/v1/auth/mfa/verify", body: {}, expectedType: "Public" },
  { method: "POST", path: "/v1/auth/refresh", body: {}, expectedType: "Public" },
  { method: "POST", path: "/v1/auth/password-reset/request", body: {}, expectedType: "Public" },
  { method: "POST", path: "/v1/auth/password-reset/confirm", body: {}, expectedType: "Public" },
  { method: "POST", path: "/v1/auth/webauthn/authenticate/options", body: {}, expectedType: "Public" },
  { method: "POST", path: "/v1/auth/webauthn/authenticate/verify", body: {}, expectedType: "Public" },
  // Authenticated endpoints (called without Authorization header)
  { method: "GET", path: "/v1/me", expectedType: "Authenticated" },
  { method: "GET", path: "/v1/investigations", expectedType: "Authenticated" },
  { method: "GET", path: "/v1/workspaces", expectedType: "Authenticated" },
  { method: "GET", path: "/v1/audit/events", expectedType: "Authenticated" },
];

async function run() {
  console.log("| Method | Route Path | Status Code | Classification | Live Probe Result |");
  console.log("|---|---|---|---|---|");
  for (const r of routes) {
    const opts: RequestInit = {
      method: r.method,
      headers: r.body ? { "content-type": "application/json" } : {},
      ...(r.body ? { body: JSON.stringify(r.body) } : {}),
    };
    try {
      const res = await fetch(`${baseUrl}${r.path}`, opts);
      let resultDesc = "";
      if (r.expectedType === "Authenticated") {
        if (res.status === 401) {
          resultDesc = "401 Unauthorized (Protected)";
        } else {
          resultDesc = `FAILED! Live data exposed with status ${res.status}`;
        }
      } else {
        if (res.status === 200) {
          resultDesc = "200 OK (Unauthenticated Access)";
        } else if (res.status === 400) {
          resultDesc = "400 Validation Error (Route reachable without auth)";
        } else {
          resultDesc = `${res.status} ${res.statusText}`;
        }
      }
      console.log(`| ${r.method} | ${r.path} | ${res.status} | ${r.expectedType} | ${resultDesc} |`);
    } catch (err) {
      console.log(`| ${r.method} | ${r.path} | ERROR | ${r.expectedType} | ${err instanceof Error ? err.message : String(err)} |`);
    }
  }
}

run();
