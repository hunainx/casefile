import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { withTenant } from "@casefile/db";
import { generateTotpSecret, hashPassword, type JwtPayload } from "../../src/auth/crypto.js";
import type { CimdTransport } from "../../src/oauth/cimd.js";
import { nextTotpCode } from "./totp.js";

/**
 * Real OAuth access tokens for /mcp tests (Phase 2B). A token is obtained exactly the way
 * Claude Code obtains one: authorization request with PKCE S256 and resource, the sign-in page
 * (password, then TOTP), consent, then the token endpoint. Nothing is minted directly and no
 * check is skipped; the only stand-in is the network fetch of Claude Code's client metadata
 * document, which buildApp() takes as a code-only test hook (`oauth.cimdTransport`).
 */

/** MCP_PUBLIC_URL in the vitest configs. */
export const MCP_RESOURCE = "https://mcp.casefile.test/mcp";
export const MCP_ISSUER = "https://mcp.casefile.test";
export const CLAUDE_CODE_CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
export const LOOPBACK_REDIRECT = "http://localhost:53123/callback";

/** Serves Claude Code's published client metadata document (its shape as fetched 2026-09-26). */
export const claudeCodeCimdTransport: CimdTransport = {
  async resolve(hostname) {
    return hostname === "claude.ai" ? ["93.184.215.14"] : [];
  },
  async get(url) {
    if (url.href !== CLAUDE_CODE_CLIENT) return { status: 404, headers: {}, body: Buffer.from("") };
    return {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
      body: Buffer.from(
        JSON.stringify({
          client_id: CLAUDE_CODE_CLIENT,
          client_name: "Claude Code",
          client_uri: "https://claude.ai",
          redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      ),
    };
  },
};

export interface McpPerson {
  id: string;
  email: string;
  password: string;
  secret: string;
  tenantId: string;
}

/**
 * A user with a password and an enrolled TOTP secret, as the one-time setup link leaves them
 * (apps/api/test/account-setup.integration.test.ts drives that page itself).
 */
export async function seedMcpPerson(
  db: postgres.Sql,
  opts: {
    tenantId: string;
    workspaceId: string;
    investigationId?: string;
    label: string;
    wsRole?: string;
    invRole?: string;
    totp?: boolean;
    status?: string;
  },
): Promise<McpPerson> {
  const p: McpPerson = {
    id: randomUUID(),
    email: `${opts.label}-${randomUUID().slice(0, 8)}@casefile.test`,
    password: `Pw-${opts.label}-Casefile-2026!`,
    secret: generateTotpSecret(),
    tenantId: opts.tenantId,
  };
  const hash = await hashPassword(p.password);
  await withTenant(opts.tenantId, async (tx) => {
    await tx`INSERT INTO users (id, tenant_id, email, name, status) VALUES (${p.id}, ${opts.tenantId}, ${p.email}, ${opts.label}, ${opts.status ?? "active"})`;
    await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash, totp_secret, totp_enabled)
             VALUES (${p.id}, ${opts.tenantId}, ${hash}, ${opts.totp === false ? null : p.secret}, ${opts.totp !== false})`;
    if (opts.wsRole) {
      await tx`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
               VALUES (${randomUUID()}, ${opts.tenantId}, ${opts.workspaceId}, ${p.id}, ${opts.wsRole})`;
    }
    if (opts.invRole) {
      if (!opts.investigationId) throw new Error("invRole needs investigationId");
      await tx`INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role)
               VALUES (${randomUUID()}, ${opts.tenantId}, ${opts.investigationId}, ${p.id}, ${opts.invRole})`;
    }
  }, db);
  return p;
}

/** The subset of a Fastify instance the helper drives. */
export interface Injectable {
  inject(opts: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    payload?: string | Record<string, unknown>;
  }): PromiseLike<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
}

const hidden = (html: string, name: string): string => {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no hidden field ${name} in:\n${html}`);
  return m[1]!;
};

export interface SignInResult {
  /** The page or redirect the sign-in ended on (consent redirect, or a refusal page). */
  status: number;
  body: string;
  /** Set when the user was allowed through consent and the code was exchanged. */
  tokens?: { access_token: string; refresh_token?: string; token_type: string; expires_in: number; scope: string };
}

/**
 * Runs the whole sign-in for `person` against the matter the app currently serves
 * (MATTER_TENANT_ID / MATTER_INVESTIGATION_ID at request time). Stops at a refusal page and
 * returns it, so tests can assert that no token was issued.
 */
export async function signInForMcp(
  app: Injectable,
  person: McpPerson,
  opts: { scope?: string; redirectUri?: string } = {},
): Promise<SignInResult> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = opts.redirectUri ?? LOOPBACK_REDIRECT;
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLAUDE_CODE_CLIENT,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
    scope: opts.scope ?? "casefile.read offline_access",
    state: `state-${randomUUID()}`,
  });
  const page = await app.inject({ method: "GET", url: `/oauth/authorize?${q.toString()}` });
  if (page.statusCode !== 200) throw new Error(`authorize page: ${page.statusCode}\n${page.body}`);
  const setCookie = page.headers["set-cookie"];
  const cookie = /__Host-cf_csrf=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie))?.[1];
  if (!cookie) throw new Error("no CSRF cookie from /oauth/authorize");
  const csrf = hidden(page.body, "csrf");
  const post = (fields: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` },
      payload: new URLSearchParams(fields).toString(),
    });

  const pw = await post({ flow: hidden(page.body, "flow"), csrf, email: person.email, password: person.password });
  if (pw.statusCode !== 200) return { status: pw.statusCode, body: pw.body };
  const totp = await post({ flow: hidden(pw.body, "flow"), csrf, email: person.email, code: await nextTotpCode(person.secret) });
  if (totp.statusCode !== 200) return { status: totp.statusCode, body: totp.body };
  const consent = await post({ flow: hidden(totp.body, "flow"), csrf, decision: "approve" });
  if (consent.statusCode !== 302) return { status: consent.statusCode, body: consent.body };
  const code = new URL(String(consent.headers.location)).searchParams.get("code");
  if (!code) throw new Error(`no code in ${String(consent.headers.location)}`);

  const token = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE_CODE_CLIENT,
      redirect_uri: redirectUri,
      resource: MCP_RESOURCE,
    }).toString(),
  });
  if (token.statusCode !== 200) throw new Error(`token endpoint: ${token.statusCode}\n${token.body}`);
  return { status: consent.statusCode, body: consent.body, tokens: JSON.parse(token.body) };
}

/** signInForMcp for a person who must get a token; returns the access token. */
export async function mcpAccessToken(app: Injectable, person: McpPerson, opts: { scope?: string } = {}): Promise<string> {
  const r = await signInForMcp(app, person, opts);
  if (!r.tokens) throw new Error(`${person.email} got no token: ${r.status}\n${r.body}`);
  return r.tokens.access_token;
}

export function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

/**
 * A token's claims without iat, exp and jti (signJwt sets those) and without `drop`, ready to
 * be changed and signed again with the matter's secret: how the tests forge a token that is
 * validly signed but wrong in one respect.
 */
export function claimsToResign(token: string, drop: string[] = []): Omit<JwtPayload, "iat" | "exp" | "jti"> {
  const skip = new Set(["iat", "exp", "jti", ...drop]);
  return Object.fromEntries(Object.entries(jwtClaims(token)).filter(([k]) => !skip.has(k))) as Omit<JwtPayload, "iat" | "exp" | "jti">;
}

export const MCP_ACCEPT = "application/json, text/event-stream";

/** One JSON-RPC request to POST /mcp with a bearer token. */
export function mcpPost(app: Injectable, token: string | undefined, payload: Record<string, unknown>, url = "/mcp") {
  return app.inject({
    method: "POST",
    url,
    headers: { accept: MCP_ACCEPT, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload,
  });
}
