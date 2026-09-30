import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import "../types.js";
import { AuthError, AuthService } from "../auth/service.js";
import { SCOPE_READ, SCOPE_OFFLINE, resourceMatches, type OAuthConfig } from "../oauth/config.js";
import { CimdError, isLoopbackRedirect, redirectUriAllowed, type createCimdFetcher } from "../oauth/cimd.js";
import {
  CSRF_COOKIE,
  csrfCookieHeader,
  randomToken,
  readCookie,
  safeEqual,
  sha256,
  signFlow,
  verifyFlow,
  type FlowBase,
} from "../oauth/flow.js";
import { escapeHtml, hidden, sendPage } from "../oauth/pages.js";
import {
  REFUSAL_MESSAGES,
  SESSION_IDLE_SECONDS,
  auditOAuthEvent,
  checkMcpEligibility,
  grantScopes,
  issueAuthorizationCode,
  redeemAuthorizationCode,
  startOAuthSession,
} from "../oauth/service.js";

/**
 * Casefile's own OAuth 2.1 authorization server for the /mcp connector (D69, D70).
 * Built to the MCP authorization spec, revision 2026-07-28
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and Claude's
 * connector requirements (https://claude.com/docs/connectors/building/authentication).
 *
 * - Discovery: RFC 9728 protected resource metadata and RFC 8414 authorization server metadata.
 * - Clients identify themselves only with Client ID Metadata Documents from an allowlist.
 * - GET/POST /oauth/authorize: password, then TOTP (both through AuthService), then the
 *   eligibility checks, then consent on every connection; redirect with code, state and iss.
 * - POST /oauth/token (form-encoded): authorization_code with PKCE S256, and refresh_token
 *   with rotation.
 * /mcp accepts only the access tokens issued here (Phase 2B, D73: apps/api/src/mcp/auth.ts).
 */

export interface OAuthRoutesOptions {
  oauth: OAuthConfig | { error: string };
  cimd: ReturnType<typeof createCimdFetcher>;
}

const FLOW_SECONDS = 600;

interface AuthorizeFlow extends FlowBase {
  purpose: "oauth-authorize";
  step: "password" | "totp" | "consent";
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  userId?: string;
  email?: string;
}

type Params = Record<string, string | undefined>;

/** Single-valued string parameters only; a repeated parameter makes the request invalid (RFC 6749 section 3.1). */
function singleValued(input: unknown): { params: Params; duplicate: string | null } {
  const params: Params = {};
  if (typeof input !== "object" || input === null) return { params, duplicate: null };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (Array.isArray(v)) return { params, duplicate: k };
    if (typeof v === "string") params[k] = v;
  }
  return { params, duplicate: null };
}

export const oauthRoutes: FastifyPluginAsync<OAuthRoutesOptions> = async (fastify, opts) => {
  // application/x-www-form-urlencoded, for the token endpoint and the sign-in forms. Scoped to
  // this plugin; a repeated key becomes an array so singleValued() can refuse it.
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(body as string)) {
      const prev = out[k];
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    done(null, out);
  });

  const configured = (): OAuthConfig | null => ("error" in opts.oauth ? null : opts.oauth);

  const misconfigured = (reply: FastifyReply) =>
    reply.status(503).send({ error: "server_misconfigured", error_description: "The OAuth server is not configured (MCP_PUBLIC_URL)." });

  // ── Discovery ──────────────────────────────────────────────────────────────────────────
  const protectedResource = async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = configured();
    if (!cfg) return misconfigured(reply);
    // offline_access is deliberately absent: MCP servers SHOULD NOT list it (spec, "Refresh Tokens").
    return reply.header("cache-control", "public, max-age=300").send({
      resource: cfg.resource,
      authorization_servers: [cfg.issuer],
      scopes_supported: [SCOPE_READ],
      bearer_methods_supported: ["header"],
    });
  };
  fastify.get("/.well-known/oauth-protected-resource/mcp", { config: { public: true } }, protectedResource);
  fastify.get("/.well-known/oauth-protected-resource", { config: { public: true } }, protectedResource);

  fastify.get("/.well-known/oauth-authorization-server", { config: { public: true } }, async (_req, reply) => {
    const cfg = configured();
    if (!cfg) return misconfigured(reply);
    return reply.header("cache-control", "public, max-age=300").send({
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
      token_endpoint: `${cfg.issuer}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      scopes_supported: [SCOPE_READ, SCOPE_OFFLINE],
      authorization_response_iss_parameter_supported: true,
    });
  });

  // ── Authorization endpoint ─────────────────────────────────────────────────────────────
  const errorPage = (reply: FastifyReply, message: string, status = 400) =>
    sendPage(reply, {
      title: "Sign-in problem",
      status,
      body: `<h1>Sign-in cannot continue</h1><p class="error">${escapeHtml(message)}</p>
<p class="muted">Nothing was shared. Start again from Claude, or ask your Casefile administrator.</p>`,
    });

  /** The redirect back to the client, with iss on every response including errors (RFC 9207). */
  const backToClient = (cfg: OAuthConfig, redirectUri: string, params: Record<string, string | null | undefined>): string => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    url.searchParams.set("iss", cfg.issuer);
    return url.toString();
  };

  const redirect = (reply: FastifyReply, location: string) => reply.status(302).header("location", location).header("cache-control", "no-store").send();

  const signInBody = (flow: string, csrf: string, error?: string, email?: string) => `
<h1>Sign in to connect Claude</h1>
<p class="muted">Use your Casefile account for this matter.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("flow", flow)}${hidden("csrf", csrf)}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email ?? "")}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Continue</button>
</form>`;

  const totpBody = (flow: string, csrf: string, email: string, error?: string) => `
<h1>Two-step verification</h1>
<p class="muted">Enter the 6-digit code from the authenticator app for <strong>${escapeHtml(email)}</strong>.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("flow", flow)}${hidden("csrf", csrf)}${hidden("email", email)}
<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">Verify</button>
</form>`;

  const refusalPage = (reply: FastifyReply, cfg: OAuthConfig, f: AuthorizeFlow, message: string) =>
    sendPage(reply, {
      title: "Access not granted",
      status: 403,
      body: `<h1>Claude cannot be connected</h1>
<p class="error">${escapeHtml(message)}</p>
<p class="muted">No access was granted and no token was issued.</p>
<p><a href="${escapeHtml(backToClient(cfg, f.redirectUri, { error: "access_denied", error_description: message, state: f.state }))}">Return to Claude</a></p>`,
    });

  fastify.get("/oauth/authorize", { config: { public: true } }, async (req, reply) => {
    const cfg = configured();
    if (!cfg) return misconfigured(reply);
    const { params: q, duplicate } = singleValued(req.query);
    if (duplicate) return errorPage(reply, `The parameter "${duplicate}" appears more than once.`);

    // Until client_id and redirect_uri are both verified, errors are shown here and never redirected.
    if (!q.client_id) return errorPage(reply, "The request does not say which app is asking (client_id is missing).");
    let client;
    try {
      client = await opts.cimd.fetchClient(q.client_id);
    } catch (err) {
      const message = err instanceof CimdError ? err.message : "the client could not be verified";
      req.log.warn({ client_id: q.client_id, reason: message }, "oauth: client refused");
      return errorPage(reply, `This app is not allowed to sign in here: ${message}.`);
    }
    if (!q.redirect_uri || !redirectUriAllowed(q.redirect_uri, client.redirectUris)) {
      req.log.warn({ client_id: q.client_id, redirect_uri: q.redirect_uri }, "oauth: redirect_uri refused");
      return errorPage(reply, "The app asked to return to an address that is not allowed.");
    }
    const back = (error: string, description: string) =>
      redirect(reply, backToClient(cfg, q.redirect_uri!, { error, error_description: description, state: q.state }));

    if (q.response_type !== "code") return back("unsupported_response_type", "response_type must be code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return back("invalid_request", "code_challenge is not a S256 challenge");
    if (!resourceMatches(q.resource, cfg.resource)) return back("invalid_target", `resource must be ${cfg.resource}`);
    const scopes = grantScopes(q.scope);
    if (!scopes) return back("invalid_scope", `supported scopes: ${SCOPE_READ} ${SCOPE_OFFLINE}`);

    const csrf = randomToken();
    reply.header("set-cookie", csrfCookieHeader(csrf));
    const flow = signFlow<AuthorizeFlow>({
      purpose: "oauth-authorize",
      step: "password",
      csrf: sha256(csrf),
      exp: Math.floor(Date.now() / 1000) + FLOW_SECONDS,
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri: q.redirect_uri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      scope: scopes.join(" "),
    });
    return sendPage(reply, { title: "Sign in", body: signInBody(flow, csrf) });
  });

  fastify.post("/oauth/authorize", { config: { public: true } }, async (req, reply) => {
    const cfg = configured();
    if (!cfg) return misconfigured(reply);
    const { params: b, duplicate } = singleValued(req.body);
    const cookie = readCookie(req.headers.cookie, CSRF_COOKIE);
    const f = duplicate ? null : verifyFlow<AuthorizeFlow>(b.flow, "oauth-authorize", cookie);
    if (!f || !safeEqual(b.csrf, cookie)) {
      return errorPage(reply, "This sign-in page has expired or was opened in a different browser.", 403);
    }
    const csrf = cookie!;
    const tenantId = process.env.MATTER_TENANT_ID!;
    const investigationId = process.env.MATTER_INVESTIGATION_ID!;
    const next = (patch: Partial<AuthorizeFlow>) =>
      signFlow<AuthorizeFlow>({ ...f, ...patch, exp: Math.floor(Date.now() / 1000) + FLOW_SECONDS });

    if (f.step === "password") {
      const email = (b.email ?? "").trim();
      let result;
      try {
        result = await AuthService.login(req.tx!, {
          email,
          password: b.password ?? "",
          tenantId,
          ipHash: req.ip,
          userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : undefined,
          requestId: req.id,
          issueSession: false,
        });
      } catch (err) {
        if (err instanceof AuthError && err.code === "ACCOUNT_LOCKED") {
          return sendPage(reply, { title: "Sign in", status: 429, body: signInBody(b.flow!, csrf, err.message, email) });
        }
        if (err instanceof AuthError) {
          return sendPage(reply, { title: "Sign in", status: 401, body: signInBody(b.flow!, csrf, "Incorrect email or password.", email) });
        }
        throw err;
      }
      if (!result.totpEnabled) {
        await auditOAuthEvent(req.tx!, { tenantId, userId: result.userId!, action: "auth.oauth_signin_refused", clientId: f.clientId, redirectUri: f.redirectUri, requestId: req.id, reason: "no_totp" });
        return refusalPage(reply, cfg, f, REFUSAL_MESSAGES.no_totp);
      }
      return sendPage(reply, { title: "Two-step verification", body: totpBody(next({ step: "totp", userId: result.userId!, email }), csrf, email) });
    }

    if (f.step === "totp") {
      if (!f.userId || !f.email || b.email !== f.email) return errorPage(reply, "This sign-in page has expired.", 403);
      const ok = await AuthService.verifyTotpCode(req.tx!, { userId: f.userId, tenantId, totpCode: b.code ?? "" });
      if (!ok) {
        return sendPage(reply, { title: "Two-step verification", status: 401, body: totpBody(b.flow!, csrf, f.email, "That code is not valid. Try the current code.") });
      }
      const eligibility = await checkMcpEligibility(req.tx!, { tenantId, investigationId, userId: f.userId });
      if (!eligibility.ok) {
        await auditOAuthEvent(req.tx!, { tenantId, userId: f.userId, action: "auth.oauth_signin_refused", clientId: f.clientId, redirectUri: f.redirectUri, requestId: req.id, reason: eligibility.reason });
        return refusalPage(reply, cfg, f, eligibility.message);
      }
      const clientHost = new URL(f.clientId).host;
      const redirectHost = new URL(f.redirectUri).host;
      const loopback = isLoopbackRedirect(f.redirectUri);
      const offline = f.scope.split(" ").includes(SCOPE_OFFLINE);
      return sendPage(reply, {
        title: "Allow access",
        formActionOrigins: [new URL(f.redirectUri).origin],
        body: `
<h1>Allow access to this matter?</h1>
<p>An app is asking to read this Casefile matter as <strong>${escapeHtml(f.email)}</strong>.</p>
<dl>
<dt>App (client ID host)</dt><dd class="mono">${escapeHtml(clientHost)}</dd>
<dt>Returns to</dt><dd class="mono">${escapeHtml(redirectHost)}</dd>
<dt>Access</dt><dd>Read documents, search and evidence in this matter</dd>
${offline ? "<dt>Duration</dt><dd>Stays connected up to 90 days (30 days unused)</dd>" : ""}
</dl>
${loopback ? `<p class="warn">This app returns to a program on this computer (${escapeHtml(redirectHost)}). Any program on a computer can claim to be this app, so continue only if you started this sign-in yourself, just now, on this computer.</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("flow", next({ step: "consent" }))}${hidden("csrf", csrf)}
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>`,
      });
    }

    // step === "consent"
    if (!f.userId) return errorPage(reply, "This sign-in page has expired.", 403);
    if (b.decision !== "approve") {
      await auditOAuthEvent(req.tx!, { tenantId, userId: f.userId, action: "auth.oauth_consent_denied", clientId: f.clientId, redirectUri: f.redirectUri, requestId: req.id });
      return redirect(reply, backToClient(cfg, f.redirectUri, { error: "access_denied", error_description: "The user denied access", state: f.state }));
    }
    const code = await issueAuthorizationCode(req.tx!, {
      tenantId,
      userId: f.userId,
      clientId: f.clientId,
      redirectUri: f.redirectUri,
      codeChallenge: f.codeChallenge,
      resource: cfg.resource,
      scope: f.scope,
    });
    await auditOAuthEvent(req.tx!, { tenantId, userId: f.userId, action: "auth.oauth_consent_granted", clientId: f.clientId, redirectUri: f.redirectUri, requestId: req.id });
    return redirect(reply, backToClient(cfg, f.redirectUri, { code, state: f.state }));
  });

  // ── Token endpoint ─────────────────────────────────────────────────────────────────────
  const tokenError = (reply: FastifyReply, status: number, error: string, description: string) =>
    reply.status(status).header("cache-control", "no-store").header("pragma", "no-cache").send({ error, error_description: description });

  fastify.post("/oauth/token", { config: { public: true } }, async (req, reply) => {
    const cfg = configured();
    if (!cfg) return misconfigured(reply);
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return tokenError(reply, 400, "invalid_request", "The token endpoint takes application/x-www-form-urlencoded");
    }
    const { params: b, duplicate } = singleValued(req.body);
    if (duplicate) return tokenError(reply, 400, "invalid_request", `The parameter "${duplicate}" appears more than once`);
    if (b.grant_type !== "authorization_code" && b.grant_type !== "refresh_token") {
      return tokenError(reply, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
    if (!b.client_id || !cfg.trustedClients.includes(b.client_id)) {
      return tokenError(reply, 401, "invalid_client", "Unknown client_id");
    }
    const tenantId = process.env.MATTER_TENANT_ID!;
    await req.tx!`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    if (b.grant_type === "authorization_code") {
      if (!b.code) return tokenError(reply, 400, "invalid_request", "code is required");
      if (!b.resource) return tokenError(reply, 400, "invalid_request", "resource is required");
      if (!resourceMatches(b.resource, cfg.resource)) return tokenError(reply, 400, "invalid_target", `resource must be ${cfg.resource}`);
      const redeemed = await redeemAuthorizationCode(req.tx!, {
        tenantId,
        code: b.code,
        clientId: b.client_id,
        redirectUri: b.redirect_uri,
        codeVerifier: b.code_verifier,
        resourceOk: (stored) => stored === cfg.resource,
        requestId: req.id,
      });
      if ("error" in redeemed) return tokenError(reply, 400, redeemed.error, redeemed.description);
      // The user may have lost access in the 60 seconds since consent.
      const eligibility = await checkMcpEligibility(req.tx!, { tenantId, investigationId: process.env.MATTER_INVESTIGATION_ID!, userId: redeemed.userId });
      if (!eligibility.ok) return tokenError(reply, 400, "invalid_grant", "The user no longer has access to this matter");
      const tokens = await startOAuthSession(req.tx!, {
        tenantId,
        userId: redeemed.userId,
        clientId: b.client_id,
        audience: cfg.resource,
        scope: redeemed.scope,
        codeId: redeemed.id,
        requestId: req.id,
      });
      return reply.header("cache-control", "no-store").header("pragma", "no-cache").send(tokens);
    }

    // refresh_token
    if (!b.refresh_token) return tokenError(reply, 400, "invalid_request", "refresh_token is required");
    if (b.resource !== undefined && !resourceMatches(b.resource, cfg.resource)) {
      return tokenError(reply, 400, "invalid_target", `resource must be ${cfg.resource}`);
    }
    if (b.scope !== undefined && grantScopes(b.scope) === null) return tokenError(reply, 400, "invalid_scope", "Unknown scope");
    const investigationId = process.env.MATTER_INVESTIGATION_ID!;
    const rotated = await AuthService.rotateRefreshToken(req.tx!, {
      refreshToken: b.refresh_token,
      requestId: req.id,
      oauth: {
        audience: cfg.resource,
        clientId: b.client_id,
        scope: SCOPE_READ,
        idleSeconds: SESSION_IDLE_SECONDS,
        // D76: role, membership and ethical walls are re-checked on every refresh.
        eligible: async (tx, userId) => (await checkMcpEligibility(tx, { tenantId, investigationId, userId })).ok,
      },
    });
    if ("isError" in rotated) return tokenError(reply, 400, "invalid_grant", rotated.error.message);
    return reply.header("cache-control", "no-store").header("pragma", "no-cache").send({
      access_token: rotated.accessToken,
      token_type: "Bearer",
      expires_in: rotated.expiresIn,
      scope: `${SCOPE_READ} ${SCOPE_OFFLINE}`,
      refresh_token: rotated.refreshToken,
    });
  });
};
