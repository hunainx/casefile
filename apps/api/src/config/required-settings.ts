import { resolveOAuthConfig } from "../oauth/config.js";
import { isLocalNoLogin } from "../mcp/local-mode.js";

/**
 * Runtime settings the API cannot run without that are configuration, not secrets. One list,
 * imported by the server boot gate (apps/api/src/server.ts) and by the guardrail that checks
 * scripts/deploy-matter.ts sets every one of them (guardrails/secret-hygiene.spec.ts).
 *
 * MCP_PUBLIC_URL (D69): the full, canonical HTTPS URL of /mcp. It is the OAuth resource
 * identifier and token audience, and its origin is the issuer.
 */
export const REQUIRED_RUNTIME_SETTINGS = ["MCP_PUBLIC_URL"] as const;

export type RequiredRuntimeSetting = (typeof REQUIRED_RUNTIME_SETTINGS)[number];

/** Problems with the required settings in `env`, one line each. Empty when all are usable. */
export function runtimeSettingProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  // Local no-login mode (D77) signs nobody in, so it needs no OAuth URL; its own startup checks
  // require MCP_PUBLIC_URL to be unset or loopback instead (apps/api/src/mcp/local-mode.ts).
  if (isLocalNoLogin(env)) return [];
  const problems: string[] = [];
  for (const name of REQUIRED_RUNTIME_SETTINGS) {
    const value = env[name];
    if (value === undefined || value.trim() === "") problems.push(`${name} is not set`);
  }
  if (problems.length > 0) return problems;
  const oauth = resolveOAuthConfig(env);
  if ("error" in oauth) problems.push(oauth.error);
  return problems;
}

/**
 * Boot gate. Writes every problem to stderr and exits non-zero, before the server listens,
 * so a misconfigured deployment fails at start rather than on the first sign-in.
 */
export function assertRequiredRuntimeSettings(env: NodeJS.ProcessEnv = process.env): void {
  const problems = runtimeSettingProblems(env);
  if (problems.length === 0) return;
  process.stderr.write(
    `FATAL: invalid runtime setting(s): ${problems.join("; ")}. The API refuses to start. ` +
      `Cloud Run: set by scripts/deploy-matter.ts.\n`,
  );
  process.exit(1);
}
