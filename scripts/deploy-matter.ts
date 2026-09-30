/**
 * Matter Infrastructure Deployment Orchestrator
 * Invoked: pnpm tsx scripts/deploy-matter.ts <matter-name> <supabase-project-ref> [--phase=database|service|all|workers]
 *            [--env <matter env file>] [--dry-run] [--no-build] [--workers N]
 * Provisions database extensions/migrations, GCP Secret Manager secrets, and Cloud Run service for a new matter deployment.
 *
 * --env <file>  the matter's env file (default: .env.<matter> in the current directory). Its values
 *               are loaded before anything else and win over the shell.
 * --dry-run     prints every gcloud, docker and database step it would take, with secrets masked,
 *               and runs none of them: no command, no database connection, no file written (D84).
 *               guardrails/deploy-dry-run.spec.ts proves it.
 * --no-build    the service phase redeploys the image already in Artifact Registry instead of
 *               building and pushing the current checkout first.
 * --phase=workers (BIGDATA-4, plan section 16) defines the matter's two ingest Cloud Run jobs, in
 *               its own project, under its own service account, with the image the service phase
 *               built: casefile-<matter>-ingest-enqueue (one task: triage and queue a bucket prefix)
 *               and casefile-<matter>-ingest-workers (N tasks sharing the run's queue in the matter's
 *               database; N = --workers, else matterConfig.ingestWorkers). Nothing else is changed.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { migrate } from "../packages/db/migrate/index.js";
import { bootstrap, upsertEnvFile } from "../tools/ingest-cli/src/bootstrap.js";
import { matterConfig } from "../matter.config.js";
import { findRefusedProjectRefs, parseEnvFile } from "./matter-check.js";

export type DeployPhase = "database" | "service" | "all" | "workers";

export interface DeployOptions {
  /** Print every step, run none (D84). */
  dryRun?: boolean;
  /** The matter's env file; default .env.<matter> in the current directory. */
  envFile?: string;
  /** Redeploy the existing image instead of building and pushing the checkout. */
  noBuild?: boolean;
  /** Phase workers: the ingest workers job's task count (default matterConfig.ingestWorkers). */
  workers?: number;
}

// ── Dry run (D84) ─────────────────────────────────────────────────────────────
// Set once per deployMatter() call. execCmd() refuses to run anything while it is set, so a
// step without a dry-run branch fails loudly instead of running.
let dryRun = false;
/** Values that must never be printed: every secret-shaped value of the env file and the shell. */
const secretValues = new Set<string>();

function rememberSecrets(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 6 && /PASSWORD|SECRET|TOKEN|_KEY|DATABASE_URL/i.test(key)) secretValues.add(value);
  }
}

/** Masks connection-string passwords and every remembered secret value. */
export function maskSecrets(text: string): string {
  let out = text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/g, "$1:***@");
  for (const value of [...secretValues].sort((a, b) => b.length - a.length)) out = out.split(value).join("***");
  return out;
}

/** In a dry run: prints one step it would take. */
function would(step: string): void {
  console.log(`  [dry-run] ${maskSecrets(step)}`);
}

function generateSafePassword(length = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!_-^.~$";
  let pwd = "";
  const bytes = crypto.randomBytes(length * 2);
  for (let i = 0; i < bytes.length && pwd.length < length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      const idx = byte % chars.length;
      const ch = chars[idx];
      if (ch) pwd += ch;
    }
  }
  return pwd;
}

function parseArgs(): { matter: string; projectRef: string; phase: DeployPhase; adminEmail: string; options: DeployOptions } {
  const args = process.argv.slice(2);
  let matter = "";
  let projectRef = "";
  let phase: DeployPhase = "all";
  let adminEmail = process.env.MATTER_ADMIN_EMAIL || "";
  const options: DeployOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-build") {
      options.noBuild = true;
    } else if (arg === "--env" && i + 1 < args.length) {
      options.envFile = args[i + 1] || "";
      i++;
    } else if (arg.startsWith("--env=")) {
      options.envFile = arg.slice("--env=".length);
    } else if (arg === "--matter" && i + 1 < args.length) {
      matter = args[i + 1] || "";
      i++;
    } else if (arg.startsWith("--matter=")) {
      matter = arg.slice("--matter=".length);
    } else if (arg === "--admin-email" && i + 1 < args.length) {
      adminEmail = args[i + 1] || "";
      i++;
    } else if (arg.startsWith("--admin-email=")) {
      adminEmail = arg.slice("--admin-email=".length);
    } else if (arg === "--project-ref" && i + 1 < args.length) {
      projectRef = args[i + 1] || "";
      i++;
    } else if (arg.startsWith("--project-ref=")) {
      projectRef = arg.slice("--project-ref=".length);
    } else if (arg === "--phase" && i + 1 < args.length) {
      const p = args[i + 1]?.toLowerCase();
      if (p === "database" || p === "service" || p === "all" || p === "workers") phase = p;
      i++;
    } else if (arg.startsWith("--phase=")) {
      const p = arg.slice("--phase=".length).toLowerCase();
      if (p === "database" || p === "service" || p === "all" || p === "workers") phase = p as DeployPhase;
    } else if (arg === "--workers" && i + 1 < args.length) {
      options.workers = Number(args[i + 1]);
      i++;
    } else if (arg.startsWith("--workers=")) {
      options.workers = Number(arg.slice("--workers=".length));
    } else if (!matter) {
      matter = arg;
    } else if (!projectRef) {
      projectRef = arg;
    }
  }

  if (!matter || !projectRef) {
    console.error("Usage: pnpm tsx scripts/deploy-matter.ts <matter-name> <supabase-project-ref> --admin-email <email> [--phase=database|service|all|workers] [--env <file>] [--dry-run] [--no-build] [--workers N]");
    console.error("  or:  pnpm tsx scripts/deploy-matter.ts --matter <name> --project-ref <ref> --admin-email <email> [--phase <phase>] [--env <file>] [--dry-run] [--no-build]");
    process.exit(1);
  }

  const cleanMatter = matter.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return { matter: cleanMatter, projectRef: projectRef.trim(), phase, adminEmail: adminEmail.trim(), options };
}

function execCmd(
  cmd: string,
  options: { input?: string | undefined; silent?: boolean | undefined; env?: NodeJS.ProcessEnv | undefined } = {}
): string {
  if (dryRun) {
    throw new Error(`--dry-run must not run a command, but a step tried to run: ${maskSecrets(cmd)}`);
  }
  try {
    return execSync(cmd, {
      encoding: "utf8",
      input: options.input,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.silent ? "pipe" : ["pipe", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const errOutput = (e.stderr || e.stdout || e.message || "").trim();
    throw new Error(`Command failed: ${cmd}\n${errOutput}`, { cause: err });
  }
}

export interface BucketEnsureResult {
  name: string;
  action: "adopted" | "created" | "dry-run";
}

async function ensureBucket(bucketName: string, region: string, projectId: string): Promise<BucketEnsureResult> {
  const describe = `gcloud.cmd storage buckets describe gs://${bucketName} --project=${projectId}`;
  const create = `gcloud.cmd storage buckets create gs://${bucketName} --location=${region} --project=${projectId} --uniform-bucket-level-access`;
  const versioning = `gcloud.cmd storage buckets update gs://${bucketName} --versioning --project=${projectId}`;
  if (dryRun) {
    would(`gcloud (read):  ${describe}`);
    would(`  if it exists: ADOPT it and change nothing (versioning, lifecycle and retention untouched)`);
    would(`  if missing:   gcloud (write): ${create}`);
    would(`                gcloud (write): ${versioning}`);
    return { name: bucketName, action: "dry-run" };
  }
  console.log(`Checking GCS bucket: gs://${bucketName}...`);
  let exists = false;
  try {
    execCmd(describe, { silent: true });
    exists = true;
  } catch {
    // Bucket does not exist
  }

  if (exists) {
    console.log(`✓ Bucket gs://${bucketName} already exists — ADOPTED (leaving versioning, lifecycle, and retention untouched).`);
    return { name: bucketName, action: "adopted" };
  } else {
    console.log(`Creating bucket gs://${bucketName} in ${region}...`);
    execCmd(create, { silent: true });
    console.log(`Ensuring versioning enabled on gs://${bucketName}...`);
    execCmd(versioning, { silent: true });
    console.log(`✓ Bucket gs://${bucketName} created (versioning ON, uniform access).`);
    return { name: bucketName, action: "created" };
  }
}

async function ensureSecret(secretName: string, secretValue: string, projectId: string) {
  const describe = `gcloud.cmd secrets describe ${secretName} --project=${projectId}`;
  const create = `gcloud.cmd secrets create ${secretName} --replication-policy=automatic --project=${projectId}`;
  const addVersion = `gcloud.cmd secrets versions add ${secretName} --data-file=- --project=${projectId}`;
  if (dryRun) {
    would(`gcloud (read):  ${describe}`);
    would(`  if missing:   gcloud (write): ${create}`);
    // A value the dry run cannot know is a "<...>" placeholder; anything else is masked.
    const shown = secretValue.startsWith("<") ? secretValue : `***, ${secretValue.length} characters`;
    would(`gcloud (write): ${addVersion}   (value on stdin: ${shown})`);
    return;
  }
  console.log(`Checking Secret Manager secret: ${secretName}...`);
  let exists = false;
  try {
    execCmd(describe, { silent: true });
    exists = true;
  } catch {
    // Secret does not exist
  }

  if (!exists) {
    console.log(`Creating secret ${secretName}...`);
    execCmd(create, { silent: true });
  }

  console.log(`Adding secret version to ${secretName}...`);
  execCmd(addVersion, {
    input: secretValue,
    silent: true,
  });
  console.log(`✓ Secret ${secretName} synced.`);
}

function getSecretValue(secretName: string, projectId: string): string {
  try {
    return execCmd(`gcloud.cmd secrets versions access latest --secret=${secretName} --project=${projectId}`, {
      silent: true,
    }).trim();
  } catch (err: unknown) {
    throw new Error(`Failed to read secret ${secretName} from Secret Manager: ${String(err)}`, { cause: err });
  }
}

/** Like getSecretValue but returns "" when the secret (or any version of it) does not exist yet. */
function readSecretIfExists(secretName: string, projectId: string): string {
  try {
    return getSecretValue(secretName, projectId);
  } catch {
    return "";
  }
}

/** Appends a comment block to an env file once (no-op if the first comment line is already present). */
function appendEnvComment(envPath: string, lines: string[]): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (lines[0] && existing.includes(lines[0])) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(envPath, existing + prefix + lines.join("\n") + "\n", "utf8");
}

/**
 * Settings the API reads that are not always needed (D85, D88): they are set on the Cloud Run
 * service when the env file (or shell) has them, and left off otherwise. MCP_AUTH_MODE and
 * MCP_LOCAL_USER_ID are deliberately absent: local no-login mode refuses to run on Cloud Run (D77).
 */
export const OPTIONAL_SERVICE_SETTINGS = ["MCP_OAUTH_TRUSTED_CLIENTS", "RP_ID", "TRUST_PROXY_HOPS"] as const;

/**
 * The JWT signing secret's name. matter.config.ts names it once a matter is set up
 * (new-matter writes `casefile-<slug>-jwt-secret`); the template's placeholder resolves to the
 * same pattern, so the template checkout can deploy an existing matter from its env file.
 */
export function jwtSecretName(matter: string): string {
  const configured = matterConfig.secrets.jwtSecret;
  return configured.includes("<") ? `casefile-${matter}-jwt-secret` : configured;
}

export async function deployMatter(
  matter: string,
  projectRef: string,
  phase: DeployPhase = "all",
  adminEmail = "",
  options: DeployOptions = {},
) {
  dryRun = Boolean(options.dryRun);
  const envFile = path.resolve(options.envFile || path.resolve(process.cwd(), `.env.${matter}`));
  const envFileValues = fs.existsSync(envFile) ? parseEnvFile(envFile) : {};
  rememberSecrets(envFileValues);
  rememberSecrets(process.env);

  const scanned = [projectRef, process.env.DATABASE_URL_MIGRATIONS];
  if (fs.existsSync(envFile)) scanned.push(fs.readFileSync(envFile, "utf8"));
  const refused = findRefusedProjectRefs(scanned.filter((t): t is string => Boolean(t)).join("\n"));
  if (refused.length > 0) {
    throw new Error("ABORT: the project ref or env file names a project this tool must never touch. Nothing was run.");
  }

  const projectId = process.env.GCP_PROJECT_ID || matterConfig.gcpProjectId;
  if (!projectId || projectId.includes("<")) {
    throw new Error(
      "GCP project ID is required: set GCP_PROJECT_ID in environment or gcpProjectId in matter.config.ts.\n" +
      "A dedicated project ID is required because every matter must have its own isolated Google Cloud project."
    );
  }

  const gcpRegion = process.env.GCP_REGION || matterConfig.gcpRegion;
  if (!gcpRegion || gcpRegion.includes("<")) {
    throw new Error(
      "GCP region is required: set GCP_REGION in environment or gcpRegion in matter.config.ts.\n" +
      "An explicit region is required to prevent accidental resource provisioning in fallback regions."
    );
  }

  const supabaseRegion = process.env.SUPABASE_REGION || matterConfig.supabaseRegion;
  if (!supabaseRegion || supabaseRegion.includes("<")) {
    throw new Error(
      "Supabase region is required: set SUPABASE_REGION in environment or supabaseRegion in matter.config.ts.\n" +
      "An explicit Supabase region is required to construct database pooler connection URLs."
    );
  }

  const bucketSources = `casefile-${matter}-sources`;
  const bucketArtifacts = `casefile-${matter}-artifacts`;
  const bucketExports = `casefile-${matter}-exports`;

  const saName = `casefile-${matter}-sa`;
  const saEmail = `${saName}@${projectId}.iam.gserviceaccount.com`;
  const serviceName = `casefile-${matter}-api`;
  const image = `${gcpRegion}-docker.pkg.dev/${projectId}/casefile/casefile-api:${matter}`;
  const jwtSecretId = jwtSecretName(matter);

  const supabaseToken = process.env.SUPABASE_ACCESS_TOKEN;
  const ownerMigrationUrl = process.env.DATABASE_URL_MIGRATIONS;

  console.log("================================================================================");
  console.log(`${dryRun ? "DRY RUN — NOTHING WILL BE RUN OR WRITTEN — " : ""}DEPLOYING MATTER INFRASTRUCTURE: ${matter.toUpperCase()} (Phase: ${phase.toUpperCase()})`);
  console.log("================================================================================");
  console.log(`Matter Name:          ${matter}`);
  console.log(`Supabase Project Ref: ${projectRef}`);
  console.log(`GCP Project:          ${projectId}`);
  console.log(`Region:               ${gcpRegion}`);
  console.log(`Service Name:         ${serviceName}`);
  console.log(`Service Account:      ${saEmail}`);
  console.log(`Env file:             ${envFile}${fs.existsSync(envFile) ? "" : " (does not exist yet)"}`);
  console.log("────────────────────────────────────────────────────────────────────────────────\n");

  const supabaseUrl = `https://${projectRef}.supabase.co`;
  let jwtSecret: string;
  let bootstrapResult: {
    tenantId: string;
    workspaceId: string;
    userId: string;
    investigationId: string;
    token: string;
    adminEmail: string;
    adminPassword?: string | undefined;
  } | null = null;

  // ── PHASE: DATABASE OR ALL ──────────────────────────────────────────────────
  if (phase === "database" || phase === "all") {
    // bootstrap() writes .env.<matter> in the directory it is given.
    if (path.basename(envFile) !== `.env.${matter}`) {
      throw new Error(`The database phase records the matter in .env.${matter}; --env must name a file called .env.${matter} (got ${envFile}).`);
    }
    let appPoolerUrl: string;
    // ── Step 1: Create or Adopt 3 GCS Buckets ────────────────────────────────
    console.log("=== Step 1: Object Storage Buckets Configuration ===");
    const bucketResults: BucketEnsureResult[] = [];
    for (const b of [bucketSources, bucketArtifacts, bucketExports]) {
      const res = await ensureBucket(b, gcpRegion, projectId);
      bucketResults.push(res);
    }
    if (!dryRun) {
      console.log("\nBucket Adoption Report:");
      for (const r of bucketResults) {
        console.log(`  gs://${r.name}: ${r.action.toUpperCase()}`);
      }
    }

    // ── Step 2: Fetch Supabase Project API Keys ────────────────────────────
    console.log("\n=== Step 2: Fetching Supabase Project API Keys ===");
    const keysCmd = `npx supabase projects api-keys --project-ref ${projectRef} --reveal --output json`;
    let anonKey: string;
    let secretKey: string;
    if (dryRun) {
      would(`supabase (read): ${keysCmd}   (SUPABASE_ACCESS_TOKEN: ${supabaseToken ? "set, ***" : "not set"})`);
      anonKey = "<publishable key read from Supabase>";
      secretKey = "<secret key read from Supabase, if any>";
    } else {
      let keysOutput = "";
      for (let attempt = 1; attempt <= 15; attempt++) {
        try {
          keysOutput = execCmd(keysCmd, { silent: true, env: supabaseToken ? { SUPABASE_ACCESS_TOKEN: supabaseToken } : undefined });
          if (keysOutput.includes("anon") || keysOutput.includes("service")) {
            break;
          }
        } catch {
          console.log(`[Attempt ${attempt}] Waiting for Supabase API keys to become available...`);
        }
        await new Promise((r) => setTimeout(r, 4000));
      }

      interface SupabaseApiKey {
        name?: string;
        tags?: string;
        api_key?: string;
        key?: string;
      }
      const keysStart = keysOutput.indexOf("[");
      if (keysStart === -1) {
        throw new Error(`Failed to retrieve API keys for project ref ${projectRef}. Ensure SUPABASE_ACCESS_TOKEN is valid.`);
      }
      const keys = JSON.parse(keysOutput.slice(keysStart)) as SupabaseApiKey[];
      const anonKeyObj = keys.find((k) => k.name === "anon" || k.tags === "anon");
      const secretKeyObj = keys.find((k) => k.name?.startsWith("service") || k.tags?.startsWith("service"));

      anonKey = anonKeyObj ? (anonKeyObj.api_key || anonKeyObj.key || "") : "";
      secretKey = secretKeyObj ? (secretKeyObj.api_key || secretKeyObj.key || "") : "";

      if (!anonKey) {
        throw new Error("Could not find publishable 'anon' key for project.");
      }

      console.log(`✓ Supabase URL: ${supabaseUrl}`);
      console.log(`✓ Publishable Key: ${anonKey.slice(0, 16)}...`);
      console.log(`✓ Admin Secret Key present: ${Boolean(secretKey)}`);
    }

    // ── Step 3: Connect to DB via Owner Connection ─────────────────────────
    console.log("\n=== Step 3: Validating Target Database Connection & Schema Cleanliness ===");
    if (!ownerMigrationUrl) {
      throw new Error(
        "DATABASE_URL_MIGRATIONS environment variable is required to provision the database.\n" +
        `It must contain owner credentials (e.g. postgres.<ref>:password@aws-0-${supabaseRegion}.pooler.supabase.com:5432/postgres).`
      );
    }

    // No connection at all in a dry run.
    const ownerSql = dryRun ? null : postgres(ownerMigrationUrl, { max: 1 });
    const owner = (): postgres.Sql => {
      if (!ownerSql) throw new Error("--dry-run must not open a database connection");
      return ownerSql;
    };
    try {
      if (dryRun) {
        would(`database: connect to DATABASE_URL_MIGRATIONS (${ownerMigrationUrl}) as the owner`);
        would("database (read): SELECT 1; SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        would("  abort if the public schema has tables but no schema_migrations (someone else's database)");
      } else {
        await owner()`SELECT 1 as healthy;`;
        console.log("✓ Connected to database using owner migration credentials.");

        // Validate that public schema is clean or contains only our migrations
        const tables = await owner()<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables WHERE schemaname = 'public';
        `;
        const hasSchemaMigrations = tables.some((t) => t.tablename === "schema_migrations");

        if (tables.length > 0 && !hasSchemaMigrations) {
          throw new Error(
            `ABORT: Target project ${projectRef} has ${tables.length} existing tables in public schema but no schema_migrations.\n` +
            "Refusing to deploy to an existing foreign database."
          );
        }

        if (tables.length > 0 && hasSchemaMigrations) {
          console.log(`Found ${tables.length} existing tables with schema_migrations history. Verifying migration safety...`);
        } else {
          console.log("✓ Target project public schema is empty and ready for initialization.");
        }
      }

      // ── Step 4: Enable Extensions & Create casefile_app Role ───────────────
      console.log("\n=== Step 4: Enabling Extensions & Provisioning Unprivileged casefile_app Role ===");
      const appPassword = generateSafePassword(24);
      if (!/^[a-zA-Z0-9!_\-^.~$]+$/.test(appPassword)) {
        throw new Error("Generated appPassword contains unexpected characters outside safe charset.");
      }
      secretValues.add(appPassword);
      if (dryRun) {
        would("database (DDL): CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm");
        would("database (DDL): CREATE ROLE casefile_app (or ALTER ROLE if it exists) LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '***'   (a NEW random password)");
        would("database (DDL): GRANT CONNECT ON DATABASE postgres TO casefile_app; GRANT USAGE ON SCHEMA public TO casefile_app");
        would("database (DDL): ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES / USAGE, SELECT ON SEQUENCES / ALL ON FUNCTIONS TO casefile_app");
      } else {
        await owner()`CREATE EXTENSION IF NOT EXISTS vector;`;
        await owner()`CREATE EXTENSION IF NOT EXISTS pg_trgm;`;

        await owner().unsafe(`
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'casefile_app') THEN
              CREATE ROLE casefile_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}';
            ELSE
              ALTER ROLE casefile_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}';
            END IF;
          END
          $$;
        `);

        await owner()`GRANT CONNECT ON DATABASE postgres TO casefile_app;`;
        await owner()`GRANT USAGE ON SCHEMA public TO casefile_app;`;
        await owner()`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO casefile_app;`;
        await owner()`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO casefile_app;`;
        await owner()`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO casefile_app;`;
        console.log("✓ Extensions enabled and casefile_app role provisioned (NOSUPERUSER, NOBYPASSRLS).");
      }

      // ── Step 5: Run Schema Migrations through Preflight Guard ─────────────
      console.log("\n=== Step 5: Applying Schema Migrations ===");
      if (dryRun) {
        const files = fs.readdirSync(path.resolve(import.meta.dirname, "../packages/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
        would(`database (DDL): apply, through the migration pre-flight guard (--project-ref ${projectRef}), every one of these ${files.length} files not yet in schema_migrations:`);
        would(`  ${files.join(", ")}`);
        would("  (which ones are missing: pnpm matter:preflight --env <file>)");
      } else {
        await migrate({
          dbUrl: ownerMigrationUrl,
          projectRef,
        });
        console.log("✓ Migrations applied successfully through preflight guard.");
      }

      // Construct app pooler URL
      const encodedAppPassword = encodeURIComponent(appPassword);
      appPoolerUrl = `postgresql://casefile_app.${projectRef}:${encodedAppPassword}@aws-0-${supabaseRegion}.pooler.supabase.com:5432/postgres`;

      // ── Step 6: Store Secrets in Secret Manager ───────────────────────────
      console.log("\n=== Step 6: Syncing Matter Secrets to Secret Manager ===");
      await ensureSecret(`casefile-${matter}-database-url`, appPoolerUrl, projectId);
      await ensureSecret(`casefile-${matter}-supabase-url`, supabaseUrl, projectId);
      await ensureSecret(`casefile-${matter}-supabase-publishable-key`, anonKey, projectId);
      // The shared static MCP token is retired (D73): /mcp takes each person's OAuth sign-in.
      // This script no longer creates, updates, mounts or grants access to
      // casefile-<matter>-mcp-token, and it never deletes or disables it. Disabling an existing
      // matter's token is a manual step (docs/UPGRADE-LIVE-MATTER.md, step 9).
      if (secretKey) {
        await ensureSecret(`casefile-${matter}-supabase-secret-key`, secretKey, projectId);
      }

      // JWT_SECRET — generated ONCE per matter and reused on every later run. ensureSecret()
      // unconditionally adds a new version, so regenerating here would invalidate every live
      // session on the matter. (The retired static MCP token had exactly that defect — recorded
      // in DEV-018, deliberately not copied here.) The secret name is owned by matter.config.ts.
      if (dryRun) {
        would(`gcloud (read):  gcloud.cmd secrets versions access latest --secret=${jwtSecretId} --project=${projectId}`);
        would(`  if it exists: reuse it (no new version)`);
        would(`  if missing:   generate a 48-character JWT_SECRET and add it as the first version of ${jwtSecretId}`);
        jwtSecret = "<JWT_SECRET from Secret Manager>";
      } else {
        jwtSecret = readSecretIfExists(jwtSecretId, projectId);
        if (!jwtSecret) {
          jwtSecret = generateSafePassword(48);
          await ensureSecret(jwtSecretId, jwtSecret, projectId);
          console.log(`✓ Generated JWT_SECRET and stored it in ${jwtSecretId}.`);
        } else {
          console.log(`✓ Reusing existing JWT_SECRET from ${jwtSecretId} (no new version added).`);
        }
        // bootstrap() below signs an operator JWT locally through signJwt(), which reads
        // process.env.JWT_SECRET. It must be the same value the deployed service verifies with.
        process.env.JWT_SECRET = jwtSecret;
      }

      // ── Step 7: Create & Scope Service Account ────────────────────────────
      console.log("\n=== Step 7: Provisioning Scoped Service Account & IAM Bindings ===");
      const saDescribe = `gcloud.cmd iam service-accounts describe ${saEmail} --project=${projectId}`;
      const saCreate = `gcloud.cmd iam service-accounts create ${saName} --display-name="Casefile ${matter} Runtime SA" --project=${projectId}`;
      const bucketBinding = (bucket: string) =>
        `gcloud.cmd storage buckets add-iam-policy-binding gs://${bucket} --member="serviceAccount:${saEmail}" --role="roles/storage.objectUser" --project=${projectId}`;
      const runtimeSecrets = [
        `casefile-${matter}-database-url`,
        `casefile-${matter}-supabase-url`,
        `casefile-${matter}-supabase-publishable-key`,
        jwtSecretId,
      ];
      const secretBinding = (secret: string) =>
        `gcloud.cmd secrets add-iam-policy-binding ${secret} --member="serviceAccount:${saEmail}" --role="roles/secretmanager.secretAccessor" --project=${projectId}`;
      const enableIamCredentials = `gcloud.cmd services enable iamcredentials.googleapis.com --project=${projectId}`;
      const tokenCreator = (member: string) =>
        `gcloud.cmd iam service-accounts add-iam-policy-binding ${saEmail} --member="${member}" --role="roles/iam.serviceAccountTokenCreator" --project=${projectId}`;

      if (dryRun) {
        would(`gcloud (read):  ${saDescribe}`);
        would(`  if missing:   gcloud (write): ${saCreate}`);
        for (const bucket of [bucketSources, bucketArtifacts, bucketExports]) would(`gcloud (write): ${bucketBinding(bucket)}`);
        for (const secret of runtimeSecrets) would(`gcloud (write): ${secretBinding(secret)}`);
        would(`gcloud (write): ${enableIamCredentials}`);
        would(`gcloud (write): ${tokenCreator(`serviceAccount:${saEmail}`)}`);
        would("gcloud (read):  gcloud.cmd config get-value account");
        would(`gcloud (write): ${tokenCreator("user:<the operator account from gcloud config>")}`);
      } else {
        let saExists = false;
        try {
          execCmd(saDescribe, { silent: true });
          saExists = true;
        } catch {
          // SA does not exist
        }

        if (!saExists) {
          console.log(`Creating service account: ${saName}...`);
          execCmd(saCreate, { silent: true });
        }

        console.log("Granting objectUser permissions on matter buckets...");
        for (const bucket of [bucketSources, bucketArtifacts, bucketExports]) {
          execCmd(bucketBinding(bucket), { silent: true });
        }

        console.log("Granting secretAccessor permissions on runtime secrets...");
        for (const secret of runtimeSecrets) {
          execCmd(secretBinding(secret), { silent: true });
        }

        console.log("Enabling IAM Credentials API (iamcredentials.googleapis.com)...");
        execCmd(enableIamCredentials, { silent: true });

        console.log("Granting serviceAccountTokenCreator on service account (keyless URL signing)...");
        execCmd(tokenCreator(`serviceAccount:${saEmail}`), { silent: true });

        let operatorAccount = "";
        try {
          operatorAccount = execCmd("gcloud.cmd config get-value account", { silent: true }).trim();
        } catch {
          // Operator account unavailable
        }
        if (operatorAccount && operatorAccount.includes("@")) {
          console.log(`Granting serviceAccountTokenCreator to operator user: ${operatorAccount}...`);
          execCmd(tokenCreator(`user:${operatorAccount}`), { silent: true });
        }
        console.log("✓ Service account scoped with keyless URL signing privileges.");
      }

      // ── Step 8: Bootstrap Matter Context ──────────────────────────────────
      console.log("\n=== Step 8: Bootstrapping Matter Tenant Context ===");
      if (!adminEmail) {
        throw new Error(
          "An admin login email is required: pass --admin-email <email> (or set MATTER_ADMIN_EMAIL). There is no derived default."
        );
      }
      const envKeys = [
        "DATABASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "GCP_PROJECT_ID", "GCS_SERVICE_ACCOUNT_EMAIL",
        "GCS_BUCKET_SOURCES", "GCS_BUCKET_ARTIFACTS", "GCS_BUCKET_EXPORTS", "STORAGE_DRIVER", "MATTER_TENANT_ID",
        "MATTER_ADMIN_USER_ID", "MATTER_WORKSPACE_ID", "MATTER_INVESTIGATION_ID", "MATTER_ADMIN_EMAIL", "JWT_SECRET",
      ];
      if (dryRun) {
        would(`database (write): bootstrap the matter tenant for ${adminEmail} through DATABASE_URL (casefile_app) — or re-attach to the tenant already recorded in ${path.basename(envFile)}`);
        would("  a fresh tenant gets: organization, workspace, admin user with a random password, investigation, memberships, two audit events");
        would(`file (write): ${envFile} — set ${envKeys.join(", ")}`);
        if (phase === "database") {
          console.log("\n================================================================================");
          console.log(`DRY RUN COMPLETE FOR ${matter.toUpperCase()} (PHASE DATABASE): nothing was run, connected to or written.`);
          console.log("================================================================================");
          return { matter, projectRef, bootstrap: null };
        }
      } else {
        // bootstrap() records the tenant ids and the random admin password in .env.<matter>
        // itself, and re-attaches to that tenant on a re-run. Everything below is merged into
        // the same file; nothing overwrites it.
        bootstrapResult = await bootstrap({
          name: `${matter.charAt(0).toUpperCase() + matter.slice(1)} Matter`,
          investigationName: "Primary Investigation",
          email: adminEmail,
          matter,
          envDir: path.dirname(envFile),
          dbUrl: appPoolerUrl,
        });

        upsertEnvFile(envFile, {
          DATABASE_URL: appPoolerUrl,
          SUPABASE_URL: supabaseUrl,
          SUPABASE_PUBLISHABLE_KEY: anonKey,
          GCP_PROJECT_ID: projectId,
          GCS_SERVICE_ACCOUNT_EMAIL: saEmail,
          GCS_BUCKET_SOURCES: bucketSources,
          GCS_BUCKET_ARTIFACTS: bucketArtifacts,
          GCS_BUCKET_EXPORTS: bucketExports,
          STORAGE_DRIVER: "gcs",
          MATTER_TENANT_ID: bootstrapResult.tenantId,
          MATTER_ADMIN_USER_ID: bootstrapResult.userId,
          MATTER_WORKSPACE_ID: bootstrapResult.workspaceId,
          MATTER_INVESTIGATION_ID: bootstrapResult.investigationId,
          MATTER_ADMIN_EMAIL: bootstrapResult.adminEmail,
        });
        appendEnvComment(envFile, [
          `# JWT_SECRET must equal the Secret Manager value mounted on the Cloud Run service (${jwtSecretId}).`,
          `# tools/ingest-cli/src/bootstrap.ts signs JWTs locally with this value; if it differs from the deployed`,
          `# service's, those tokens fail against the API with no useful error.`,
        ]);
        upsertEnvFile(envFile, { JWT_SECRET: jwtSecret });
        console.log(`✓ Environment file written to .env.${matter} (gitignored)`);
        if (bootstrapResult.adminPassword) {
          console.log(`✓ Admin login: ${bootstrapResult.adminEmail} / ${bootstrapResult.adminPassword.slice(0, 8)}…  (full password only in .env.${matter})`);
        } else {
          console.log(`✓ Admin login: ${bootstrapResult.adminEmail} (existing user; password unchanged, see .env.${matter})`);
        }

        if (phase === "database") {
          console.log("\n================================================================================");
          console.log(`PHASE 1 (DATABASE & INFRASTRUCTURE) COMPLETE FOR ${matter.toUpperCase()}`);
          console.log("================================================================================");
          console.log(`Tenant ID:        ${bootstrapResult.tenantId}`);
          console.log(`Investigation ID: ${bootstrapResult.investigationId}`);
          console.log(`Database URL:     postgresql://casefile_app.${projectRef}:***@...`);
          console.log(`Sources Bucket:   gs://${bucketSources}`);
          console.log("\nNext Steps for Ingestion:");
          console.log(`  1. Copy .env.${matter} to .env (or pass environment variables).`);
          console.log(`  2. Ingest documents:`);
          console.log(`     pnpm ingest --bucket ${bucketSources} --investigation ${bootstrapResult.investigationId}`);
          console.log(`  3. After ingestion completes, deploy Cloud Run service:`);
          console.log(`     pnpm tsx scripts/deploy-matter.ts --matter ${matter} --project-ref ${projectRef} --phase=service`);
          console.log("================================================================================");
          return {
            matter,
            projectRef,
            bootstrap: bootstrapResult,
          };
        }
      }
    } finally {
      if (ownerSql) await ownerSql.end();
    }
  }

  // ── PHASE: SERVICE OR ALL ───────────────────────────────────────────────────
  if (phase === "workers") {
    return deployIngestJobs({ matter, projectRef, envFile, projectId, gcpRegion, saEmail, image, bucketSources, bucketArtifacts, bucketExports, workers: options.workers });
  }

  if (phase === "service" || phase === "all") {
    console.log("\n=== Step 9: Deploying Cloud Run Service ===");

    let tenantId = bootstrapResult?.tenantId;
    let investigationId = bootstrapResult?.investigationId;
    let adminUserId = bootstrapResult?.userId;

    let mcpPublicUrl = process.env.MCP_PUBLIC_URL?.trim() || "";
    // Optional API settings: set on the service when the shell or the env file has them.
    const optional = new Map<string, string>();
    for (const name of OPTIONAL_SERVICE_SETTINGS) {
      const v = process.env[name]?.trim();
      if (v) optional.set(name, v);
    }
    let knownServiceUrl = "";
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (!tenantId && line.startsWith("MATTER_TENANT_ID=")) tenantId = line.slice("MATTER_TENANT_ID=".length).trim();
        if (!investigationId && line.startsWith("MATTER_INVESTIGATION_ID=")) investigationId = line.slice("MATTER_INVESTIGATION_ID=".length).trim();
        if (!adminUserId && line.startsWith("MATTER_ADMIN_USER_ID=")) adminUserId = line.slice("MATTER_ADMIN_USER_ID=".length).trim();
        if (!mcpPublicUrl && line.startsWith("MCP_PUBLIC_URL=")) mcpPublicUrl = line.slice("MCP_PUBLIC_URL=".length).trim();
        for (const name of OPTIONAL_SERVICE_SETTINGS) {
          const v = line.startsWith(`${name}=`) ? line.slice(name.length + 1).trim() : "";
          if (v && !optional.has(name)) optional.set(name, v);
        }
        if (line.startsWith("SERVICE_URL=")) knownServiceUrl = line.slice("SERVICE_URL=".length).trim().replace(/\/+$/, "");
      }
    }
    if (dryRun && !tenantId && phase === "all") {
      tenantId = "<MATTER_TENANT_ID from bootstrap>";
      investigationId = "<MATTER_INVESTIGATION_ID from bootstrap>";
    }

    if (!tenantId || !investigationId) {
      throw new Error(
        `Could not resolve MATTER_TENANT_ID and MATTER_INVESTIGATION_ID. Ensure ${envFile} exists or run --phase=database first.`
      );
    }

    // MCP_PUBLIC_URL (D69): the /mcp URL users add to Claude; the API refuses to start without
    // it. An explicit value wins, then the service URL recorded by an earlier deploy. A first
    // deploy has neither, and the URL is not guessed: the operator sets it.
    if (!mcpPublicUrl && knownServiceUrl) mcpPublicUrl = `${knownServiceUrl}/mcp`;
    if (!mcpPublicUrl) {
      throw new Error(
        `MCP_PUBLIC_URL is not set and ${envFile} has no SERVICE_URL yet. Set MCP_PUBLIC_URL in that file ` +
          `to the service's Cloud Run URL followed by /mcp (canonical: https, lowercase host, no trailing slash), then run this again.`,
      );
    }
    console.log(`MCP_PUBLIC_URL: ${mcpPublicUrl}`);
    console.log(`MCP_OAUTH_TRUSTED_CLIENTS: ${optional.get("MCP_OAUTH_TRUSTED_CLIENTS") || "not set (the API's default: Claude Code only)"}`);
    const otherOptional = OPTIONAL_SERVICE_SETTINGS.filter((n) => n !== "MCP_OAUTH_TRUSTED_CLIENTS" && optional.has(n));
    console.log(`Other optional settings: ${otherOptional.length > 0 ? otherOptional.map((n) => `${n}=${optional.get(n)}`).join(", ") : "none"}`);

    // Build and push the image from this checkout, unless --no-build. Cloud Run records the
    // image digest on each revision, so moving the tag leaves earlier revisions intact for rollback.
    const buildSteps = [
      `gcloud.cmd auth configure-docker ${gcpRegion}-docker.pkg.dev --quiet`,
      `docker build --platform=linux/amd64 -t ${image} .`,
      `docker push ${image}`,
    ];
    if (options.noBuild) {
      console.log(`--no-build: redeploying the image already at ${image}.`);
    } else if (dryRun) {
      would(`local (write): ${buildSteps[0]}   (docker credential helper for Artifact Registry)`);
      would(`local: ${buildSteps[1]}   (from ${process.cwd()})`);
      would(`artifact registry (write): ${buildSteps[2]}`);
    } else {
      console.log(`Building and pushing ${image} from ${process.cwd()}...`);
      for (const step of buildSteps) execCmd(step, { silent: true });
      console.log(`✓ Image pushed: ${image}`);
    }

    // Every name in apps/api/src/config/required-secrets.ts must appear here;
    // guardrails/secret-hygiene.spec.ts fails otherwise.
    const secretsFlag = [
      `DATABASE_URL=casefile-${matter}-database-url:latest`,
      `SUPABASE_URL=casefile-${matter}-supabase-url:latest`,
      `SUPABASE_PUBLISHABLE_KEY=casefile-${matter}-supabase-publishable-key:latest`,
      `JWT_SECRET=${jwtSecretId}:latest`,
    ].join(",");

    // Every name in apps/api/src/config/required-settings.ts must appear here too.
    // --set-env-vars REPLACES every variable on the service, so the optional settings are added
    // here from the env file. A value with a comma (MCP_OAUTH_TRUSTED_CLIENTS is a list) makes the
    // flag use gcloud's alternate delimiter syntax (`gcloud topic escaping`): "^;^A=1;B=2".
    const optionalVars = [...optional].map(([name, value]) => `${name}=${value}`);
    const altDelimiter = optionalVars.some((v) => v.includes(","));
    const envVarsFlag = [
      `MCP_PUBLIC_URL=${mcpPublicUrl}`,
      "NODE_ENV=production",
      "STORAGE_DRIVER=gcs",
      `GCP_PROJECT_ID=${projectId}`,
      `GCS_SERVICE_ACCOUNT_EMAIL=${saEmail}`,
      `GCS_BUCKET_SOURCES=${bucketSources}`,
      `GCS_BUCKET_ARTIFACTS=${bucketArtifacts}`,
      `GCS_BUCKET_EXPORTS=${bucketExports}`,
      `MATTER_TENANT_ID=${tenantId}`,
      `MATTER_INVESTIGATION_ID=${investigationId}`,
      ...optionalVars,
    ].join(altDelimiter ? ";" : ",");
    const envVarsArg = altDelimiter ? `^;^${envVarsFlag}` : envVarsFlag;

    const deployCmd = [
      "gcloud.cmd run deploy",
      serviceName,
      `--image=${image}`,
      `--region=${gcpRegion}`,
      `--project=${projectId}`,
      `--service-account=${saEmail}`,
      `--set-secrets="${secretsFlag}"`,
      `--set-env-vars="${envVarsArg}"`,
      "--port=8080",
      "--memory=512Mi",
      "--cpu=1",
      "--allow-unauthenticated",
      "--format=json",
    ].join(" ");

    let serviceUrl: string;
    if (dryRun) {
      would(`gcloud (write): ${deployCmd}`);
      would("  creates a new revision and sends it all traffic; the previous revision stays for rollback");
      would("  --set-secrets / --set-env-vars REPLACE the old lists, so the retired MCP_TOKEN mount is not carried over");
      serviceUrl = knownServiceUrl || "<the service URL gcloud returns>";
    } else {
      console.log(`Executing: gcloud run deploy ${serviceName}...`);
      const deployResult = execCmd(deployCmd, { silent: true });
      const parsedDeploy = JSON.parse(deployResult);
      serviceUrl = parsedDeploy.status?.url || parsedDeploy.status?.address?.url || "";
      console.log(`✓ Cloud Run Service Deployed: ${serviceUrl}`);
    }
    if (!dryRun && serviceUrl && `${serviceUrl.replace(/\/+$/, "")}/mcp` !== mcpPublicUrl) {
      console.warn(
        `WARNING: MCP_PUBLIC_URL (${mcpPublicUrl}) is not ${serviceUrl}/mcp. Both Cloud Run URLs reach the service, ` +
          `but Claude must be given MCP_PUBLIC_URL exactly, or sign-in fails. Set MCP_PUBLIC_URL in ${envFile} to change it.`,
      );
    }

    // Update the env file with SERVICE_URL
    if (dryRun) {
      would(`file (write): ${envFile} — add SERVICE_URL=${serviceUrl} if it has no SERVICE_URL line`);
    } else if (fs.existsSync(envFile)) {
      let content = fs.readFileSync(envFile, "utf8");
      if (!content.includes("SERVICE_URL=")) {
        content += `SERVICE_URL=${serviceUrl}\n`;
        fs.writeFileSync(envFile, content, "utf8");
      }
    }

    if (dryRun) {
      console.log("\n================================================================================");
      console.log(`DRY RUN COMPLETE FOR ${matter.toUpperCase()} (PHASE ${phase.toUpperCase()}): nothing was run, connected to or written.`);
      console.log("================================================================================");
      return { matter, projectRef, serviceUrl, bootstrap: null };
    }

    // No header and no shared token: Claude signs each person in with their own Casefile
    // account (OAuth, D69/D73) when the connector is first used.
    const claudeDesktopHttpSnippet = {
      mcpServers: {
        [`casefile-${matter}`]: {
          type: "http",
          url: mcpPublicUrl,
        },
      },
    };

    const claudeDesktopStdioSnippet = {
      mcpServers: {
        [`casefile-${matter}-stdio`]: {
          command: "node",
          args: ["/path/to/casefile/packages/mcp/dist/index.js"],
          env: {
            DATABASE_URL: `postgresql://casefile_app.<SUPABASE_PROJECT_REF>:<APP_PASSWORD>@aws-0-${supabaseRegion}.pooler.supabase.com:5432/postgres`,
            MATTER_TENANT_ID: tenantId,
            MATTER_INVESTIGATION_ID: investigationId,
            // D77: the stdio server runs as this real user and refuses to start without one.
            MCP_LOCAL_USER_ID: "<YOUR_CASEFILE_USER_ID>",
            STORAGE_DRIVER: "gcs",
            GCP_PROJECT_ID: projectId,
            GCS_SERVICE_ACCOUNT_EMAIL: saEmail,
            GCS_BUCKET_SOURCES: bucketSources,
            GCS_BUCKET_ARTIFACTS: bucketArtifacts,
          },
        },
      },
    };

    console.log("================================================================================");
    console.log("MATTER DEPLOYMENT COMPLETE!");
    console.log("================================================================================");
    console.log(`Matter Name:      ${matter}`);
    console.log(`Service URL:      ${serviceUrl}`);
    console.log(`Tenant ID:        ${tenantId}`);
    console.log(`Investigation ID: ${investigationId}`);
    console.log(`Admin User ID:    ${adminUserId || "N/A"}`);
    console.log(`MCP URL:          ${mcpPublicUrl}  (Claude: add as a custom connector, then sign in)`);
    console.log(`\nPrimary Claude Desktop Config (Remote HTTP - Recommended):\n${JSON.stringify(claudeDesktopHttpSnippet, null, 2)}`);
    console.log(`\nOptional Claude Desktop Config (Local stdio):\n${JSON.stringify(claudeDesktopStdioSnippet, null, 2)}`);
    console.log(`\nFull configuration saved in ${envFile} (gitignored)`);
    console.log("================================================================================");

    return {
      matter,
      projectRef,
      serviceUrl,
      bootstrap: bootstrapResult,
    };
  }
}

/**
 * BIGDATA-4 (plan section 16, F): the matter's ingest jobs. Both run the image the service phase
 * built (it holds tools/ingest-cli), as the matter's own service account, whose IAM bindings reach
 * only this matter's buckets and secrets (Step 8), with the database URL from the matter's own
 * secret: a task can reach only this matter's database and buckets. The sources bucket is mounted
 * read-only at /mnt/sources (Cloud Storage volume) so a PST is read in place by every part's task
 * instead of being downloaded whole by each. Written, not run: execute them with
 *   gcloud run jobs execute casefile-<matter>-ingest-enqueue --args=...   (prints the run id)
 *   gcloud run jobs execute casefile-<matter>-ingest-workers --update-env-vars=INGEST_RUN_ID=<run id>
 * (docs/RUNBOOK-INGEST.md, "Many workers").
 */
async function deployIngestJobs(o: {
  matter: string; projectRef: string; envFile: string; projectId: string; gcpRegion: string; saEmail: string; image: string;
  bucketSources: string; bucketArtifacts: string; bucketExports: string; workers?: number | undefined;
}) {
  console.log("\n=== Step 10: Ingest Cloud Run jobs (BIGDATA-4) ===");
  const workers = o.workers ?? matterConfig.ingestWorkers;
  if (!Number.isInteger(workers) || workers < 1 || workers > 1000) {
    throw new Error(`--workers must be a whole number from 1 to 1000 (got ${String(o.workers ?? matterConfig.ingestWorkers)})`);
  }
  let tenantId = process.env.MATTER_TENANT_ID?.trim() || "";
  let investigationId = process.env.MATTER_INVESTIGATION_ID?.trim() || "";
  if (fs.existsSync(o.envFile)) {
    const values = parseEnvFile(o.envFile);
    tenantId = values.MATTER_TENANT_ID?.trim() || tenantId;
    investigationId = values.MATTER_INVESTIGATION_ID?.trim() || investigationId;
  }
  if (!tenantId || !investigationId) {
    throw new Error(`Could not resolve MATTER_TENANT_ID and MATTER_INVESTIGATION_ID. Ensure ${o.envFile} exists or run --phase=database first.`);
  }
  const secrets = `DATABASE_URL=casefile-${o.matter}-database-url:latest`;
  const envVars = [
    "NODE_ENV=production",
    "STORAGE_DRIVER=gcs",
    `GCP_PROJECT_ID=${o.projectId}`,
    `GCS_SERVICE_ACCOUNT_EMAIL=${o.saEmail}`,
    `GCS_BUCKET_SOURCES=${o.bucketSources}`,
    `GCS_BUCKET_ARTIFACTS=${o.bucketArtifacts}`,
    `GCS_BUCKET_EXPORTS=${o.bucketExports}`,
    `MATTER_TENANT_ID=${tenantId}`,
    `MATTER_INVESTIGATION_ID=${investigationId}`,
    `INGEST_BUCKET_MOUNTS=${o.bucketSources}=/mnt/sources`,
  ].join(",");
  const mount = `--add-volume=name=sources,type=cloud-storage,bucket=${o.bucketSources},readonly=true --add-volume-mount=volume=sources,mount-path=/mnt/sources`;
  const common = [
    `--image=${o.image}`,
    `--region=${o.gcpRegion}`,
    `--project=${o.projectId}`,
    `--service-account=${o.saEmail}`,
    `--set-secrets="${secrets}"`,
    `--set-env-vars="${envVars}"`,
    mount,
    "--task-timeout=86400s",
    "--memory=2Gi",
    "--command=node",
  ];
  const enqueueCmd = [
    "gcloud.cmd run jobs deploy", `casefile-${o.matter}-ingest-enqueue`, ...common,
    "--tasks=1", "--parallelism=1", "--max-retries=0", "--cpu=1",
    `--args=./node_modules/tsx/dist/cli.mjs,tools/ingest-cli/src/ingest.ts,--bucket,${o.bucketSources},--enqueue-only`,
  ].join(" ");
  const workersCmd = [
    "gcloud.cmd run jobs deploy", `casefile-${o.matter}-ingest-workers`, ...common,
    `--tasks=${workers}`, `--parallelism=${workers}`, "--max-retries=3", "--cpu=2",
    "--args=./node_modules/tsx/dist/cli.mjs,tools/ingest-cli/src/worker.ts",
  ].join(" ");
  console.log(`Workers: ${workers} task(s) sharing one run's queue (the queue is a table in the matter's database; plan answer 9)`);
  console.log(`Image:   ${o.image} (the one the service phase built and pushed; run --phase=service first on a new checkout)`);
  if (dryRun) {
    would(`gcloud (write): ${enqueueCmd}`);
    would(`gcloud (write): ${workersCmd}`);
    would("  each task is one worker: it takes items from the run given by INGEST_RUN_ID at execution, with a lease; a stopped task's items are taken again");
    would("  database connections: up to 4 per task (the Supabase pooler's limit applies)");
    console.log("\n================================================================================");
    console.log(`DRY RUN COMPLETE FOR ${o.matter.toUpperCase()} (PHASE WORKERS): nothing was run, connected to or written.`);
    console.log("================================================================================");
    return { matter: o.matter, projectRef: o.projectRef, serviceUrl: "", bootstrap: null };
  }
  console.log(`Executing: gcloud run jobs deploy casefile-${o.matter}-ingest-enqueue...`);
  execCmd(enqueueCmd, { silent: true });
  console.log(`Executing: gcloud run jobs deploy casefile-${o.matter}-ingest-workers...`);
  execCmd(workersCmd, { silent: true });
  console.log(`✓ Ingest jobs defined: casefile-${o.matter}-ingest-enqueue, casefile-${o.matter}-ingest-workers (${workers} tasks)`);
  return { matter: o.matter, projectRef: o.projectRef, serviceUrl: "", bootstrap: null };
}

/** --env: the file's values win over the shell, so the named matter is the one deployed. */
function loadEnvFileIntoProcess(envFile: string): void {
  for (const [key, value] of Object.entries(parseEnvFile(envFile))) process.env[key] = value;
}

async function runCli() {
  const { matter, projectRef, phase, adminEmail, options } = parseArgs();
  try {
    if (options.envFile) {
      if (!fs.existsSync(options.envFile)) throw new Error(`--env file not found: ${path.resolve(options.envFile)}`);
      loadEnvFileIntoProcess(options.envFile);
    }
    await deployMatter(matter, projectRef, phase, adminEmail, options);
  } catch (err) {
    console.error("\nDeployment failed:", maskSecrets(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || "")) {
  runCli();
}
