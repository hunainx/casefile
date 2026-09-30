import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import postgres from "postgres";
import { getDbUrl, createDbClient, withTenant, type Tx } from "@casefile/db";
import {
  evaluatePermission,
  createPolicyDenialAuditEvent,
  PermissionDeniedError,
  type WorkspaceRole,
} from "@casefile/policy";
import { writeAuditEvent } from "@casefile/audit";
import { verifyJwt } from "./auth/crypto.js";
import { AuthError } from "./auth/service.js";
import { authRoutes } from "./routes/auth.js";
import { organizationRoutes } from "./routes/organizations.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { investigationRoutes } from "./routes/investigations.js";
import { sourceRoutes } from "./routes/sources.js";
import { assertionRoutes } from "./routes/assertions.js";
import { entityRoutes } from "./routes/entities.js";
import { relationshipRoutes } from "./routes/relationships.js";
import { auditRoutes } from "./routes/audit.js";
import { healthRoutes, unhealthy } from "./routes/health.js";
import { breakGlassRoutes } from "./routes/break-glass.js";
import { searchRoutes } from "./routes/search.js";
import { memoryRoutes } from "./routes/memory.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { aiRoutes } from "./routes/ai.js";
import { contradictionRoutes } from "./routes/contradictions.js";
import { gapRoutes } from "./routes/gaps.js";
import { mcpRoutes } from "./routes/mcp.js";
import { createMcpAuthGate } from "./mcp/auth.js";
import { mcpAuthConfigForApp } from "./mcp/local-mode.js";
import { oauthRoutes } from "./routes/oauth.js";
import { accountSetupRoutes } from "./routes/account-setup.js";
import { resolveOAuthConfig } from "./oauth/config.js";
import { createCimdFetcher, type CimdTransport } from "./oauth/cimd.js";
import { createMcpRateLimit, createRateLimiter, resolveRateLimitScale, resolveRuleLimits, type RateLimitOptions } from "./rate-limit.js";

export interface BuildAppOptions {
  db?: postgres.Sql;
  /** true: log to stdout. A stream: log there (tests read the request log lines). */
  logger?: boolean | { stream: NodeJS.WritableStream };
  /** Overrides for the D66 rate limits (tests only; production uses the defaults). */
  rateLimit?: RateLimitOptions;
  /**
   * Test hooks for the OAuth server (D69). Code-only on purpose: nothing in the environment
   * can switch them on, so a production deployment cannot be pointed at a fake client
   * metadata server. The transport replaces only the network: every CIMD check still runs.
   */
  oauth?: { cimdTransport?: CimdTransport; cimdTimeoutMs?: number };
}

/**
 * How many reverse proxies to trust for the client address. Cloud Run puts exactly one in
 * front of the service and appends the real client address to X-Forwarded-For, so one hop
 * is trusted there; a client-supplied X-Forwarded-For value is ignored. Elsewhere the socket
 * address is used unless TRUST_PROXY_HOPS says otherwise.
 */
function resolveTrustProxy(env: NodeJS.ProcessEnv): false | ((address: string, hop: number) => boolean) {
  const raw = env.TRUST_PROXY_HOPS;
  let hops = env.K_SERVICE ? 1 : 0;
  if (raw !== undefined && raw !== "") {
    hops = Number(raw);
    if (!Number.isInteger(hops) || hops < 0) throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer, got '${raw}'`);
  }
  if (hops === 0) return false;
  // Trust exactly the nearest `hops` proxies (hop 0 is the socket peer).
  return (_address, hop) => hop < hops;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  // Resolve limits first: an unsafe RATE_LIMIT_SCALE must stop the process before it serves.
  const rateLimits = resolveRuleLimits(opts.rateLimit, resolveRateLimitScale(process.env));
  // D77: the /mcp auth mode. Local no-login mode cannot even be built on a non-loopback host,
  // on Cloud Run or in production (apps/api/src/server.ts also checks the user at startup).
  const mcpAuth = mcpAuthConfigForApp(process.env);
  const db = opts.db || createDbClient(getDbUrl());

  const app = Fastify({
    logger: typeof opts.logger === "object" ? { stream: opts.logger.stream } : (opts.logger ?? false),
    trustProxy: resolveTrustProxy(process.env),
    genReqId: (req) => (req.headers["x-request-id"] as string) || `req_${randomUUID().replace(/-/g, "")}`,
  });

  app.register(cors, { origin: true });

  /**
   * Runs a route inside its tenant transaction and puts the response on the wire only
   * after that transaction has committed (D64).
   *
   * Handlers call `reply.send()` inside the transaction. Sent directly, the response left
   * before COMMIT: a client — or the very next request — could see a 200 for a write that
   * was not yet visible, or that then failed to commit. REQ-WS-03 and AC-EPI-01 failed
   * intermittently on exactly that. Here `reply.send()` only records the payload; it is
   * sent once `withTenant` resolves. If the handler throws, the transaction rolls back and
   * the recorded payload is discarded, so the error handler answers instead.
   *
   * A Fastify reply is also thenable: `reply.then` resolves once the response has been
   * sent. Handlers `return reply.send(...)`, so inside the transaction their promise would
   * adopt the reply and wait for a response that is itself waiting for the transaction.
   * `then` is therefore hidden until the transaction has settled.
   */
  async function inTenantTxThenReply<T>(
    reply: FastifyReply,
    tenantId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T | FastifyReply> {
    const ownSend = Object.getOwnPropertyDescriptor(reply, "send");
    const ownThen = Object.getOwnPropertyDescriptor(reply, "then");
    const send = reply.send;
    let deferred: { payload: unknown } | undefined;
    Object.defineProperty(reply, "send", {
      configurable: true,
      writable: true,
      value: function (this: FastifyReply, payload?: unknown) {
        deferred = { payload };
        return this;
      },
    });
    Object.defineProperty(reply, "then", { configurable: true, writable: true, value: undefined });
    let result: T;
    try {
      result = await withTenant(tenantId, fn, db);
    } finally {
      Reflect.deleteProperty(reply, "send");
      Reflect.deleteProperty(reply, "then");
      if (ownSend) Object.defineProperty(reply, "send", ownSend);
      if (ownThen) Object.defineProperty(reply, "then", ownThen);
    }
    return deferred ? send.call(reply, deferred.payload) : result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Request ID & JWT Authentication Extraction Hook
  // ─────────────────────────────────────────────────────────────────────────
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const payload = verifyJwt(token);
        // A token with an audience was issued for /mcp by the OAuth server (D69). It is never
        // a REST credential: the request continues unauthenticated, so REST routes answer 401.
        if (payload.aud !== undefined) return;
        req.user = {
          userId: payload.sub,
          tenantId: payload.tid,
          sessionId: payload.sid,
          roles: payload.roles as WorkspaceRole[],
          mfa: payload.mfa,
          stepUpAt: payload.stepUpAt,
        };
      } catch {
        // Leave req.user undefined for auth check to handle
      }
    }
  });

  // Rate limits (D66). preHandler, not onRequest, so per-account keys can read the parsed
  // body; it still runs before every route's handler and its tenant transaction.
  app.addHook("preHandler", createRateLimiter(db, rateLimits));

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Architecture Gate: Route Registration Check & Tenant Transaction Wrapper
  // ─────────────────────────────────────────────────────────────────────────
  app.addHook("onRoute", (routeOptions) => {
    if (
      routeOptions.method === "OPTIONS" ||
      (Array.isArray(routeOptions.method) && routeOptions.method.includes("OPTIONS"))
    ) {
      return;
    }

    const config = routeOptions.config;
    if (!config?.public && !config?.permission && !config?.authenticated) {
      throw new Error(
        `Route registration denied: '${routeOptions.method} ${routeOptions.url}' must declare 'permission', 'authenticated: true', or 'public: true'.`,
      );
    }

    const originalHandler = routeOptions.handler;
    routeOptions.handler = async function (req, reply) {
      // 1. Public Routes: run inside tenant context if available, or generated tenant ID
      if (config?.public) {
        let parsedBody = req.body;
        if (typeof parsedBody === "string") {
          try {
            parsedBody = JSON.parse(parsedBody);
          } catch {
            // ignore
          }
        }
        const body = parsedBody as Record<string, unknown> | undefined;
        const query = req.query as Record<string, unknown> | undefined;
        let tenantId =
          (typeof body?.tenantId === "string" ? body.tenantId : undefined) ||
          (typeof query?.tenantId === "string" ? query.tenantId : undefined) ||
          req.user?.tenantId;

        if (!tenantId && typeof body?.refreshToken === "string" && body.refreshToken.includes("_")) {
          tenantId = body.refreshToken.split("_")[0];
        }

        // One deployment serves one matter: /mcp and the OAuth pages always run as its tenant,
        // whatever a request body or query says.
        if (
          req.url === "/mcp" ||
          req.url.startsWith("/mcp/") ||
          req.url.startsWith("/mcp?") ||
          req.url.startsWith("/oauth/") ||
          req.url.startsWith("/.well-known/") ||
          req.url.startsWith("/account/")
        ) {
          tenantId = process.env.MATTER_TENANT_ID || tenantId;
        }

        if (!tenantId) {
          tenantId = randomUUID();
        }

        if (req.url === "/healthz" || req.url.startsWith("/healthz/") || req.url.startsWith("/healthz?")) {
          try {
            return await inTenantTxThenReply(
              reply,
              tenantId,
              async (tx: Tx) => {
                req.tx = tx;
                return await originalHandler.call(this, req, reply);
              },
            );
          } catch (err) {
            return unhealthy(req, reply, err);
          }
        }

        return await inTenantTxThenReply(
          reply,
          tenantId,
          async (tx: Tx) => {
            req.tx = tx;
            return await originalHandler.call(this, req, reply);
          },
        );
      }

      // 2. Authenticated Routes: require valid JWT
      if (!req.user) {
        throw new AuthError("Authentication required", "UNAUTHORIZED", 401);
      }

      const tenantId = req.user.tenantId;

      return await inTenantTxThenReply(
        reply,
        tenantId,
        async (tx: Tx) => {
          req.tx = tx;

          // Step-Up MFA Re-Authentication Enforcement (D51)
          if (config?.requiresStepUp) {
            if (!req.user!.stepUpAt || Date.now() - new Date(req.user!.stepUpAt).getTime() > 5 * 60 * 1000) {
              throw new AuthError(
                "Fresh step-up MFA verification required for this high-risk operation",
                "STEP_UP_MFA_REQUIRED",
                403,
              );
            }
          }

          // Policy Enforcement via @casefile/policy (PRD §38)
          if (config?.permission) {
            const roles = req.user!.roles && req.user!.roles.length > 0 ? req.user!.roles : (["viewer"] as const);
            const targetObjectId = config.resourceIdParam
              ? (req.params as Record<string, string>)[config.resourceIdParam]
              : undefined;

            let allowed = false;
            let lastResult: ReturnType<typeof evaluatePermission> | null = null;

            for (const role of roles) {
              const res = evaluatePermission({
                tenantId,
                userId: req.user!.userId,
                permission: config.permission,
                workspaceRole: role,
                requestId: req.id,
                targetObjectId: targetObjectId || null,
                targetObjectType: config.resourceType || null,
              });
              if (res.allowed) {
                allowed = true;
                break;
              }
              lastResult = res;
            }

            if (!allowed) {
              if (lastResult) {
                const denialEvent = createPolicyDenialAuditEvent(
                  {
                    tenantId,
                    userId: req.user!.userId,
                    permission: config.permission,
                    workspaceRole: roles[0],
                    requestId: req.id,
                    targetObjectId: targetObjectId || null,
                    targetObjectType: config.resourceType || null,
                  },
                  lastResult,
                );
                try {
                  await writeAuditEvent(tx, denialEvent);
                } catch {
                  // Ignore audit write failure on denial path
                }
              }
              throw new PermissionDeniedError(lastResult?.reason || "permission_denied");
            }
          }

          // Idempotency Key Handling (PRD §45.1)
          const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
          if (idempotencyKey && (req.method === "POST" || req.method === "PATCH")) {
            req.idempotencyKey = idempotencyKey;
            const cached = await tx<{
              status_code: number;
              headers: Record<string, string>;
              response_body: Record<string, unknown>;
            }[]>`
              SELECT status_code, headers, response_body
              FROM idempotency_keys
              WHERE tenant_id = ${tenantId} AND key = ${idempotencyKey};
            `;

            if (cached.length > 0) {
              const hit = cached[0]!;
              if (hit.headers) {
                for (const [k, v] of Object.entries(hit.headers)) {
                  reply.header(k, v);
                }
              }
              return reply.status(hit.status_code).send(hit.response_body);
            }
          }

          return await originalHandler.call(this, req, reply);
        },
      );
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Idempotency Key Storage Hook
  // ─────────────────────────────────────────────────────────────────────────
  app.addHook("onSend", async (req, reply, payload) => {
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    if (idempotencyKey && req.user && reply.statusCode >= 200 && reply.statusCode < 300) {
      try {
        const body = typeof payload === "string" ? JSON.parse(payload) : payload;
        await withTenant(
          req.user.tenantId,
          async (tx) => {
            await tx`
              INSERT INTO idempotency_keys (key, tenant_id, user_id, status_code, response_body)
              VALUES (${idempotencyKey}, ${req.user!.tenantId}, ${req.user!.userId}, ${reply.statusCode}, ${tx.json(body)})
              ON CONFLICT (tenant_id, key) DO NOTHING;
            `;
          },
          db,
        );
      } catch {
        // Ignore cache save error
      }
    }
    return payload;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Global RFC 9457 Problem Details Error Handler (PRD §45.4)
  // ─────────────────────────────────────────────────────────────────────────
  // FINAL (DEV-046): a server error's own text (a database message, a table name, a host) never goes to the
  // caller, in any environment: the caller gets a generic message and the request ID, and the full error is
  // logged with that ID. A client error (4xx) keeps its message: it says what was wrong with the request.
  const UNEXPECTED = "An unexpected error occurred. Quote the request ID if you report it.";
  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    if (req.url === "/healthz" || req.url.startsWith("/healthz/") || req.url.startsWith("/healthz?")) {
      return unhealthy(req, reply, error);
    }

    let status = 500;
    let type = "https://docs.casefile.com/errors/internal-error";
    let title = "Internal Server Error";
    let detail = UNEXPECTED;

    if (error instanceof PermissionDeniedError) {
      status = 403;
      type = "https://docs.casefile.com/errors/permission-denied";
      title = "Forbidden";
      detail = "Access denied";
    } else if (error instanceof AuthError) {
      status = error.status;
      type = `https://docs.casefile.com/errors/${error.code.toLowerCase().replace(/_/g, "-")}`;
      title = error.code === "UNAUTHORIZED" ? "Unauthorized" : "Authentication Failed";
      detail = error.message;
    } else if (error.statusCode) {
      status = error.statusCode;
      title = error.name || "Request Error";
      type = `https://docs.casefile.com/errors/http-${status}`;
      if (status < 500) detail = error.message || detail;
    }
    if (status >= 500) req.log.error({ err: error, request_id: req.id }, "unexpected error");

    return reply.status(status).header("content-type", "application/problem+json").send({
      type,
      title,
      status,
      detail,
      instance: req.url,
      request_id: req.id,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Register Routes
  // ─────────────────────────────────────────────────────────────────────────
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(organizationRoutes);
  app.register(workspaceRoutes);
  app.register(investigationRoutes);
  app.register(sourceRoutes);
  app.register(assertionRoutes);
  app.register(entityRoutes);
  app.register(relationshipRoutes);
  app.register(auditRoutes);
  app.register(breakGlassRoutes);
  app.register(searchRoutes);
  app.register(memoryRoutes);
  app.register(evidenceRoutes);
  app.register(aiRoutes);
  app.register(contradictionRoutes);
  app.register(gapRoutes);
  app.register(mcpRoutes, { authGate: createMcpAuthGate(db, { auth: mcpAuth, limit: createMcpRateLimit(db, rateLimits.mcp) }) });

  const oauthConfig = resolveOAuthConfig(process.env);
  const cimd = createCimdFetcher({
    trustedClients: "error" in oauthConfig ? [] : oauthConfig.trustedClients,
    transport: opts.oauth?.cimdTransport,
    timeoutMs: opts.oauth?.cimdTimeoutMs,
  });
  app.register(oauthRoutes, { oauth: oauthConfig, cimd });
  app.register(accountSetupRoutes, { oauth: oauthConfig });

  return app;
}
