/**
 * Admin command: issue a one-time account setup link for one user (D65, D71).
 *
 *   pnpm admin:reset-link --email <email> [--env <matter env file>] [--tenant <tenant-uuid>] [--api-url <url>] [--issued-by <name>]
 *
 * Self-service reset delivers nothing until an email channel exists, so this is how a user
 * gets a first password — and it is the ONLY way to enrol (or replace) TOTP, which MCP
 * sign-in requires. The link opens /account/setup, where the user sets a password and enrols
 * an authenticator, confirmed with a valid code. It is valid for 60 minutes and works once.
 *
 * The token is printed here, to the administrator's terminal, and nowhere else: only its
 * SHA-256 digest is stored, and the audit event records who issued it, for whom, and until
 * when, without it. It sits in the link's #fragment, which browsers never send to a server,
 * so it appears in no request log.
 *
 * Reads DATABASE_URL, MATTER_TENANT_ID, MCP_PUBLIC_URL and CASEFILE_API_URL from the
 * environment or .env (or the file named by --env, whose values win); the link's origin is
 * MCP_PUBLIC_URL's (or --api-url / CASEFILE_API_URL).
 */

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { AuthService } from "../apps/api/src/auth/service.js";
import { loadEnv, parseArgs } from "../tools/ingest-cli/src/args.js";
import { setupLinkOrigin, setupLinkText } from "./setup-link-text.js";

function arg(args: Record<string, string | boolean>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const envFile = arg(args, "env");
  if (envFile && !existsSync(resolve(envFile))) {
    console.error(`--env file not found: ${resolve(envFile)}`);
    return 2;
  }
  loadEnv(envFile ?? ".env");

  const email = arg(args, "email");
  const tenantId = arg(args, "tenant") ?? process.env.MATTER_TENANT_ID;
  const apiUrl = setupLinkOrigin(arg(args, "api-url"));
  const issuedBy = arg(args, "issued-by") ?? userInfo().username;

  if (!email || !tenantId) {
    console.error("Usage: pnpm admin:reset-link --email <email> [--env <matter env file>] [--tenant <tenant-uuid>] [--api-url <url>] [--issued-by <name>]");
    console.error("The tenant defaults to MATTER_TENANT_ID.");
    return 2;
  }

  const db = createDbClient(getDbUrl(), { max: 1 });
  try {
    const issued = await withTenant(
      tenantId,
      (tx) => AuthService.issuePasswordResetToken(tx, { tenantId, email, issuedBy, requestId: `admin-cli-${randomUUID()}` }),
      db,
    );

    process.stdout.write(setupLinkText(issued, tenantId, apiUrl));
    return 0;
  } catch (err) {
    console.error(`Could not issue a reset token: ${(err as Error).message}`);
    return 1;
  } finally {
    await db.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
