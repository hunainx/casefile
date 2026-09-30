import type { FastifyRequest } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@casefile/db";
import { checkLocalMcpUser } from "@casefile/mcp";

/**
 * MCP_AUTH_MODE and the explicit local no-login mode (docs/PLAN-MCP-AUTH.md section 5, D77).
 *
 * This is the ONLY module that reads MCP_AUTH_MODE or names the "local-no-login" value;
 * guardrails/mcp-auth.spec.ts fails if any other production module does. Everything that
 * decides whether the mode may run is here, next to that read:
 *
 * - resolveMcpAuthMode: "oauth" (the default, also when unset) or "local-no-login"; any other
 *   value refuses to start.
 * - localNoLoginEnvProblems / assertLocalNoLoginAllowed: at startup the mode refuses to run
 *   (FATAL, the process exits) unless HOST is 127.0.0.1, ::1 or localhost; K_SERVICE is unset;
 *   NODE_ENV is not production; MCP_PUBLIC_URL is unset or loopback; and MCP_LOCAL_USER_ID
 *   names an existing active user of MATTER_TENANT_ID who passes checkMcpEligibility.
 *   buildApp() repeats the environment checks, so the app cannot be built in this mode on a
 *   server either.
 * - localNoLoginRequestProblem: on every request the socket's remote address must be loopback
 *   AND the Host header must be localhost or 127.0.0.1 (with or without a port), else 403 —
 *   the DNS-rebinding guard.
 *
 * The mode does not bypass anything else: requests still go through the /mcp auth gate, which
 * re-runs the eligibility check on every request, and every tool call gets the same role check
 * and audit row, marked with this mode.
 */

export const LOCAL_NO_LOGIN = "local-no-login";
export type McpAuthMode = "oauth" | typeof LOCAL_NO_LOGIN;

export type McpAuthConfig =
  | { mode: "oauth" }
  | { mode: typeof LOCAL_NO_LOGIN; localUserId: string | undefined };

/** The configured mode, or why MCP_AUTH_MODE is unusable. */
export function resolveMcpAuthMode(env: NodeJS.ProcessEnv): McpAuthConfig | { error: string } {
  const raw = env.MCP_AUTH_MODE;
  if (raw === undefined || raw.trim() === "" || raw === "oauth") return { mode: "oauth" };
  if (raw === LOCAL_NO_LOGIN) return { mode: LOCAL_NO_LOGIN, localUserId: env.MCP_LOCAL_USER_ID?.trim() || undefined };
  return { error: `MCP_AUTH_MODE is '${raw}'; it must be 'oauth' (the default) or '${LOCAL_NO_LOGIN}'` };
}

/**
 * The mode buildApp() uses. Throws on an unusable MCP_AUTH_MODE, and on local no-login mode
 * when any environment condition fails, so the app cannot be built that way on a server.
 */
export function mcpAuthConfigForApp(env: NodeJS.ProcessEnv): McpAuthConfig {
  const mode = resolveMcpAuthMode(env);
  if ("error" in mode) throw new Error(mode.error);
  if (mode.mode === LOCAL_NO_LOGIN) {
    const problems = localNoLoginEnvProblems(env);
    if (problems.length > 0) throw new Error(`MCP_AUTH_MODE=${LOCAL_NO_LOGIN} refused: ${problems.join("; ")}`);
  }
  return mode;
}

/** True when the API runs in local no-login mode (an unusable MCP_AUTH_MODE is not). */
export function isLocalNoLogin(env: NodeJS.ProcessEnv): boolean {
  const mode = resolveMcpAuthMode(env);
  return !("error" in mode) && mode.mode === LOCAL_NO_LOGIN;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** The startup conditions that need no database, one line each. Empty when all hold. */
export function localNoLoginEnvProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const host = env.HOST;
  if (host === undefined || host.trim() === "") {
    problems.push("HOST is unset, so the API would listen on 0.0.0.0; set HOST to 127.0.0.1, ::1 or localhost");
  } else if (!LOOPBACK_HOSTS.has(host.trim().toLowerCase())) {
    problems.push(`HOST is '${host}'; it must be 127.0.0.1, ::1 or localhost`);
  }
  if (env.K_SERVICE !== undefined && env.K_SERVICE !== "") problems.push(`K_SERVICE is set ('${env.K_SERVICE}'): this is Cloud Run`);
  if (env.NODE_ENV === "production") problems.push("NODE_ENV is 'production'");
  const url = env.MCP_PUBLIC_URL;
  if (url !== undefined && url.trim() !== "" && !isLoopbackUrl(url)) {
    problems.push(`MCP_PUBLIC_URL is '${url}'; it must be unset or a loopback URL`);
  }
  return problems;
}

export interface LocalUser {
  userId: string;
  email: string;
  role: string;
}

/**
 * Every startup condition, including the user check against the database. Returns the user
 * when the mode may run.
 */
export async function localNoLoginStartupProblems(env: NodeJS.ProcessEnv, db: postgres.Sql): Promise<{ problems: string[]; user?: LocalUser }> {
  const problems = localNoLoginEnvProblems(env);
  const tenantId = env.MATTER_TENANT_ID;
  const investigationId = env.MATTER_INVESTIGATION_ID;
  if (!tenantId || !investigationId) {
    problems.push("MATTER_TENANT_ID and MATTER_INVESTIGATION_ID must be set");
    return { problems };
  }
  const check = await withTenant(tenantId, (tx) => checkLocalMcpUser(tx, { tenantId, investigationId, userId: env.MCP_LOCAL_USER_ID }), db);
  if (!check.ok) {
    problems.push(check.problem);
    return { problems };
  }
  return { problems, user: { userId: env.MCP_LOCAL_USER_ID!.trim(), email: check.email, role: check.access.effectiveRole } };
}

/** Refuses to start (FATAL on stderr, exit 1) on an unusable MCP_AUTH_MODE. */
export function assertMcpAuthModeValid(env: NodeJS.ProcessEnv = process.env): McpAuthMode {
  const mode = resolveMcpAuthMode(env);
  if ("error" in mode) {
    process.stderr.write(`FATAL: ${mode.error}. The API refuses to start.\n`);
    process.exit(1);
  }
  return mode.mode;
}

/**
 * The startup gate for local no-login mode, run by apps/api/src/server.ts before listening.
 * Does nothing in oauth mode. Otherwise every failed condition is written to stderr in one
 * FATAL line and the process exits; when all hold, the banner is printed.
 */
export async function assertLocalNoLoginAllowed(env: NodeJS.ProcessEnv, db: postgres.Sql): Promise<void> {
  if (!isLocalNoLogin(env)) return;
  const { problems, user } = await localNoLoginStartupProblems(env, db);
  if (problems.length > 0 || !user) {
    process.stderr.write(`FATAL: MCP_AUTH_MODE=${LOCAL_NO_LOGIN} refused: ${problems.join("; ")}. The API refuses to start.\n`);
    await db.end({ timeout: 1 });
    process.exit(1);
  }
  process.stderr.write(localNoLoginBanner(user, env));
}

export function localNoLoginBanner(user: LocalUser, env: NodeJS.ProcessEnv): string {
  const line = "!".repeat(88);
  return [
    "",
    line,
    "!!",
    `!!   LOCAL NO-LOGIN MODE  (MCP_AUTH_MODE=${LOCAL_NO_LOGIN})`,
    "!!",
    "!!   /mcp answers WITHOUT sign-in. Every request runs as:",
    `!!     user  ${user.userId}  (${user.email})`,
    `!!     role  ${user.role}   matter tenant ${env.MATTER_TENANT_ID}`,
    "!!",
    "!!   Only this computer is served: loopback address AND Host localhost or 127.0.0.1.",
    "!!   Anything else gets 403. Every audit row is marked local-no-login.",
    "!!   For Claude Code, MCP Inspector and tests on this machine only. Never on a server.",
    "!!",
    line,
    "",
    "",
  ].join("\n");
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

/** Host header: exactly localhost or 127.0.0.1, optionally with a numeric port. */
function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const m = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(host.trim().toLowerCase());
  return m !== null && (m[1] === "localhost" || m[1] === "127.0.0.1");
}

/**
 * Why a request may not be served in local no-login mode, or null. Uses the socket's own peer
 * address, never X-Forwarded-For, and the raw Host header.
 */
export function localNoLoginRequestProblem(req: FastifyRequest): string | null {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return "local no-login mode serves only this computer (the request did not come from a loopback address)";
  if (!isLocalHostHeader(req.headers.host)) return "local no-login mode serves only Host localhost or 127.0.0.1";
  return null;
}
