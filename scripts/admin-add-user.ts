/**
 * Admin command: add a person to the matter and print their one-time setup link (DEV-030, D87).
 *
 *   pnpm admin:add-user --env <matter env file> --email <email> --name <name> --role <role> [--api-url <url>] [--issued-by <name>]
 *
 * Creates the user in MATTER_TENANT_ID with no password and no TOTP, makes them a member of the
 * workspace that owns MATTER_INVESTIGATION_ID with <role> (a role of the policy matrix: org_admin,
 * ws_admin, lead_inv, investigator, analyst, reviewer, contributor, viewer, auditor; anything else
 * is refused), writes a `user.create` audit row, and issues the same one-time setup link as
 * `pnpm admin:reset-link`, all in one transaction: either the person exists and has a link, or
 * nothing changed. An email that already has an account in the tenant is refused.
 *
 * The person opens the link, sets a password and enrols TOTP (D71). Whether they can then connect
 * Claude depends on the role (docs/PLAN-MCP-AUTH.md section 3): viewer, auditor and org_admin
 * get an account but cannot.
 *
 * Reads DATABASE_URL, MATTER_TENANT_ID, MATTER_INVESTIGATION_ID and MCP_PUBLIC_URL from the file
 * named by --env (its values win), or from the environment and .env.
 */

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { AuthError, AuthService } from "../apps/api/src/auth/service.js";
import { loadEnv, parseArgs } from "../tools/ingest-cli/src/args.js";
import { setupLinkOrigin, setupLinkText } from "./setup-link-text.js";

const USAGE =
  "Usage: pnpm admin:add-user --env <matter env file> --email <email> --name <name> --role <role> [--api-url <url>] [--issued-by <name>]";

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
  const name = arg(args, "name");
  const role = arg(args, "role");
  const tenantId = process.env.MATTER_TENANT_ID?.trim();
  const investigationId = process.env.MATTER_INVESTIGATION_ID?.trim();
  if (!email || !name || !role || !tenantId || !investigationId) {
    console.error(USAGE);
    console.error("MATTER_TENANT_ID and MATTER_INVESTIGATION_ID come from the env file.");
    return 2;
  }
  const apiUrl = setupLinkOrigin(arg(args, "api-url"));
  const issuedBy = arg(args, "issued-by") ?? userInfo().username;

  const db = createDbClient(getDbUrl(), { max: 1 });
  try {
    const { added, issued } = await withTenant(
      tenantId,
      async (tx) => {
        const requestId = `admin-cli-${randomUUID()}`;
        const added = await AuthService.addMatterUser(tx, { tenantId, investigationId, email, name, role, issuedBy, requestId });
        const issued = await AuthService.issuePasswordResetToken(tx, { tenantId, email: added.email, issuedBy, requestId });
        return { added, issued };
      },
      db,
    );
    process.stdout.write(
      [
        `Added ${added.email} to the matter as ${added.role}.`,
        "The account has no password and no authenticator yet; the link below sets both.",
        added.role === "viewer" || added.role === "auditor" || added.role === "org_admin"
          ? `Note: the ${added.role} role cannot connect Claude to the matter (docs/PLAN-MCP-AUTH.md section 3).`
          : `The ${added.role} role can connect Claude once setup is done.`,
        "",
        "",
      ].join("\n") + setupLinkText(issued, tenantId, apiUrl),
    );
    return 0;
  } catch (err) {
    const message = err instanceof AuthError ? err.message : (err as Error).message;
    console.error(`Could not add the user: ${message}`);
    console.error("Nothing was changed.");
    return 1;
  } finally {
    await db.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
