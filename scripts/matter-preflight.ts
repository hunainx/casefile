/**
 * Read-only upgrade preflight for one matter (D83, docs/UPGRADE-LIVE-MATTER.md step 1).
 *
 *   pnpm matter:preflight --env <matter env file>
 *
 * Reads the matter's env file and its database, and says in plain words:
 *   - which migrations are applied, and which of 0025–0031 are still missing;
 *   - every user of the matter's tenant: email, status, role on the matter's investigation,
 *     TOTP enrolled or not, and whether they will be able to use Claude after the upgrade;
 *   - whether MCP_PUBLIC_URL is set and canonical;
 *   - a final READY / NOT READY line with the reasons.
 *
 * It only READS. Every query runs inside a READ ONLY transaction, which Postgres itself
 * enforces (a write fails with "cannot execute ... in a read-only transaction"), and the
 * transaction checks that it is read only before its first query. It runs no gcloud or other
 * command and calls no web service. `guardrails/matter-preflight.spec.ts` checks both.
 *
 * Only the named env file is used: nothing is taken from .env or the shell, so a stray
 * DATABASE_URL cannot point it at another database.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { Tx } from "@casefile/db";
import { checkMcpEligibility } from "../packages/mcp/src/access.js";
import { canonicalUrlProblem, DEFAULT_TRUSTED_CLIENTS } from "../apps/api/src/oauth/config.js";
import { findRefusedProjectRefs, parseEnvFile } from "./matter-check.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "packages/db/migrations");
/**
 * The migrations an upgrade from the version before MCP sign-in adds: 0025–0027 for sign-in
 * (plan section 6), 0028 for text stored once (BIGDATA-2B, D94), 0029 for triage (BIGDATA-3, D98),
 * 0030 for mailbox message identity (BIGDATA-3B, D111), 0031 for the work queue (BIGDATA-4).
 * Any other missing migration means the matter is not at the expected starting point.
 * guardrails/matter-preflight.spec.ts fails when a migration numbered 0025 or later is not here
 * (DEV-039: 0029 and 0030 were missed once).
 */
export const UPGRADE_MIGRATIONS = [
  "0025_rate_limits.sql",
  "0026_oauth_mcp.sql",
  "0027_totp_last_step.sql",
  "0028_text_stored_once.sql",
  "0029_ingest_triage.sql",
  "0030_mailbox_message_identity.sql",
  "0031_ingest_work_queue.sql",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PreflightUser {
  email: string;
  status: string;
  workspaceRole: string | null;
  investigationRole: string | null;
  totpEnrolled: boolean;
  passwordSet: boolean;
  /** "yes", "after-setup-link" or "no". */
  claude: "yes" | "after-setup-link" | "no";
  why: string;
}

export interface PreflightReport {
  envFile: string;
  database: string;
  tenantId: string;
  investigationId: string;
  investigationName: string | null;
  readOnlyConfirmed: boolean;
  migrations: { known: string[]; applied: string[] | null; missing: string[]; foreign: string[]; readProblem: string | null };
  users: PreflightUser[];
  /** Ethical walls of the matter that name a group: not applied (DEV-024). */
  groupWalls: number;
  mcpPublicUrl: { value: string | null; problem: string | null; serviceUrlMismatch: string | null };
  trustedClients: string;
  reasons: string[];
  ready: boolean;
}

/** Replaces the password of a connection string with *** (user and host stay readable). */
export function maskUrl(url: string): string {
  return url.replace(/(\/\/[^:/@]+):[^@]*@/, "$1:***@");
}

/**
 * Runs `fn` in a READ ONLY transaction scoped to the tenant, as withTenant() does, after
 * checking that the server really treats it as read only.
 */
async function readOnly<T>(sql: postgres.Sql, tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin("read only", async (tx) => {
    const [mode] = await tx<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
    if (mode?.transaction_read_only !== "on") throw new Error("the preflight transaction is not read only; refusing to continue");
    if (tenantId) {
      await tx`
        DO $$
        BEGIN
          IF SESSION_USER <> 'casefile_app' AND pg_has_role(SESSION_USER, 'casefile_app', 'MEMBER') THEN
            PERFORM set_config('role', 'casefile_app', true);
          END IF;
        END
        $$;
      `;
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    }
    await tx`SELECT set_config('search_path', 'public, extensions', true)`;
    return fn(tx);
  })) as T;
}

async function readAppliedMigrations(
  app: postgres.Sql,
  ownerUrl: string | undefined,
): Promise<{ applied: string[] | null; problem: string | null }> {
  const read = (sql: postgres.Sql) =>
    readOnly(sql, null, async (tx) => {
      const [reg] = await tx<{ reg: string | null }[]>`SELECT to_regclass('public.schema_migrations')::text AS reg`;
      if (!reg?.reg) return null;
      const rows = await tx<{ version: string }[]>`SELECT version FROM public.schema_migrations ORDER BY version`;
      return rows.map((r) => r.version);
    });
  try {
    const applied = await read(app);
    return applied ? { applied, problem: null } : { applied: null, problem: "the database has no schema_migrations table" };
  } catch (err) {
    if ((err as { code?: string }).code !== "42501") throw err;
  }
  // The app role may not be allowed to read schema_migrations; the owner connection can.
  if (!ownerUrl) {
    return { applied: null, problem: "DATABASE_URL may not read schema_migrations; add DATABASE_URL_MIGRATIONS to the env file so the preflight can read it" };
  }
  const owner = postgres(ownerUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const applied = await read(owner);
    return applied ? { applied, problem: null } : { applied: null, problem: "the database has no schema_migrations table" };
  } finally {
    await owner.end({ timeout: 5 });
  }
}

function describeRefusal(reason: string, message: string): string {
  if (reason === "not_active") return "the account is not active";
  if (reason === "not_member") return "not a member of the matter's workspace";
  if (reason === "ethical_wall") return "an ethical wall screens this account from the matter";
  return message.replace(/\.$/, "").replace(/^Your role/, "its role");
}

export async function runPreflight(envFile: string): Promise<PreflightReport> {
  const env = parseEnvFile(envFile);
  const reasons: string[] = [];

  const refused = findRefusedProjectRefs(fs.readFileSync(envFile, "utf8"));
  if (refused.length > 0) {
    throw new Error(`the env file names a project this tool must never touch (${refused.length} refused ref(s)); nothing was read`);
  }
  const dbUrl = env.DATABASE_URL?.trim();
  const tenantId = env.MATTER_TENANT_ID?.trim() ?? "";
  const investigationId = env.MATTER_INVESTIGATION_ID?.trim() ?? "";
  if (!dbUrl) throw new Error("the env file has no DATABASE_URL");
  if (!UUID.test(tenantId)) throw new Error(`MATTER_TENANT_ID (${tenantId || "not set"}) is not a UUID`);
  if (!UUID.test(investigationId)) throw new Error(`MATTER_INVESTIGATION_ID (${investigationId || "not set"}) is not a UUID`);

  // MCP_PUBLIC_URL: set, canonical, ends in /mcp, and matches the recorded service URL.
  const mcpUrl = env.MCP_PUBLIC_URL?.trim() || null;
  let urlProblem: string | null = null;
  let mismatch: string | null = null;
  if (!mcpUrl) {
    urlProblem = "not set";
    reasons.push("MCP_PUBLIC_URL is not set (runbook step 3)");
  } else {
    const p = canonicalUrlProblem(mcpUrl);
    if (p) urlProblem = p;
    else if (new URL(mcpUrl).pathname !== "/mcp") urlProblem = "must end in /mcp";
    if (urlProblem) reasons.push(`MCP_PUBLIC_URL ${urlProblem} (runbook step 3)`);
    const serviceUrl = env.SERVICE_URL?.trim().replace(/\/+$/, "");
    if (!urlProblem && serviceUrl && `${serviceUrl}/mcp` !== mcpUrl) {
      mismatch = `SERVICE_URL in the env file is ${serviceUrl}; MCP_PUBLIC_URL is not that URL followed by /mcp`;
    }
  }

  const known = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const app = postgres(dbUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const { applied, problem } = await readAppliedMigrations(app, env.DATABASE_URL_MIGRATIONS?.trim() || undefined);
    const appliedSet = new Set(applied ?? []);
    const missing = applied ? known.filter((f) => !appliedSet.has(f)) : [];
    const foreign = applied ? applied.filter((f) => !known.includes(f)) : [];
    if (problem) reasons.push(`cannot tell which migrations are applied: ${problem}`);
    if (foreign.length > 0) reasons.push(`the database has ${foreign.length} migration(s) this code does not know: ${foreign.join(", ")} — stop and ask`);
    const older = missing.filter((f) => !UPGRADE_MIGRATIONS.includes(f));
    if (older.length > 0) reasons.push(`older migrations are missing too: ${older.join(", ")} — this matter is not at the expected starting point; stop and ask`);
    const upgradeMissing = missing.filter((f) => UPGRADE_MIGRATIONS.includes(f));
    if (upgradeMissing.length > 0) {
      reasons.push(`migrations ${upgradeMissing.map((f) => f.slice(0, 4)).join(", ")} are not applied yet (runbook step 4)`);
    }

    const { investigationName, users, groupWalls, readOnlyConfirmed } = await readOnly(app, tenantId, async (tx) => {
      const [mode] = await tx<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
      const [inv] = await tx<{ name: string; workspace_id: string }[]>`
        SELECT name, workspace_id FROM investigations
        WHERE id = ${investigationId} AND tenant_id = ${tenantId} AND deleted_at IS NULL`;
      if (!inv) return { investigationName: null, users: [] as PreflightUser[], groupWalls: 0, readOnlyConfirmed: mode?.transaction_read_only === "on" };
      // FIXES-1 (DEV-024): a wall that names a group screens nobody (there is no group membership).
      const [walls] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ethical_walls
        WHERE tenant_id = ${tenantId} AND subject_type = 'group'
          AND (investigation_id = ${investigationId} OR (workspace_id = ${inv.workspace_id} AND investigation_id IS NULL))`;
      const rows = await tx<{
        id: string;
        email: string;
        status: string;
        workspace_role: string | null;
        investigation_role: string | null;
        totp_enabled: boolean | null;
        has_totp_secret: boolean | null;
        has_password: boolean | null;
      }[]>`
        SELECT u.id, u.email, u.status,
               wm.role AS workspace_role,
               im.role AS investigation_role,
               ac.totp_enabled,
               (ac.totp_secret IS NOT NULL) AS has_totp_secret,
               (ac.password_hash IS NOT NULL) AS has_password
        FROM users u
        LEFT JOIN workspace_members wm
          ON wm.user_id = u.id AND wm.workspace_id = ${inv.workspace_id} AND wm.tenant_id = ${tenantId}
        LEFT JOIN investigation_members im
          ON im.user_id = u.id AND im.investigation_id = ${investigationId} AND im.tenant_id = ${tenantId}
        LEFT JOIN auth_credentials ac ON ac.user_id = u.id AND ac.tenant_id = ${tenantId}
        WHERE u.tenant_id = ${tenantId} AND u.deleted_at IS NULL
        ORDER BY u.email`;
      const out: PreflightUser[] = [];
      for (const r of rows) {
        const totp = Boolean(r.totp_enabled && r.has_totp_secret);
        const elig = await checkMcpEligibility(tx, { tenantId, investigationId, userId: r.id });
        let claude: PreflightUser["claude"];
        let why: string;
        if (!elig.ok) {
          claude = "no";
          why = describeRefusal(elig.reason, elig.message);
        } else if (!totp || !r.has_password) {
          claude = "after-setup-link";
          why = `role ${elig.effectiveRole} may use Claude; needs a one-time setup link to ${r.has_password ? "" : "set a password and "}enrol TOTP (runbook step 2)`;
        } else {
          claude = "yes";
          why = `role ${elig.effectiveRole} may use Claude; password and TOTP are set`;
        }
        out.push({
          email: r.email,
          status: r.status,
          workspaceRole: r.workspace_role,
          investigationRole: r.investigation_role,
          totpEnrolled: totp,
          passwordSet: Boolean(r.has_password),
          claude,
          why,
        });
      }
      return { investigationName: inv.name, users: out, groupWalls: Number(walls?.n ?? 0), readOnlyConfirmed: mode?.transaction_read_only === "on" };
    });

    if (investigationName === null) {
      reasons.push("MATTER_INVESTIGATION_ID does not name an investigation of MATTER_TENANT_ID — check the env file");
    } else if (users.length === 0) {
      reasons.push("the matter's tenant has no users");
    } else if (!users.some((u) => u.claude !== "no")) {
      reasons.push("no user of the tenant will be able to use Claude (every account is refused; see the table)");
    }

    if (groupWalls > 0) {
      reasons.push(
        `${groupWalls} ethical wall(s) name a group; they are NOT applied, because there is no group membership (DEV-024) — ` +
          "replace each with a wall per person before the upgrade",
      );
    }

    const trusted = env.MCP_OAUTH_TRUSTED_CLIENTS?.trim();
    return {
      envFile,
      database: maskUrl(dbUrl),
      tenantId,
      investigationId,
      investigationName,
      readOnlyConfirmed,
      migrations: { known, applied, missing, foreign, readProblem: problem },
      users,
      groupWalls,
      mcpPublicUrl: { value: mcpUrl, problem: urlProblem, serviceUrlMismatch: mismatch },
      trustedClients: trusted ? trusted : `not set (default: ${DEFAULT_TRUSTED_CLIENTS.join(", ")} — Claude Code only)`,
      reasons,
      ready: reasons.length === 0,
    };
  } finally {
    await app.end({ timeout: 5 });
  }
}

const CLAUDE_WORDS: Record<PreflightUser["claude"], string> = {
  yes: "YES",
  "after-setup-link": "YES, after the setup link",
  no: "NO",
};

export function formatReport(r: PreflightReport): string {
  const lines: string[] = [];
  lines.push("CASEFILE MATTER PREFLIGHT (read only: nothing is written, no gcloud command is run)");
  lines.push("");
  lines.push(`Env file:       ${r.envFile}`);
  lines.push(`Database:       ${r.database}`);
  lines.push(`Tenant:         ${r.tenantId}`);
  lines.push(`Investigation:  ${r.investigationId}${r.investigationName ? `  "${r.investigationName}"` : "  (NOT FOUND in this tenant)"}`);
  lines.push(`Read only:      ${r.readOnlyConfirmed ? "yes, the database confirmed every query ran in a READ ONLY transaction" : "NOT CONFIRMED"}`);
  lines.push("");

  lines.push("1. Migrations");
  if (r.migrations.applied === null) {
    lines.push(`   Could not read them: ${r.migrations.readProblem}`);
  } else {
    lines.push(`   Applied: ${r.migrations.applied.length} of the ${r.migrations.known.length} this code has.`);
    for (const f of UPGRADE_MIGRATIONS) {
      lines.push(`   ${f}: ${r.migrations.applied.includes(f) ? "applied" : "MISSING (runbook step 4 applies it)"}`);
    }
    const older = r.migrations.missing.filter((f) => !UPGRADE_MIGRATIONS.includes(f));
    if (older.length > 0) lines.push(`   Older migrations also missing: ${older.join(", ")}`);
    if (r.migrations.foreign.length > 0) lines.push(`   Unknown to this code: ${r.migrations.foreign.join(", ")}`);
  }
  lines.push("");

  lines.push(`2. People in the matter's tenant (${r.users.length})`);
  r.users.forEach((u, i) => {
    lines.push(`   ${i + 1}) ${u.email}`);
    lines.push(`      status: ${u.status}`);
    lines.push(`      role on the matter's investigation: ${u.investigationRole ?? "none"} (workspace role: ${u.workspaceRole ?? "not a member"})`);
    lines.push(`      TOTP enrolled: ${u.totpEnrolled ? "yes" : "no"}   password set: ${u.passwordSet ? "yes" : "no"}`);
    lines.push(`      Can use Claude after the upgrade: ${CLAUDE_WORDS[u.claude]} — ${u.why}`);
  });
  lines.push("");

  lines.push("3. MCP_PUBLIC_URL");
  if (!r.mcpPublicUrl.value) lines.push("   Not set.");
  else {
    lines.push(`   Set: ${r.mcpPublicUrl.value}`);
    lines.push(`   Canonical: ${r.mcpPublicUrl.problem ? `NO — it ${r.mcpPublicUrl.problem}` : "yes"}`);
    if (r.mcpPublicUrl.serviceUrlMismatch) lines.push(`   Note: ${r.mcpPublicUrl.serviceUrlMismatch}.`);
  }
  lines.push(`   MCP_OAUTH_TRUSTED_CLIENTS: ${r.trustedClients}`);
  lines.push("");

  lines.push("4. Ethical walls");
  lines.push(
    r.groupWalls > 0
      ? `   ${r.groupWalls} wall(s) name a group: NOT applied (there is no group membership, DEV-024).`
      : "   No wall names a group (walls that name a user are applied).",
  );
  lines.push("");

  if (r.ready) {
    lines.push("RESULT: READY — nothing blocks the upgrade.");
  } else {
    lines.push("RESULT: NOT READY");
    for (const reason of r.reasons) lines.push(`  - ${reason}`);
  }
  return lines.join("\n");
}

function envFileArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--env") return argv[i + 1] ?? null;
    if (a.startsWith("--env=")) return a.slice("--env=".length);
  }
  return null;
}

async function main(): Promise<number> {
  const envFile = envFileArg(process.argv.slice(2));
  if (!envFile) {
    console.error("Usage: pnpm matter:preflight --env <matter env file>");
    return 2;
  }
  const resolved = path.resolve(envFile);
  if (!fs.existsSync(resolved)) {
    console.error(`Env file not found: ${resolved}`);
    return 2;
  }
  try {
    const report = await runPreflight(resolved);
    console.log(formatReport(report));
    return report.ready ? 0 : 1;
  } catch (err) {
    console.error(`PREFLIGHT STOPPED: ${(err as Error).message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
