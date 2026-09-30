import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { withTenant, getDbUrl } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import { hashPassword, signJwt } from "../../../apps/api/src/auth/crypto.js";
import { matterConfig } from "../../../matter.config.js";
import { parseArgs, loadEnv } from "./args.js";

loadEnv();

export interface BootstrapResult {
  tenantId: string;
  workspaceId: string;
  userId: string;
  investigationId: string;
  token: string;
  isExisting: boolean;
  adminEmail: string;
  /** Present only when this call created the admin user. Never stored anywhere but .env.<matter>. */
  adminPassword?: string;
  /** The .env.<matter> file that records this matter's identifiers (gitignored). */
  envFile: string;
}

export interface BootstrapOptions {
  name: string;
  investigationName: string;
  /** Admin login email. Required; there is no derived default. */
  email: string;
  /** Matter slug used to name .env.<matter>. Defaults to matterConfig.matterSlug. */
  matter?: string;
  /** Directory holding .env.<matter>. Defaults to process.cwd(). */
  envDir?: string;
  dbUrl?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads a KEY=value env file into a map. Tolerates comments and blank lines.
 */
export function readEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(filePath)) return out;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Inserts or replaces KEY=value lines in an env file, preserving every other line.
 * Never removes a key. Creates the file if it does not exist.
 */
export function upsertEnvFile(filePath: string, entries: Record<string, string>): void {
  const lines = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(entries));
  const updated = lines.map((line) => {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, eq).trim();
    if (remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  while (updated.length > 0 && updated[updated.length - 1] === "") updated.pop();
  for (const [key, value] of remaining) updated.push(`${key}=${value}`);
  writeFileSync(filePath, updated.join("\n") + "\n", "utf8");
}

function generateAdminPassword(): string {
  // 24 random bytes → 32 URL-safe characters. Never derived from anything.
  return randomBytes(24).toString("base64url");
}

/**
 * Provisions (or re-attaches to) a matter's tenant, workspace, admin user and primary
 * investigation.
 *
 * Idempotency: every identifier is a fresh randomUUID(), so nothing can be recomputed
 * from the matter name. The identifiers are recorded in .env.<matter>; a re-run with the
 * same --matter reads MATTER_TENANT_ID from that file, opens that tenant, and looks the
 * admin up by email inside it. Row-level security is keyed on tenant_id, so a lookup by
 * email across all tenants is not possible for the application role — the env file is
 * the only cross-run memory this tool can have without a BYPASSRLS credential.
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const adminEmail = (options.email || "").trim();
  if (!adminEmail || !EMAIL_PATTERN.test(adminEmail)) {
    throw new Error("bootstrap requires an admin email (--email). There is no derived default.");
  }

  const matter = (options.matter || matterConfig.matterSlug).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!matter) {
    throw new Error("bootstrap requires a matter slug (--matter) to name .env.<matter>.");
  }
  const envFile = resolve(options.envDir || process.cwd(), `.env.${matter}`);
  const recorded = readEnvFile(envFile);

  const dbUrl = options.dbUrl || getDbUrl();
  const db = postgres(dbUrl, { max: 1 });

  try {
    // ── Re-attach to a tenant this file already recorded ─────────────────────
    if (recorded.MATTER_TENANT_ID) {
      const tenantId = recorded.MATTER_TENANT_ID;
      return await withTenant(
        tenantId,
        async (tx) => {
          const userRows = await tx<{ id: string }[]>`
            SELECT id FROM users
            WHERE tenant_id = ${tenantId} AND lower(email) = lower(${adminEmail})
            LIMIT 1;
          `;
          if (userRows.length === 0 || !userRows[0]) {
            throw new Error(
              `${envFile} records tenant ${tenantId} but no user with email ${adminEmail} exists in it. ` +
                `Either the email is wrong or the env file is stale. Refusing to create a second tenant.`,
            );
          }
          const userId = userRows[0].id;

          const wsRows = await tx<{ workspace_id: string }[]>`
            SELECT workspace_id FROM workspace_members
            WHERE tenant_id = ${tenantId} AND user_id = ${userId}
            ORDER BY created_at ASC LIMIT 1;
          `;
          const workspaceId = recorded.MATTER_WORKSPACE_ID || wsRows[0]?.workspace_id;
          if (!workspaceId) {
            throw new Error(`Tenant ${tenantId} has no workspace for admin ${adminEmail}.`);
          }

          let investigationId: string;
          const invRows = await tx<{ id: string }[]>`
            SELECT id FROM investigations
            WHERE tenant_id = ${tenantId}
              AND workspace_id = ${workspaceId}
              AND lower(name) = lower(${options.investigationName})
              AND deleted_at IS NULL
            ORDER BY created_at ASC LIMIT 1;
          `;
          if (invRows[0]) {
            investigationId = invRows[0].id;
          } else {
            investigationId = randomUUID();
            await tx`
              INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage, created_by)
              VALUES (
                ${investigationId}, ${tenantId}, ${workspaceId}, ${options.investigationName},
                'Ingestion and case analysis.', 'collecting', ${userId}
              );
            `;
            await tx`
              INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role, created_by)
              VALUES (${randomUUID()}, ${tenantId}, ${investigationId}, ${userId}, 'lead_investigator', ${userId})
              ON CONFLICT (investigation_id, user_id) DO NOTHING;
            `;
            await writeAuditEvent(tx, {
              tenantId,
              workspaceId,
              investigationId,
              actorType: "user",
              actorId: userId,
              actorDisplay: adminEmail,
              action: "investigation.create",
              objectType: "investigation",
              objectId: investigationId,
              objectDisplay: options.investigationName,
              outcome: "success",
              requestId: randomUUID(),
            });
          }

          upsertEnvFile(envFile, {
            MATTER_TENANT_ID: tenantId,
            MATTER_WORKSPACE_ID: workspaceId,
            MATTER_ADMIN_USER_ID: userId,
            MATTER_INVESTIGATION_ID: investigationId,
            MATTER_ADMIN_EMAIL: adminEmail,
          });

          const token = signJwt(
            { sub: userId, tid: tenantId, sid: randomUUID(), roles: ["admin", "lead_investigator"], mfa: true },
            86400 * 30,
          );

          return {
            tenantId,
            workspaceId,
            userId,
            investigationId,
            token,
            isExisting: true,
            adminEmail,
            envFile,
          };
        },
        db,
      );
    }

    // ── Fresh tenant: every id random, password random ───────────────────────
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const investigationId = randomUUID();
    const adminPassword = generateAdminPassword();
    const pwHash = await hashPassword(adminPassword);

    const result = await withTenant(
      tenantId,
      async (tx) => {
        await tx`
          INSERT INTO organizations (id, tenant_id, name)
          VALUES (${tenantId}, ${tenantId}, ${options.name});
        `;

        await tx`
          INSERT INTO workspaces (id, tenant_id, name)
          VALUES (${workspaceId}, ${tenantId}, ${options.name});
        `;

        await tx`
          INSERT INTO users (id, tenant_id, email, name, status)
          VALUES (${userId}, ${tenantId}, ${adminEmail}, ${options.name}, 'active');
        `;

        await tx`
          INSERT INTO auth_credentials (user_id, tenant_id, password_hash)
          VALUES (${userId}, ${tenantId}, ${pwHash});
        `;

        await tx`
          INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
          VALUES (${randomUUID()}, ${tenantId}, ${workspaceId}, ${userId}, 'admin');
        `;

        await tx`
          INSERT INTO investigations (id, tenant_id, workspace_id, name, objective, stage, created_by)
          VALUES (
            ${investigationId}, ${tenantId}, ${workspaceId}, ${options.investigationName},
            'Ingestion and case analysis.', 'collecting', ${userId}
          );
        `;

        await tx`
          INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role, created_by)
          VALUES (${randomUUID()}, ${tenantId}, ${investigationId}, ${userId}, 'lead_investigator', ${userId});
        `;

        await writeAuditEvent(tx, {
          tenantId,
          workspaceId,
          actorType: "user",
          actorId: userId,
          actorDisplay: adminEmail,
          action: "workspace.create",
          objectType: "workspace",
          objectId: workspaceId,
          objectDisplay: options.name,
          outcome: "success",
          requestId: randomUUID(),
        });

        await writeAuditEvent(tx, {
          tenantId,
          workspaceId,
          investigationId,
          actorType: "user",
          actorId: userId,
          actorDisplay: adminEmail,
          action: "investigation.create",
          objectType: "investigation",
          objectId: investigationId,
          objectDisplay: options.investigationName,
          outcome: "success",
          requestId: randomUUID(),
        });

        const token = signJwt(
          { sub: userId, tid: tenantId, sid: randomUUID(), roles: ["admin", "lead_investigator"], mfa: true },
          86400 * 30,
        );

        return {
          tenantId,
          workspaceId,
          userId,
          investigationId,
          token,
          isExisting: false,
          adminEmail,
          adminPassword,
          envFile,
        };
      },
      db,
    );

    // Recorded only after the transaction committed, so a failed bootstrap leaves no file.
    upsertEnvFile(envFile, {
      MATTER_TENANT_ID: result.tenantId,
      MATTER_WORKSPACE_ID: result.workspaceId,
      MATTER_ADMIN_USER_ID: result.userId,
      MATTER_INVESTIGATION_ID: result.investigationId,
      MATTER_ADMIN_EMAIL: adminEmail,
      MATTER_ADMIN_PASSWORD: adminPassword,
    });

    return result;
  } finally {
    await db.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI execution
// ─────────────────────────────────────────────────────────────────────────────
async function runCli() {
  const args = parseArgs(process.argv.slice(2));

  const name = (args["name"] || args["n"] || "") as string;
  const investigationName = (args["investigation"] || args["i"] || "Default Investigation") as string;
  const email = (args["email"] || args["e"] || "") as string;
  const matter = (args["matter"] || args["m"] || matterConfig.matterSlug) as string;

  if (!name || !email) {
    console.error("Error: --name <Workspace / Org Name> and --email <admin login email> are required.");
    console.error('Usage: pnpm ingest:bootstrap --name "Matter Name" --email admin@firm.example --investigation "Case name" [--matter <slug>]');
    process.exit(1);
  }

  try {
    const result = await bootstrap({ name, investigationName, email, matter });

    console.log("================================================================================");
    console.log(`CASEFILE BOOTSTRAP ${result.isExisting ? "(EXISTING RETRIEVED)" : "(PROVISIONED)"}`);
    console.log("================================================================================");
    console.log(`Tenant ID:        ${result.tenantId}`);
    console.log(`Workspace ID:     ${result.workspaceId}`);
    console.log(`User ID:          ${result.userId}`);
    console.log(`Investigation ID: ${result.investigationId}`);
    console.log(`Admin Email:      ${result.adminEmail}`);
    if (result.adminPassword) {
      console.log(`Admin Password:   ${result.adminPassword.slice(0, 8)}…  (full value written to ${result.envFile})`);
    } else {
      console.log(`Admin Password:   unchanged (existing user; see ${result.envFile})`);
    }
    console.log(`Token:            ${result.token}`);
    console.log("================================================================================");
    console.log(`\nIdentifiers recorded in ${result.envFile}. Copy these to your .env:`);
    console.log(`MATTER_TENANT_ID=${result.tenantId}`);
    console.log(`MATTER_WORKSPACE_ID=${result.workspaceId}`);
    console.log(`MATTER_INVESTIGATION_ID=${result.investigationId}`);
    console.log(`CASEFILE_TOKEN=${result.token}`);
    console.log("");
  } catch (err) {
    console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (process.argv[1]?.includes("bootstrap")) {
  runCli();
}
