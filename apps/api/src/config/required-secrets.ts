/**
 * The runtime secrets the API cannot run without. One list, imported by both the
 * server boot gate (apps/api/src/server.ts) and the guardrail that checks the deploy
 * script mounts every one of them (guardrails/secret-hygiene.spec.ts).
 *
 * Adding a secret here is a three-place change by construction: the API refuses to
 * boot without it, deploy-matter.ts must mount it, and the guardrail fails until it does.
 */
export const REQUIRED_RUNTIME_SECRETS = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "JWT_SECRET",
] as const;

export type RequiredRuntimeSecret = (typeof REQUIRED_RUNTIME_SECRETS)[number];

/** Names from REQUIRED_RUNTIME_SECRETS that are unset or blank in `env`. */
export function missingRuntimeSecrets(env: NodeJS.ProcessEnv = process.env): RequiredRuntimeSecret[] {
  return REQUIRED_RUNTIME_SECRETS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
}

/**
 * Boot gate. Writes every missing name to stderr and exits non-zero. Called before the
 * server listens, so a misconfigured deployment fails at start, not on the first request.
 */
export function assertRequiredRuntimeSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const missing = missingRuntimeSecrets(env);
  if (missing.length === 0) return;
  process.stderr.write(
    `FATAL: missing required runtime secret(s): ${missing.join(", ")}. ` +
      `The API refuses to start. Each must be set in the environment (Cloud Run: mounted from Secret Manager by scripts/deploy-matter.ts).\n`,
  );
  process.exit(1);
}
