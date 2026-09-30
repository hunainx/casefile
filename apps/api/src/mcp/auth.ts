import type { FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@casefile/db";
import { checkMcpEligibility } from "@casefile/mcp";
import "../types.js";
import { verifyJwt, type JwtPayload } from "../auth/crypto.js";
import { resolveOAuthConfig, SCOPE_READ } from "../oauth/config.js";
import type { McpRateLimit } from "../rate-limit.js";
import { LOCAL_NO_LOGIN, localNoLoginRequestProblem, type McpAuthConfig } from "./local-mode.js";

/**
 * The /mcp auth gate (D73): the only way into /mcp. It runs as the first preHandler of every
 * /mcp route, before the route's handler and its tenant transaction, on every request.
 *
 * OAuth mode (the default) accepts exactly one kind of credential, the OAuth access token
 * issued by this deployment's authorization server (D69), in the Authorization header. Checked
 * each time:
 *   1. no access_token in the query string (MCP spec: tokens only in the header);
 *   2. HS256 signature and expiry (verifyJwt);
 *   3. aud = MCP_PUBLIC_URL — so a REST token (no aud), the MFA challenge token, a token for
 *      another deployment's URL, and the retired static MCP_TOKEN are all refused;
 *   4. tid = MATTER_TENANT_ID;
 *   5. scope includes casefile.read (else 403 insufficient_scope);
 *   6. in the database: the session (sid) exists, belongs to the token's user, is not revoked
 *      or expired, and is an OAuth connection for this audience and this client (cid);
 *   7. in the database: the user is active, a member of the workspace that owns
 *      MATTER_INVESTIGATION_ID, not behind an ethical wall, and has an MCP-capable role
 *      (checkMcpEligibility, the same check as sign-in).
 * Any failure is 401 with WWW-Authenticate: Bearer resource_metadata="…", scope="casefile.read"
 * (plus error="invalid_token" when a token was presented), which is what makes Claude start
 * or restart sign-in.
 *
 * Local no-login mode (D77, apps/api/src/mcp/local-mode.ts) replaces steps 1-6 with the
 * loopback address + local Host check (403 otherwise) and runs as MCP_LOCAL_USER_ID; step 7
 * still runs on every request (403 if the user no longer qualifies).
 *
 * Rate limits (D78): a request the gate refuses counts against its client address; a request
 * from an identified caller counts against that user only.
 *
 * The caller is left on req.mcpCaller for the tool handlers.
 */

/** Marks the gate function, so guardrails/mcp-auth.spec.ts can tell every /mcp route uses it. */
export const MCP_AUTH_GATE = Symbol.for("casefile.mcp-auth-gate");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Gate = ((req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>) & { [MCP_AUTH_GATE]: true };

export function createMcpAuthGate(db: postgres.Sql, opts: { auth: McpAuthConfig; limit: McpRateLimit }): Gate {
  const gate = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const tenantId = process.env.MATTER_TENANT_ID;
    const investigationId = process.env.MATTER_INVESTIGATION_ID;
    if (!tenantId || !investigationId) {
      return reply.status(500).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Server misconfiguration: MATTER_TENANT_ID and MATTER_INVESTIGATION_ID must be set" } });
    }

    if (opts.auth.mode === LOCAL_NO_LOGIN) {
      const forbidden = async (message: string) => {
        if (await opts.limit.refused(req, reply)) return reply;
        return reply.status(403).send({ jsonrpc: "2.0", id: null, error: { code: -32003, message: `Forbidden: ${message}` } });
      };
      const problem = localNoLoginRequestProblem(req);
      if (problem) return forbidden(problem);
      const userId = opts.auth.localUserId;
      if (!userId || !UUID.test(userId)) return forbidden("MCP_LOCAL_USER_ID does not name a user");
      const access = await withTenant(tenantId, (tx) => checkMcpEligibility(tx, { tenantId, investigationId, userId }), db);
      if (!access.ok) return forbidden(`the local user no longer has access to this matter: ${access.message}`);
      if (await opts.limit.allowed(req, reply, userId)) return reply;
      req.mcpCaller = {
        tenantId,
        investigationId,
        userId,
        sessionId: null,
        clientId: null,
        authMode: LOCAL_NO_LOGIN,
        effectiveRole: access.effectiveRole,
        workspaceId: access.workspaceId,
        workspaceRole: access.workspaceRole,
        investigationRole: access.investigationRole,
        ethicalWalls: access.ethicalWalls,
      };
      return undefined;
    }

    const oauth = resolveOAuthConfig(process.env);
    if ("error" in oauth) {
      return reply.status(500).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Server misconfiguration: ${oauth.error}` } });
    }

    const hint = `resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE_READ}"`;
    const refuse = async (message: string, error?: { code: "invalid_token" | "invalid_request"; description: string }) => {
      if (await opts.limit.refused(req, reply)) return reply;
      return reply
        .status(401)
        .header("www-authenticate", `Bearer ${hint}${error ? `, error="${error.code}", error_description="${error.description}"` : ""}`)
        .send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `Unauthorized: ${message}` } });
    };
    const invalid = (description: string) => refuse(description, { code: "invalid_token", description });

    // 1. Never from the query string, even alongside a valid header.
    if (new URL(req.url, "http://mcp.invalid").searchParams.has("access_token")) {
      return refuse("access tokens are accepted only in the Authorization header", {
        code: "invalid_request",
        description: "Access tokens are accepted only in the Authorization header",
      });
    }

    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer +(\S+)\s*$/i.exec(header) : null;
    if (!match) return refuse("sign in to use this connector");

    // 2-5. The token itself.
    let claims: JwtPayload;
    try {
      claims = verifyJwt(match[1]!);
    } catch {
      return invalid("The access token is invalid or has expired");
    }
    if (claims.aud !== oauth.resource) return invalid("The access token was not issued for this server");
    if (claims.tid !== tenantId) return invalid("The access token was not issued for this matter");
    if (typeof claims.sub !== "string" || typeof claims.sid !== "string" || !UUID.test(claims.sid) || typeof claims.cid !== "string") {
      return invalid("The access token is invalid or has expired");
    }
    if (!(claims.scope ?? "").split(" ").includes(SCOPE_READ)) {
      if (await opts.limit.refused(req, reply)) return reply;
      return reply
        .status(403)
        .header("www-authenticate", `Bearer error="insufficient_scope", ${hint}`)
        .send({ jsonrpc: "2.0", id: null, error: { code: -32003, message: `Forbidden: the access token lacks the ${SCOPE_READ} scope` } });
    }

    // 6-7. The session and the user, as they are now.
    const verdict = await withTenant(
      tenantId,
      async (tx) => {
        const sessions = await tx<{ user_id: string; is_revoked: boolean; live: boolean; audience: string | null; oauth_client_id: string | null }[]>`
          SELECT user_id, is_revoked, expires_at > NOW() AS live, audience, oauth_client_id
          FROM auth_sessions WHERE id = ${claims.sid} AND tenant_id = ${tenantId};
        `;
        const s = sessions[0];
        if (!s || s.user_id !== claims.sub || s.is_revoked || !s.live) return { ok: false as const, why: "This connection has been signed out" };
        if (s.audience !== oauth.resource || s.oauth_client_id === null || s.oauth_client_id !== claims.cid) {
          return { ok: false as const, why: "The access token does not belong to a connection to this server" };
        }
        const access = await checkMcpEligibility(tx, { tenantId, investigationId, userId: claims.sub });
        if (!access.ok) return { ok: false as const, why: "This account no longer has access to this matter" };
        return { ok: true as const, access };
      },
      db,
    );
    if (!verdict.ok) return invalid(verdict.why);
    if (await opts.limit.allowed(req, reply, claims.sub)) return reply;

    req.mcpCaller = {
      tenantId,
      investigationId,
      userId: claims.sub,
      sessionId: claims.sid,
      clientId: claims.cid,
      authMode: "oauth",
      effectiveRole: verdict.access.effectiveRole,
      workspaceId: verdict.access.workspaceId,
      workspaceRole: verdict.access.workspaceRole,
      investigationRole: verdict.access.investigationRole,
      ethicalWalls: verdict.access.ethicalWalls,
    };
    return undefined;
  };
  return Object.assign(gate, { [MCP_AUTH_GATE]: true as const });
}

/** True for a function made by createMcpAuthGate. */
export function isMcpAuthGate(fn: unknown): boolean {
  return typeof fn === "function" && Reflect.get(fn, MCP_AUTH_GATE) === true;
}
