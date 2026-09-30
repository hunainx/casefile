import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { verifyJwt } from "./auth/crypto.js";
import { MFA_CHALLENGE_AUDIENCE } from "./auth/service.js";

/**
 * Request rate limits (D66).
 *
 * Counters live in Postgres (`rate_limit_counters`, migration 0025) because it is the one
 * store every deployment already has, and it is shared by all Cloud Run instances. Each
 * window starts at the first hit for a key and lasts `windowSeconds`; within it at most
 * `perIp` requests per client address and `perAccount` per account are allowed. A blocked
 * request gets 429 with Retry-After. No rate-limit headers are sent otherwise.
 */

export type RuleName = "login" | "password_reset" | "oauth_token" | "general" | "mcp";

export interface RuleLimits {
  windowSeconds: number;
  /** Requests per client IP address within the window. */
  perIp: number;
  /** Requests per account within the window (for `general`: per signed-in user). */
  perAccount: number;
}

export interface RateLimitOptions {
  /** Per-rule overrides, used by tests to observe thresholds with small numbers. */
  rules?: Partial<Record<RuleName, Partial<RuleLimits>>>;
}

/**
 * Production limits.
 * - login: sign-in, second-factor and passkey verification.
 * - password_reset: reset request and confirm.
 * - oauth_token: the OAuth token endpoint (MCP sign-in, Phase 1). It is called from
 *   Anthropic's shared egress range, so its per-IP limit is generous and the per-account
 *   limit does the real work.
 * - general: every other route; keyed by user when signed in, by IP otherwise.
 * - mcp: /mcp and /mcp/, counted by the /mcp auth gate rather than the global hook (D78):
 *   per account once the gate has identified the caller, per IP only for requests that fail
 *   the gate. Claude reaches /mcp from Anthropic's shared egress range, so an address stands
 *   for many people; the per-IP limit is generous and only junk and sign-in prompts count.
 */
export const DEFAULT_RULE_LIMITS: Readonly<Record<RuleName, RuleLimits>> = {
  login: { windowSeconds: 15 * 60, perIp: 30, perAccount: 10 },
  password_reset: { windowSeconds: 60 * 60, perIp: 10, perAccount: 5 },
  oauth_token: { windowSeconds: 15 * 60, perIp: 300, perAccount: 30 },
  general: { windowSeconds: 60, perIp: 300, perAccount: 600 },
  mcp: { windowSeconds: 60, perIp: 600, perAccount: 600 },
};

const LOGIN_ROUTES = new Set([
  "/v1/auth/token",
  "/v1/auth/mfa/verify",
  "/v1/auth/step-up",
  "/v1/auth/webauthn/authenticate/verify",
]);
const PASSWORD_RESET_ROUTES = new Set(["/v1/auth/password-reset/request", "/v1/auth/password-reset/confirm"]);
const OAUTH_TOKEN_ROUTES = new Set(["/oauth/token"]);
/** Platform probes are never limited: they must keep answering while the service is under load. */
const EXEMPT_ROUTES = new Set(["/health", "/healthz", "/ready"]);
/** Counted by the /mcp auth gate once it knows whether the request is signed in (D78). */
const MCP_ROUTES = new Set(["/mcp", "/mcp/"]);

/** Form posts of the OAuth sign-in page and the one-time setup link (D69, D71); their GETs are general. */
const LOGIN_FORM_POSTS = new Set(["/oauth/authorize"]);
const SETUP_FORM_POSTS = new Set(["/account/setup"]);

function ruleFor(routePath: string, method: string): RuleName | null {
  if (EXEMPT_ROUTES.has(routePath) || MCP_ROUTES.has(routePath)) return null;
  if (LOGIN_ROUTES.has(routePath)) return "login";
  if (method === "POST" && LOGIN_FORM_POSTS.has(routePath)) return "login";
  if (PASSWORD_RESET_ROUTES.has(routePath)) return "password_reset";
  if (method === "POST" && SETUP_FORM_POSTS.has(routePath)) return "password_reset";
  if (OAUTH_TOKEN_ROUTES.has(routePath)) return "oauth_token";
  return "general";
}

function field(body: unknown, name: string): string | undefined {
  if (typeof body !== "object" || body === null || !(name in body)) return undefined;
  const value: unknown = (body as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The account a request is about, if it names one. Emails are case-folded. */
function accountFor(rule: RuleName, routePath: string, req: FastifyRequest): string | undefined {
  const body: unknown = typeof req.body === "string" ? safeJson(req.body) : req.body;
  if (rule === "general") return req.user?.userId ? `user:${req.user.userId}` : undefined;
  if (routePath === "/v1/auth/password-reset/confirm" || routePath === "/account/setup") {
    const token = field(body, "token");
    return token ? `reset-token:${token}` : undefined;
  }
  if (rule === "oauth_token") {
    const secret = field(body, "refresh_token") ?? field(body, "code");
    return secret ? `oauth-grant:${secret}` : undefined;
  }
  if (routePath === "/v1/auth/mfa/verify") {
    // The account is the one the challenge token names (D75); a forged or expired token has none.
    const sub = challengeSubject(field(body, "challengeToken"));
    return sub ? `user:${sub}` : undefined;
  }
  if (req.user?.userId) return `user:${req.user.userId}`;
  const email = field(body, "email");
  return email ? `email:${email.trim().toLowerCase()}` : undefined;
}

function challengeSubject(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const claims = verifyJwt(token);
    return claims.aud === MFA_CHALLENGE_AUDIENCE ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** The counter key for a rule and subject ("ip:<address>", "email:<address>", "user:<id>", …). */
export function rateLimitBucketKey(rule: RuleName, subject: string): string {
  return digest(`${rule}|${subject}`);
}

/**
 * RATE_LIMIT_SCALE multiplies every limit. It exists so the test suite, which signs in
 * hundreds of times from one address, can run with limits active; it is refused anywhere
 * that could be production.
 */
export function resolveRateLimitScale(env: NodeJS.ProcessEnv): number {
  const raw = env.RATE_LIMIT_SCALE;
  if (raw === undefined || raw === "") return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale < 1) {
    throw new Error(`RATE_LIMIT_SCALE must be a number >= 1, got '${raw}'`);
  }
  if (scale !== 1 && (env.K_SERVICE || env.NODE_ENV === "production")) {
    throw new Error(
      "RATE_LIMIT_SCALE is set on Cloud Run or with NODE_ENV=production. It only exists for the " +
        "test suite and would weaken production rate limits. Refusing to start.",
    );
  }
  return scale;
}

export function resolveRuleLimits(options: RateLimitOptions | undefined, scale: number): Record<RuleName, RuleLimits> {
  const out = {} as Record<RuleName, RuleLimits>;
  for (const name of Object.keys(DEFAULT_RULE_LIMITS) as RuleName[]) {
    const base = DEFAULT_RULE_LIMITS[name];
    const override = options?.rules?.[name];
    out[name] = override
      ? { ...base, ...override }
      : { windowSeconds: base.windowSeconds, perIp: base.perIp * scale, perAccount: base.perAccount * scale };
  }
  return out;
}

interface CounterRow {
  bucket_key: string;
  hits: number;
  reset_in: number;
}

/**
 * Returns an onRequest-style hook (registered as preHandler so the body is parsed) that
 * counts the request against its rule and answers 429 when a limit is exceeded.
 * If the counter store fails, general requests are let through (the route needs the same
 * database and fails on its own), while sign-in, reset and token requests are refused with
 * 503: a limiter fault must never quietly remove the limits that matter most.
 */
export function createRateLimiter(db: postgres.Sql, limits: Record<RuleName, RuleLimits>) {
  return async function rateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const routePath = req.routeOptions.url ?? req.url.split("?")[0] ?? "";
    const rule = ruleFor(routePath, req.method);
    if (!rule) return;
    const cfg = limits[rule];

    const buckets: Array<{ key: string; limit: number }> = [];
    const account = accountFor(rule, routePath, req);
    if (rule === "general" && account) {
      buckets.push({ key: rateLimitBucketKey(rule, account), limit: cfg.perAccount });
    } else {
      buckets.push({ key: rateLimitBucketKey(rule, `ip:${req.ip}`), limit: cfg.perIp });
      if (account) buckets.push({ key: rateLimitBucketKey(rule, account), limit: cfg.perAccount });
    }

    let retryAfter: number;
    try {
      retryAfter = await countHits(db, cfg.windowSeconds, buckets);
    } catch (err) {
      if (rule === "general") {
        req.log.error({ err: (err as Error).message }, "rate limiter unavailable; general request allowed");
        return;
      }
      // Sign-in, reset and token requests fail closed: they need this database anyway, and a
      // limiter fault must never quietly switch their limits off.
      req.log.error({ err: (err as Error).message }, "rate limiter unavailable; sensitive request refused");
      await reply.status(503).header("retry-after", "5").send({
        type: "https://docs.casefile.com/errors/service-unavailable",
        title: "Service Unavailable",
        status: 503,
        detail: "Rate limiting is temporarily unavailable. Try again shortly.",
        request_id: req.id,
      });
      return;
    }
    if (retryAfter === 0) return;
    await tooMany(req, reply, retryAfter);
  };
}

/**
 * Counts one hit in each bucket and returns the Retry-After for the most exhausted one, or 0
 * when every bucket is within its limit. Windows are measured on the database clock.
 */
async function countHits(db: postgres.Sql, windowSeconds: number, buckets: Array<{ key: string; limit: number }>): Promise<number> {
  const rows = await db<CounterRow[]>`
        INSERT INTO rate_limit_counters (bucket_key, window_start, window_seconds, hits, updated_at)
        SELECT k, NOW(), ${windowSeconds}, 1, NOW()
        -- Keys are hex digests, so a comma-joined text value is unambiguous. (Written this way
        -- after an array parameter was seen malformed on a new client's first query. The
        -- driver fault behind that affects postgres.js's array helper only, which is banned
        -- by guardrail; a plain array parameter is safe. See D68.)
        FROM unnest(string_to_array(${buckets.map((b) => b.key).join(",")}::text, ',')) AS t(k)
        ON CONFLICT (bucket_key) DO UPDATE SET
          hits = CASE
            WHEN rate_limit_counters.window_start + make_interval(secs => EXCLUDED.window_seconds) <= NOW() THEN 1
            ELSE rate_limit_counters.hits + 1
          END,
          window_start = CASE
            WHEN rate_limit_counters.window_start + make_interval(secs => EXCLUDED.window_seconds) <= NOW() THEN NOW()
            ELSE rate_limit_counters.window_start
          END,
          window_seconds = EXCLUDED.window_seconds,
          updated_at = NOW()
        RETURNING bucket_key, hits,
          EXTRACT(EPOCH FROM (window_start + make_interval(secs => window_seconds) - NOW()))::float8 AS reset_in;
      `;
  const limitByKey = new Map(buckets.map((b) => [b.key, b.limit]));
  let retryAfter = 0;
  for (const row of rows) {
    const limit = limitByKey.get(row.bucket_key) ?? Number.POSITIVE_INFINITY;
    if (row.hits > limit) retryAfter = Math.max(retryAfter, Math.max(1, Math.ceil(row.reset_in)));
  }
  return retryAfter;
}

async function tooMany(req: FastifyRequest, reply: FastifyReply, retryAfter: number): Promise<void> {
  await reply
    .status(429)
    .header("retry-after", String(retryAfter))
    .send({
      type: "https://docs.casefile.com/errors/rate-limited",
      title: "Too Many Requests",
      status: 429,
      detail: `Rate limit exceeded. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
      request_id: req.id,
    });
}

/**
 * The /mcp limits (D78), used by the /mcp auth gate. `refused` counts a request the gate is
 * about to refuse against its client address; `allowed` counts a request from an identified
 * caller against that user only. Each answers 429 itself and returns true when over the limit.
 * Like `general`, a counter-store fault lets the request through (logged): the gate has just
 * needed the same database, and fails on its own if it is down.
 */
export function createMcpRateLimit(db: postgres.Sql, cfg: RuleLimits) {
  const check = async (req: FastifyRequest, reply: FastifyReply, bucket: { key: string; limit: number }): Promise<boolean> => {
    let retryAfter: number;
    try {
      retryAfter = await countHits(db, cfg.windowSeconds, [bucket]);
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "rate limiter unavailable; /mcp request allowed");
      return false;
    }
    if (retryAfter === 0) return false;
    await tooMany(req, reply, retryAfter);
    return true;
  };
  return {
    refused: (req: FastifyRequest, reply: FastifyReply) => check(req, reply, { key: rateLimitBucketKey("mcp", `ip:${req.ip}`), limit: cfg.perIp }),
    allowed: (req: FastifyRequest, reply: FastifyReply, userId: string) => check(req, reply, { key: rateLimitBucketKey("mcp", `user:${userId}`), limit: cfg.perAccount }),
  };
}

export type McpRateLimit = ReturnType<typeof createMcpRateLimit>;
