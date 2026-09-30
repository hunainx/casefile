import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { generateTotp, generateTotpSecret, hashPassword } from "../src/auth/crypto.js";
import { nextTotpCode } from "./helpers/totp.js";
import type { CimdTransport } from "../src/oauth/cimd.js";

/**
 * MCP sign-in Phase 2A (D69, D70): Casefile as its own OAuth 2.1 authorization server.
 * Covers docs/PLAN-MCP-AUTH.md section 7 (OAuth flow and CIMD), the sign-in refusals, and one
 * end-to-end run that behaves like Claude Code. /mcp itself is not touched in 2A.
 */

const RESOURCE = "https://mcp.casefile.test/mcp"; // MCP_PUBLIC_URL in vitest.integration.config.ts
const ISSUER = "https://mcp.casefile.test";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const HOSTED = "https://client.casefile.test/cimd.json";
const HOSTED_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PUBLIC_IP = "93.184.215.14";

// ── Fake CIMD network (passed in code, never via env) ─────────────────────────────────────
type FakeDoc = { status?: number; headers?: Record<string, string>; body: string | Buffer; delayMs?: number };
const dns: Record<string, string[]> = {
  "claude.ai": [PUBLIC_IP],
  "client.casefile.test": [PUBLIC_IP],
  "mismatch.casefile.test": [PUBLIC_IP],
  "nostore.casefile.test": [PUBLIC_IP],
  "slow.casefile.test": [PUBLIC_IP],
  "big.casefile.test": [PUBLIC_IP],
  "private.casefile.test": ["10.0.0.5"],
  "mixed.casefile.test": [PUBLIC_IP, "127.0.0.1"],
  "linklocal.casefile.test": ["169.254.169.254"],
  "v6local.casefile.test": ["fd00::1"],
};
const json = (o: unknown) => JSON.stringify(o);
const docs: Record<string, FakeDoc> = {
  // Byte-for-byte shape of Claude Code's published document (fetched 2026-09-26).
  [CLAUDE_CODE]: {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    body: json({
      client_id: CLAUDE_CODE,
      client_name: "Claude Code",
      client_uri: "https://claude.ai",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  },
  [HOSTED]: {
    headers: { "content-type": "application/json" },
    body: json({
      client_id: HOSTED,
      client_name: "Totally Trustworthy Client",
      redirect_uris: [HOSTED_CALLBACK, "https://evil.casefile.test/callback"],
      token_endpoint_auth_method: "none",
    }),
  },
  "https://mismatch.casefile.test/cimd.json": {
    headers: { "content-type": "application/json" },
    body: json({ client_id: "https://someone-else.casefile.test/cimd.json", client_name: "x", redirect_uris: [HOSTED_CALLBACK] }),
  },
  "https://nostore.casefile.test/cimd.json": {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: json({ client_id: "https://nostore.casefile.test/cimd.json", client_name: "x", redirect_uris: [HOSTED_CALLBACK] }),
  },
  "https://slow.casefile.test/cimd.json": {
    delayMs: 400,
    headers: { "content-type": "application/json" },
    body: json({ client_id: "https://slow.casefile.test/cimd.json", client_name: "x", redirect_uris: [HOSTED_CALLBACK] }),
  },
  "https://big.casefile.test/cimd.json": {
    headers: { "content-type": "application/json" },
    body: json({ client_id: "https://big.casefile.test/cimd.json", client_name: "x".repeat(70_000), redirect_uris: [HOSTED_CALLBACK] }),
  },
};
const fetches: string[] = [];
const fakeTransport: CimdTransport = {
  async resolve(hostname) {
    return dns[hostname] ?? [];
  },
  async get(url, address) {
    fetches.push(`${url.href} @ ${address}`);
    const doc = docs[url.href];
    if (!doc) return { status: 404, headers: {}, body: Buffer.from("") };
    if (doc.delayMs) await new Promise((r) => setTimeout(r, doc.delayMs));
    return { status: doc.status ?? 200, headers: doc.headers ?? {}, body: Buffer.isBuffer(doc.body) ? doc.body : Buffer.from(doc.body) };
  },
};

const TRUSTED = [
  CLAUDE_CODE,
  HOSTED,
  "https://mismatch.casefile.test/cimd.json",
  "https://nostore.casefile.test/cimd.json",
  "https://slow.casefile.test/cimd.json",
  "https://big.casefile.test/cimd.json",
  "https://private.casefile.test/cimd.json",
  "https://mixed.casefile.test/cimd.json",
  "https://linklocal.casefile.test/cimd.json",
  "https://v6local.casefile.test/cimd.json",
  "https://10.1.2.3/cimd.json",
];

// ── Helpers ───────────────────────────────────────────────────────────────────────────────
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function hiddenValue(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no hidden field ${name} in:\n${html}`);
  return m[1]!;
}

function csrfCookie(setCookie: string | string[] | undefined): string {
  const all = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const c = all.map((s) => /__Host-cf_csrf=([^;]+)/.exec(s)?.[1]).find(Boolean);
  if (!c) throw new Error(`no csrf cookie in ${JSON.stringify(setCookie)}`);
  return c;
}

interface Person {
  id: string;
  email: string;
  password: string;
  secret: string;
}

describe("OAuth 2.1 authorization server for /mcp (Phase 2A)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  const T = randomUUID();
  const WS = randomUUID();
  const OTHER_WS = randomUUID();
  const INV = randomUUID();
  const people: Record<string, Person> = {};
  const savedEnv: Record<string, string | undefined> = {};

  async function addPerson(key: string, opts: { wsRole?: string; ws?: string; invRole?: string; totp?: boolean; status?: string; wall?: boolean } = {}) {
    const p: Person = { id: randomUUID(), email: `${key}-${randomUUID().slice(0, 8)}@casefile.test`, password: `Pw-${key}-Casefile-2026!`, secret: generateTotpSecret() };
    const hash = await hashPassword(p.password);
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO users (id, tenant_id, email, name, status) VALUES (${p.id}, ${T}, ${p.email}, ${key}, ${opts.status ?? "active"})`;
      await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash, totp_secret, totp_enabled)
               VALUES (${p.id}, ${T}, ${hash}, ${opts.totp === false ? null : p.secret}, ${opts.totp !== false})`;
      if (opts.wsRole) {
        await tx`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (${randomUUID()}, ${T}, ${opts.ws ?? WS}, ${p.id}, ${opts.wsRole})`;
      }
      if (opts.invRole) {
        await tx`INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role) VALUES (${randomUUID()}, ${T}, ${INV}, ${p.id}, ${opts.invRole})`;
      }
      if (opts.wall) {
        await tx`INSERT INTO ethical_walls (id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason)
                 VALUES (${randomUUID()}, ${T}, ${WS}, 'user', ${p.id}, ${INV}, 'Conflict of interest (test)')`;
      }
    }, sql);
    people[key] = p;
    return p;
  }

  /**
   * A lead investigator like alice, new for each sign-in that goes through TOTP: a code is
   * accepted once per account (D75), and these tests sign in many times a second.
   */
  let aliceCount = 0;
  function freshAlice(): Promise<Person> {
    aliceCount += 1;
    return addPerson(`alice${aliceCount}`, { wsRole: "investigator", invRole: "lead_investigator" });
  }

  async function authorizeGet(params: Record<string, string | undefined>) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
    return app.inject({ method: "GET", url: `/oauth/authorize?${q.toString()}` });
  }

  function claudeCodeParams(overrides: Record<string, string | undefined> = {}) {
    const { verifier, challenge } = pkce();
    const params: Record<string, string | undefined> = {
      response_type: "code",
      client_id: CLAUDE_CODE,
      redirect_uri: "http://localhost:53123/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "casefile.read offline_access",
      state: `state-${randomUUID()}`,
      ...overrides,
    };
    return { params, verifier };
  }

  /** GET the page, then POST password; returns what the next step needs. */
  async function startSignIn(person: Person, overrides: Record<string, string | undefined> = {}) {
    const { params, verifier } = claudeCodeParams(overrides);
    const page = await authorizeGet(params);
    expect(page.statusCode, page.body).toBe(200);
    const cookie = csrfCookie(page.headers["set-cookie"]);
    const csrf = hiddenValue(page.body, "csrf");
    const res = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` },
      payload: form({ flow: hiddenValue(page.body, "flow"), csrf, email: person.email, password: person.password }),
    });
    return { res, cookie, csrf, params, verifier };
  }

  async function postForm(cookie: string, fields: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` },
      payload: form(fields),
    });
  }

  /** Password + TOTP; returns the response after the TOTP step (consent page or refusal). */
  async function signInThroughTotp(person: Person, overrides: Record<string, string | undefined> = {}) {
    const s = await startSignIn(person, overrides);
    expect(s.res.statusCode, s.res.body).toBe(200);
    const totp = await postForm(s.cookie, { flow: hiddenValue(s.res.body, "flow"), csrf: s.csrf, email: person.email, code: await nextTotpCode(person.secret) });
    return { ...s, res: totp };
  }

  /** Full sign-in with consent; returns the callback URL parameters and the PKCE verifier. */
  async function getCode(person: Person, overrides: Record<string, string | undefined> = {}) {
    const s = await signInThroughTotp(person, overrides);
    expect(s.res.statusCode, s.res.body).toBe(200);
    const approve = await postForm(s.cookie, { flow: hiddenValue(s.res.body, "flow"), csrf: s.csrf, decision: "approve" });
    expect(approve.statusCode, approve.body).toBe(302);
    const location = new URL(String(approve.headers.location));
    return { location, code: location.searchParams.get("code")!, verifier: s.verifier, params: s.params };
  }

  async function token(fields: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form(fields),
    });
  }

  function exchange(code: string, verifier: string, redirectUri = "http://localhost:53123/callback", extra: Record<string, string> = {}) {
    return token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLAUDE_CODE, redirect_uri: redirectUri, resource: RESOURCE, ...extra });
  }

  function jwtClaims(t: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString("utf8"));
  }

  beforeAll(async () => {
    for (const k of ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID", "MCP_OAUTH_TRUSTED_CLIENTS"]) savedEnv[k] = process.env[k];
    process.env.MATTER_TENANT_ID = T;
    process.env.MATTER_INVESTIGATION_ID = INV;
    process.env.MCP_OAUTH_TRUSTED_CLIENTS = TRUSTED.join(",");
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql, oauth: { cimdTransport: fakeTransport, cimdTimeoutMs: 150 } });
    await app.ready();

    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'OAuth Test Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Matter WS')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${OTHER_WS}, ${T}, 'Other WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage) VALUES (${INV}, ${T}, ${WS}, 'OAuth Case', 'Sign-in tests', 'collecting')`;
    }, sql);
    await addPerson("alice", { wsRole: "investigator", invRole: "lead_investigator" });
    await addPerson("carol", { wsRole: "investigator" });
    await addPerson("nototp", { wsRole: "investigator", totp: false });
    await addPerson("viewer", { wsRole: "viewer" });
    await addPerson("auditor", { wsRole: "auditor" });
    await addPerson("orgadmin", { wsRole: "org_admin" });
    await addPerson("outsider", { wsRole: "investigator", ws: OTHER_WS });
    await addPerson("walled", { wsRole: "investigator", wall: true });
    await addPerson("inactive", { wsRole: "investigator", status: "suspended" });
    await addPerson("locky", { wsRole: "investigator" });
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("discovery", () => {
    it("serves protected resource metadata at both well-known paths (RFC 9728)", async () => {
      for (const url of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({
          resource: RESOURCE,
          authorization_servers: [ISSUER],
          scopes_supported: ["casefile.read"],
          bearer_methods_supported: ["header"],
        });
      }
    });

    it("serves authorization server metadata with the plan's exact fields (RFC 8414)", async () => {
      const res = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true,
        scopes_supported: ["casefile.read", "offline_access"],
        authorization_response_iss_parameter_supported: true,
      });
    });
  });

  describe("client identification (CIMD only)", () => {
    const refusedWithoutRedirect = async (clientId: string | undefined, why: RegExp) => {
      const { params } = claudeCodeParams({ client_id: clientId, redirect_uri: HOSTED_CALLBACK });
      const res = await authorizeGet(params);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.body).toMatch(why);
    };

    it("refuses a missing client_id with an error page, never a redirect", () => refusedWithoutRedirect(undefined, /client_id is missing/));
    it("refuses a client_id that is not on the allowlist", () => refusedWithoutRedirect("https://unlisted.casefile.test/cimd.json", /not on the trusted client list/));
    it("refuses a non-HTTPS client_id", () => refusedWithoutRedirect("http://client.casefile.test/cimd.json", /must use https/));
    it("refuses a document whose client_id does not match its URL", () =>
      refusedWithoutRedirect("https://mismatch.casefile.test/cimd.json", /client_id does not match its URL/));
    it("refuses a host that resolves to a private address", () =>
      refusedWithoutRedirect("https://private.casefile.test/cimd.json", /non-public address \(10\.0\.0\.5\)/));
    it("refuses a host that resolves to a mix of public and loopback addresses", () =>
      refusedWithoutRedirect("https://mixed.casefile.test/cimd.json", /non-public address \(127\.0\.0\.1\)/));
    it("refuses link-local (cloud metadata) and IPv6 unique-local addresses", async () => {
      await refusedWithoutRedirect("https://linklocal.casefile.test/cimd.json", /169\.254\.169\.254/);
      await refusedWithoutRedirect("https://v6local.casefile.test/cimd.json", /fd00::1/);
    });
    it("refuses a client_id URL that is a private IP literal, without any DNS lookup", () =>
      refusedWithoutRedirect("https://10.1.2.3/cimd.json", /non-public address \(10\.1\.2\.3\)/));
    it("gives up on a document that does not arrive within the timeout", () =>
      refusedWithoutRedirect("https://slow.casefile.test/cimd.json", /timed out/));
    it("refuses a document larger than the size cap", () => refusedWithoutRedirect("https://big.casefile.test/cimd.json", /larger than 65536 bytes/));

    it("caches a document for its max-age and refetches a no-store document every time", async () => {
      const count = (u: string) => fetches.filter((f) => f.startsWith(u)).length;
      const before = count(CLAUDE_CODE);
      await authorizeGet(claudeCodeParams().params);
      await authorizeGet(claudeCodeParams().params);
      expect(count(CLAUDE_CODE) - before).toBeLessThanOrEqual(1);

      const nostore = "https://nostore.casefile.test/cimd.json";
      const n0 = count(nostore);
      await authorizeGet(claudeCodeParams({ client_id: nostore, redirect_uri: HOSTED_CALLBACK }).params);
      await authorizeGet(claudeCodeParams({ client_id: nostore, redirect_uri: HOSTED_CALLBACK }).params);
      expect(count(nostore) - n0).toBe(2);
    });

    it("connects to the address it checked", async () => {
      await authorizeGet(claudeCodeParams({ client_id: HOSTED, redirect_uri: HOSTED_CALLBACK }).params);
      expect(fetches.some((f) => f === `${HOSTED} @ ${PUBLIC_IP}`)).toBe(true);
    });
  });

  describe("redirect URIs", () => {
    it("never redirects to a URI the server does not allow, even if the client's document lists it", async () => {
      const res = await authorizeGet(claudeCodeParams({ client_id: HOSTED, redirect_uri: "https://evil.casefile.test/callback" }).params);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.body).toMatch(/not allowed/);
    });

    it("never redirects to a URI missing from the client's document", async () => {
      const res = await authorizeGet(claudeCodeParams({ redirect_uri: HOSTED_CALLBACK }).params);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it("accepts the hosted callback for a client that lists it", async () => {
      const res = await authorizeGet(claudeCodeParams({ client_id: HOSTED, redirect_uri: HOSTED_CALLBACK }).params);
      expect(res.statusCode, res.body).toBe(200);
    });

    it("accepts Claude Code's loopback redirect on any port, for localhost and 127.0.0.1", async () => {
      for (const uri of ["http://localhost:1/callback", "http://localhost:65535/callback", "http://127.0.0.1:40123/callback", "http://localhost/callback"]) {
        const res = await authorizeGet(claudeCodeParams({ redirect_uri: uri }).params);
        expect(res.statusCode, `${uri}\n${res.body}`).toBe(200);
      }
    });

    it("refuses a loopback redirect with a different path, host or scheme", async () => {
      for (const uri of ["http://localhost:5000/other", "http://127.0.0.2:5000/callback", "https://localhost:5000/callback", "http://localhost:5000/callback#x"]) {
        const res = await authorizeGet(claudeCodeParams({ redirect_uri: uri }).params);
        expect(res.statusCode, uri).toBe(400);
        expect(res.headers.location).toBeUndefined();
      }
    });
  });

  describe("authorization request errors go back to the client with state and iss", () => {
    const expectBack = async (overrides: Record<string, string | undefined>, error: string) => {
      const { params } = claudeCodeParams(overrides);
      const res = await authorizeGet(params);
      expect(res.statusCode, res.body).toBe(302);
      const loc = new URL(String(res.headers.location));
      expect(`${loc.origin}${loc.pathname}`).toBe("http://localhost:53123/callback");
      expect(loc.searchParams.get("error")).toBe(error);
      expect(loc.searchParams.get("state")).toBe(params.state);
      expect(loc.searchParams.get("iss")).toBe(ISSUER);
      expect(loc.searchParams.get("code")).toBeNull();
    };

    it("refuses plain PKCE", () => expectBack({ code_challenge_method: "plain" }, "invalid_request"));
    it("refuses a request without PKCE", () => expectBack({ code_challenge: undefined, code_challenge_method: undefined }, "invalid_request"));
    it("refuses a missing resource", () => expectBack({ resource: undefined }, "invalid_target"));
    it("refuses a wrong resource", () => expectBack({ resource: "https://mcp.casefile.test/other" }, "invalid_target"));
    it("refuses a resource with a trailing slash", () => expectBack({ resource: `${RESOURCE}/` }, "invalid_target"));
    it("refuses an unknown scope", () => expectBack({ scope: "casefile.read casefile.write" }, "invalid_scope"));
    it("refuses a response_type other than code", () => expectBack({ response_type: "token" }, "unsupported_response_type"));

    it("accepts a resource whose scheme and host differ only in case (canonical compare)", async () => {
      const res = await authorizeGet(claudeCodeParams({ resource: "HTTPS://MCP.Casefile.Test/mcp" }).params);
      expect(res.statusCode, res.body).toBe(200);
    });

    it("refuses a parameter given twice", async () => {
      const { params } = claudeCodeParams();
      const q = new URLSearchParams(params as Record<string, string>).toString();
      const res = await app.inject({ method: "GET", url: `/oauth/authorize?${q}&state=second` });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });
  });

  describe("the sign-in page", () => {
    it("is locked down: strict CSP, no framing, no caching, host-only CSRF cookie, nothing external", async () => {
      const res = await authorizeGet(claudeCodeParams().params);
      expect(res.statusCode).toBe(200);
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toMatch(/default-src 'none'/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
      expect(csp).toMatch(/script-src 'none'/);
      expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9_-]+'/);
      expect(csp).toMatch(/form-action 'self'/);
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      const cookie = String(res.headers["set-cookie"]);
      expect(cookie).toMatch(/^__Host-cf_csrf=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict/);
      expect(res.body).not.toMatch(/<script|<link|@import|https?:\/\/(?!claude\.ai)/i);
      expect(res.body).not.toMatch(/tenant/i);
    });

    it("refuses a form post without the CSRF cookie, with a wrong CSRF value, or with a tampered flow", async () => {
      const page = await authorizeGet(claudeCodeParams().params);
      const cookie = csrfCookie(page.headers["set-cookie"]);
      const flow = hiddenValue(page.body, "flow");
      const csrf = hiddenValue(page.body, "csrf");
      const fields = { flow, csrf, email: people.alice!.email, password: people.alice!.password };

      const noCookie = await app.inject({ method: "POST", url: "/oauth/authorize", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: form(fields) });
      expect(noCookie.statusCode).toBe(403);
      const wrongCsrf = await postForm(cookie, { ...fields, csrf: "not-the-cookie" });
      expect(wrongCsrf.statusCode).toBe(403);
      const tampered = await postForm(cookie, { ...fields, flow: flow.replace(/\.[^.]+$/, ".AAAA") });
      expect(tampered.statusCode).toBe(403);
      const otherBrowser = await postForm(randomBytes(32).toString("base64url"), { ...fields, csrf: "x" });
      expect(otherBrowser.statusCode).toBe(403);
    });

    it("says only 'incorrect' for a wrong password, and issues nothing", async () => {
      const s = await startSignIn({ ...people.carol!, password: "wrong-password-123" });
      expect(s.res.statusCode).toBe(401);
      expect(s.res.body).toMatch(/Incorrect email or password/);
      expect(s.res.headers.location).toBeUndefined();
    });

    it("applies the existing account lockout", async () => {
      for (let i = 0; i < 5; i++) await startSignIn({ ...people.locky!, password: `wrong-${i}` });
      const s = await startSignIn(people.locky!);
      expect(s.res.statusCode).toBe(429);
      expect(s.res.body).toMatch(/locked/i);
    });

    it("signs in only users of MATTER_TENANT_ID", async () => {
      const otherTenant = randomUUID();
      const email = `other-tenant-${randomUUID().slice(0, 8)}@casefile.test`;
      const password = "Other-Tenant-Password-1!";
      await withTenant(otherTenant, async (tx) => {
        await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${otherTenant}, ${otherTenant}, 'Another matter')`;
        const uid = randomUUID();
        await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${uid}, ${otherTenant}, ${email}, 'Other')`;
        await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash, totp_secret, totp_enabled) VALUES (${uid}, ${otherTenant}, ${await hashPassword(password)}, ${generateTotpSecret()}, true)`;
      }, sql);
      const s = await startSignIn({ id: "", email, password, secret: "" });
      expect(s.res.statusCode).toBe(401);
      expect(s.res.body).toMatch(/Incorrect email or password/);
    });

    it("rejects a wrong TOTP code and asks again", async () => {
      const s = await startSignIn(people.alice!);
      const wrong = await postForm(s.cookie, { flow: hiddenValue(s.res.body, "flow"), csrf: s.csrf, email: people.alice!.email, code: "000000" === generateTotp(people.alice!.secret) ? "111111" : "000000" });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.body).toMatch(/not valid/);
    });
  });

  describe("refusals: a clear message and no token", () => {
    const expectRefused = async (key: string, message: RegExp, viaTotp = true) => {
      const person = people[key]!;
      const s = viaTotp ? await signInThroughTotp(person) : await startSignIn(person);
      expect(s.res.statusCode, s.res.body).toBe(403);
      expect(s.res.body).toMatch(message);
      expect(s.res.body).toMatch(/no token was issued/);
      expect(s.res.headers.location).toBeUndefined();
      const codes = await withTenant(T, (tx) => tx`SELECT id FROM oauth_authorization_codes WHERE user_id = ${person.id}`, sql);
      expect(codes).toHaveLength(0);
      const audit = await withTenant(T, (tx) => tx<{ denial_reason: string }[]>`
        SELECT denial_reason FROM audit_events WHERE tenant_id = ${T} AND action = 'auth.oauth_signin_refused' AND actor_id = ${person.id}`, sql);
      expect(audit.length).toBeGreaterThan(0);
    };

    it("a user without TOTP", () => expectRefused("nototp", /Two-step verification is not set up/, false));
    it("a viewer", () => expectRefused("viewer", /role on this matter \(viewer\)/));
    it("an auditor", () => expectRefused("auditor", /role on this matter \(auditor\)/));
    it("an org_admin", () => expectRefused("orgadmin", /role on this matter \(org_admin\)/));
    it("a user who is not a member of the matter's workspace", () => expectRefused("outsider", /not a member of the workspace/));
    it("a user behind an ethical wall", () => expectRefused("walled", /ethical wall/));
    it("a deactivated user: told only 'incorrect email or password' at the password step (D80), and no code", async () => {
      const person = people.inactive!;
      const s = await startSignIn(person);
      expect(s.res.statusCode, s.res.body).toBe(401);
      expect(s.res.body).toMatch(/Incorrect email or password/);
      expect(s.res.body).not.toMatch(/not active|Two-step verification/);
      const codes = await withTenant(T, (tx) => tx`SELECT id FROM oauth_authorization_codes WHERE user_id = ${person.id}`, sql);
      expect(codes).toHaveLength(0);
    });
  });

  describe("consent", () => {
    it("names the client_id host and the redirect host, not the client's self-chosen name, and warns for loopback", async () => {
      const loop = await signInThroughTotp(await freshAlice());
      expect(loop.res.statusCode, loop.res.body).toBe(200);
      expect(loop.res.body).toMatch(/<dd class="mono">claude\.ai<\/dd>/);
      expect(loop.res.body).toMatch(/<dd class="mono">localhost:53123<\/dd>/);
      expect(loop.res.body).not.toMatch(/Claude Code/);
      expect(loop.res.body).toMatch(/program on this computer/);
      expect(String(loop.res.headers["content-security-policy"])).toMatch(/form-action 'self' http:\/\/localhost:53123/);

      const hosted = await signInThroughTotp(await freshAlice(), { client_id: HOSTED, redirect_uri: HOSTED_CALLBACK });
      expect(hosted.res.statusCode, hosted.res.body).toBe(200);
      expect(hosted.res.body).toMatch(/<dd class="mono">client\.casefile\.test<\/dd>/);
      expect(hosted.res.body).not.toMatch(/Totally Trustworthy Client/);
      expect(hosted.res.body).not.toMatch(/program on this computer/);
    });

    it("is asked every time: a second sign-in shows consent again", async () => {
      const alice = await freshAlice();
      await getCode(alice);
      const again = await signInThroughTotp(alice);
      expect(again.res.body).toMatch(/Allow access to this matter\?/);
    });

    it("deny returns access_denied with state and iss, and no code", async () => {
      const s = await signInThroughTotp(await freshAlice());
      const deny = await postForm(s.cookie, { flow: hiddenValue(s.res.body, "flow"), csrf: s.csrf, decision: "deny" });
      expect(deny.statusCode).toBe(302);
      const loc = new URL(String(deny.headers.location));
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.get("state")).toBe(s.params.state);
      expect(loc.searchParams.get("iss")).toBe(ISSUER);
      expect(loc.searchParams.get("code")).toBeNull();
    });

    it("approve returns code, state and iss to the exact redirect URI", async () => {
      const { location, params } = await getCode(await freshAlice());
      expect(`${location.origin}${location.pathname}`).toBe("http://localhost:53123/callback");
      expect(location.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.searchParams.get("state")).toBe(params.state);
      expect(location.searchParams.get("iss")).toBe(ISSUER);
    });
  });

  describe("token endpoint", () => {
    it("exchanges a code with S256 for a 15-minute access token for /mcp and a refresh token", async () => {
      const alice = await freshAlice();
      const { code, verifier } = await getCode(alice);
      const res = await exchange(code, verifier);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.body);
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(900);
      expect(body.scope).toBe("casefile.read offline_access");
      expect(typeof body.refresh_token).toBe("string");
      const claims = jwtClaims(body.access_token);
      expect(claims.aud).toBe(RESOURCE);
      expect(claims.scope).toBe("casefile.read");
      expect(claims.cid).toBe(CLAUDE_CODE);
      expect(claims.sub).toBe(alice.id);
      expect(claims.tid).toBe(T);
      expect(claims.mfa).toBe(true);
      expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    });

    it("issues no refresh token without offline_access", async () => {
      const { code, verifier } = await getCode(await freshAlice(), { scope: "casefile.read" });
      const body = JSON.parse((await exchange(code, verifier)).body);
      expect(body.scope).toBe("casefile.read");
      expect(body.refresh_token).toBeUndefined();
    });

    it("the MCP access token is refused by the REST API", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const { access_token } = JSON.parse((await exchange(code, verifier)).body);
      const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${access_token}` } });
      expect(me.statusCode).toBe(401);
    });

    it("rejects a wrong code_verifier, and the code is then spent", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const wrong = await exchange(code, pkce().verifier);
      expect(wrong.statusCode).toBe(400);
      expect(JSON.parse(wrong.body).error).toBe("invalid_grant");
      const right = await exchange(code, verifier);
      expect(JSON.parse(right.body).error).toBe("invalid_grant");
    });

    it("rejects a reused code and revokes the session the first redemption created", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const first = JSON.parse((await exchange(code, verifier)).body);
      const second = await exchange(code, verifier);
      expect(second.statusCode).toBe(400);
      expect(JSON.parse(second.body).error).toBe("invalid_grant");
      const refresh = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_CODE });
      expect(JSON.parse(refresh.body).error, "the first session must be revoked").toBe("invalid_grant");
    });

    it("rejects an expired code (60 seconds)", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      await withTenant(T, (tx) => tx`
        UPDATE oauth_authorization_codes
        SET created_at = NOW() - INTERVAL '5 minutes', expires_at = NOW() - INTERVAL '4 minutes'
        WHERE code_hash = ${createHash("sha256").update(code).digest("hex")}`, sql);
      const res = await exchange(code, verifier);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_grant", error_description: expect.stringMatching(/expired/) });
    });

    it("rejects a redirect_uri that differs from the authorization request (even only the port)", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const res = await exchange(code, verifier, "http://localhost:53124/callback");
      expect(JSON.parse(res.body).error).toBe("invalid_grant");
    });

    it("rejects a missing or wrong resource", async () => {
      const a = await getCode(await freshAlice());
      const missing = await token({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, client_id: CLAUDE_CODE, redirect_uri: "http://localhost:53123/callback" });
      expect(JSON.parse(missing.body).error).toBe("invalid_request");
      const b = await getCode(await freshAlice());
      const wrong = await exchange(b.code, b.verifier, "http://localhost:53123/callback", { resource: "https://other.casefile.test/mcp" });
      expect(JSON.parse(wrong.body).error).toBe("invalid_target");
    });

    it("accepts only form-encoded bodies", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const res = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/json" },
        payload: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLAUDE_CODE, redirect_uri: "http://localhost:53123/callback", resource: RESOURCE },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_request");
    });

    it("rejects an unknown client_id and a repeated parameter", async () => {
      const unknown = await token({ grant_type: "authorization_code", code: "x", client_id: "https://unlisted.casefile.test/cimd.json" });
      expect(unknown.statusCode).toBe(401);
      expect(JSON.parse(unknown.body).error).toBe("invalid_client");
      const dup = await app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "grant_type=refresh_token&grant_type=authorization_code" });
      expect(JSON.parse(dup.body).error).toBe("invalid_request");
      const grant = await token({ grant_type: "password", client_id: CLAUDE_CODE });
      expect(JSON.parse(grant.body).error).toBe("unsupported_grant_type");
    });

    it("rotates refresh tokens; replaying an old one returns invalid_grant and revokes the whole connection", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const first = JSON.parse((await exchange(code, verifier)).body);
      const rotated = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_CODE, resource: RESOURCE });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const second = JSON.parse(rotated.body);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(jwtClaims(second.access_token).aud).toBe(RESOURCE);

      const replay = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_CODE });
      expect(replay.statusCode).toBe(400);
      expect(JSON.parse(replay.body).error).toBe("invalid_grant");
      const afterReplay = await token({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: CLAUDE_CODE });
      expect(JSON.parse(afterReplay.body).error, "the family is revoked").toBe("invalid_grant");
    });

    it("refuses a refresh token presented by another client, without revoking it", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const first = JSON.parse((await exchange(code, verifier)).body);
      const other = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: HOSTED });
      expect(JSON.parse(other.body).error).toBe("invalid_grant");
      const own = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_CODE });
      expect(own.statusCode).toBe(200);
    });

    it("ends a connection unused for 30 days", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const first = JSON.parse((await exchange(code, verifier)).body);
      const claims = jwtClaims(first.access_token);
      await withTenant(T, (tx) => tx`UPDATE auth_sessions SET last_active_at = NOW() - INTERVAL '31 days' WHERE id = ${String(claims.sid)}`, sql);
      const res = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_CODE });
      expect(JSON.parse(res.body).error).toBe("invalid_grant");
    });

    it("ends a connection 90 days after sign-in however much it is used", async () => {
      const { code, verifier } = await getCode(await freshAlice());
      const first = JSON.parse((await exchange(code, verifier)).body);
      const claims = jwtClaims(first.access_token);
      const [row] = await withTenant(T, (tx) => tx<{ days: string }[]>`
        SELECT round(EXTRACT(EPOCH FROM (expires_at - created_at)) / 86400)::text AS days FROM auth_sessions WHERE id = ${String(claims.sid)}`, sql);
      expect(row!.days).toBe("90");
      await withTenant(T, (tx) => tx`UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${String(claims.sid)}`, sql);
      const res = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLAUDE_CODE });
      expect(JSON.parse(res.body).error, `${res.statusCode} ${res.body}`).toBe("invalid_grant");
    });

    it("audits consent and token issue with the real user", async () => {
      const alice = await freshAlice();
      const { code, verifier } = await getCode(alice);
      await exchange(code, verifier);
      const rows = await withTenant(T, (tx) => tx<{ action: string }[]>`
        SELECT DISTINCT action FROM audit_events WHERE tenant_id = ${T} AND actor_id = ${alice.id}
          AND action IN ('auth.oauth_consent_granted', 'auth.oauth_token_issued')`, sql);
      expect(rows.map((r) => r.action).sort()).toEqual(["auth.oauth_consent_granted", "auth.oauth_token_issued"]);
    });
  });

  it("rate-limits sign-in form posts (D66 login rule)", async () => {
    const limited = buildApp({ db: sql, oauth: { cimdTransport: fakeTransport }, rateLimit: { rules: { login: { perIp: 2, perAccount: 100 } } } });
    await limited.ready();
    try {
      const page = await limited.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams(claudeCodeParams().params as Record<string, string>)}` });
      const cookie = csrfCookie(page.headers["set-cookie"]);
      const fields = form({ flow: hiddenValue(page.body, "flow"), csrf: hiddenValue(page.body, "csrf"), email: people.carol!.email, password: "wrong" });
      // Counters are shared in Postgres and outlive a run: a fresh address per run.
      const ip = `10.${randomBytes(3).join(".")}`;
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await limited.inject({ method: "POST", url: "/oauth/authorize", remoteAddress: ip, headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` }, payload: fields });
        statuses.push(r.statusCode);
      }
      expect(statuses).toEqual([401, 401, 429]);
    } finally {
      await limited.close();
    }
  });

  it("end to end, like Claude Code: discovery → sign-in → TOTP → consent → token → refresh → replay rejected", async () => {
    // 1. Discovery, as the spec requires a client to do it.
    const prm = JSON.parse((await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" })).body);
    expect(prm.resource).toBe(RESOURCE);
    const issuer = prm.authorization_servers[0];
    const asm = JSON.parse((await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })).body);
    expect(asm.issuer, "issuer must equal the one used to build the metadata URL").toBe(issuer);
    expect(asm.code_challenge_methods_supported).toContain("S256");
    expect(asm.client_id_metadata_document_supported).toBe(true);
    expect(asm.token_endpoint_auth_methods_supported).toContain("none");

    // 2-4. Authorize: sign-in, TOTP, consent.
    const { location, code, verifier, params } = await getCode(await freshAlice(), { redirect_uri: "http://127.0.0.1:47801/callback" });
    expect(location.searchParams.get("iss"), "RFC 9207 check").toBe(issuer);
    expect(location.searchParams.get("state")).toBe(params.state);

    // 5. Token.
    const t1 = JSON.parse((await exchange(code, verifier, "http://127.0.0.1:47801/callback")).body);
    expect(jwtClaims(t1.access_token).aud).toBe(RESOURCE);

    // 6. Refresh.
    const t2res = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: CLAUDE_CODE, resource: RESOURCE });
    expect(t2res.statusCode).toBe(200);
    const t2 = JSON.parse(t2res.body);

    // 7. Replay of the first refresh token.
    const replay = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: CLAUDE_CODE });
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.body)).toMatchObject({ error: "invalid_grant" });
    const dead = await token({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: CLAUDE_CODE });
    expect(JSON.parse(dead.body).error).toBe("invalid_grant");
  });
});
