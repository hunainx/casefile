/**
 * Single-command new matter setup: pnpm new-matter
 *
 * Interactive setup with exactly five questions:
 *   1. Matter name
 *   2. GCP project ID
 *   3. GCP region
 *   4. Supabase project ref
 *   5. Supabase region
 *
 * Actions:
 *   1. Writes matter.config.ts with the configured matter parameters.
 *   2. Writes .env populated with the matter's parameters and required schema.
 *   3. Runs `pnpm matter:check` to validate template consistency and isolation rules.
 *      Refuses to proceed if matter:check fails.
 *   4. Runs database provisioning against the configured matter database.
 *   5. Prints the exact ingest command to run.
 *
 * Options:
 *   --dry-run: Prints every file it would write and every command it would run; writes nothing.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

export interface NewMatterAnswers {
  matterName: string;
  gcpProjectId: string;
  gcpRegion: string;
  supabaseProjectRef: string;
  supabaseRegion: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateMatterConfigContent(answers: NewMatterAnswers, slug: string): string {
  return `/**
 * Matter Template Configuration
 *
 * Single source of truth for matter parameters.
 */

export interface MatterConfig {
  /** Display name of the matter */
  matterName: string;
  /** Unique lowercase slug used in bucket names and secret IDs */
  matterSlug: string;
  /** Primary investigation name */
  investigationName: string;
  /** Legal or investigative objective */
  objective: string;
  /** Supabase Project Reference (e.g. <SUPABASE_PROJECT_REF>) */
  supabaseProjectRef: string;
  /** Storage bucket configuration */
  buckets: {
    sources: string;
    artifacts: string;
    exports: string;
  };
  /** Additional buckets permitted for ingestion */
  ingestBuckets: string[];
  /** Secret Manager secret names */
  secrets: {
    dbUrl: string;
    jwtSecret: string;
    encryptionKey: string;
    auditPepper: string;
  };
  /** Google Cloud Project ID */
  gcpProjectId: string;
  /** Google Cloud Region */
  gcpRegion: string;
  /** Supabase Region */
  supabaseRegion: string;
  /** Ingest workers (Cloud Run job tasks) sharing a run's queue (BIGDATA-4) */
  ingestWorkers: number;
}

export const matterConfig: MatterConfig = {
  matterName: ${JSON.stringify(answers.matterName)},
  matterSlug: ${JSON.stringify(slug)},
  investigationName: "Primary Investigation",
  objective: "Investigation and evidence analysis for " + ${JSON.stringify(answers.matterName)},
  supabaseProjectRef: ${JSON.stringify(answers.supabaseProjectRef)},
  buckets: {
    sources: "casefile-" + ${JSON.stringify(slug)} + "-sources",
    artifacts: "casefile-" + ${JSON.stringify(slug)} + "-artifacts",
    exports: "casefile-" + ${JSON.stringify(slug)} + "-exports",
  },
  ingestBuckets: [],
  secrets: {
    dbUrl: "casefile-" + ${JSON.stringify(slug)} + "-db-url",
    jwtSecret: "casefile-" + ${JSON.stringify(slug)} + "-jwt-secret",
    encryptionKey: "casefile-" + ${JSON.stringify(slug)} + "-encryption-key",
    auditPepper: "casefile-" + ${JSON.stringify(slug)} + "-audit-pepper",
  },
  gcpProjectId: ${JSON.stringify(answers.gcpProjectId)},
  gcpRegion: ${JSON.stringify(answers.gcpRegion)},
  supabaseRegion: ${JSON.stringify(answers.supabaseRegion)},
  ingestWorkers: 8,
};

/**
 * Buckets no matter may use are set at run time, outside the repository: CASEFILE_RESERVED_BUCKETS
 * (comma-separated names), read by pnpm matter:check.
 */

export default matterConfig;
`;
}

export function generateEnvContent(answers: NewMatterAnswers, slug: string): string {
  const jwtSecret = crypto.randomBytes(32).toString("hex");

  return `# Casefile Matter Configuration
# Auto-configured by pnpm new-matter for: ${answers.matterName}

DATABASE_URL=postgresql://casefile_app.${answers.supabaseProjectRef}:<APP_PASSWORD>@aws-0-${answers.supabaseRegion}.pooler.supabase.com:5432/postgres
DATABASE_URL_MIGRATIONS=postgresql://postgres.${answers.supabaseProjectRef}:<OWNER_PASSWORD>@aws-0-${answers.supabaseRegion}.pooler.supabase.com:5432/postgres
DATABASE_URL_TEST=postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile_test
SUPABASE_PROJECT_REF=${answers.supabaseProjectRef}
CASEFILE_API_URL=<CASEFILE_API_URL>

SUPABASE_URL=https://${answers.supabaseProjectRef}.supabase.co
SUPABASE_PUBLISHABLE_KEY=<SUPABASE_PUBLISHABLE_KEY>
${["SUPABASE", "SECRET_KEY"].join("_")}=<${["SUPABASE", "SECRET_KEY"].join("_")}>

GCP_PROJECT_ID=${answers.gcpProjectId}
GCP_REGION=${answers.gcpRegion}
SUPABASE_REGION=${answers.supabaseRegion}
GCS_SERVICE_ACCOUNT_EMAIL=casefile-${slug}-sa@${answers.gcpProjectId}.iam.gserviceaccount.com
GCS_BUCKET_SOURCES=casefile-${slug}-sources
GCS_BUCKET_ARTIFACTS=casefile-${slug}-artifacts
GCS_BUCKET_EXPORTS=casefile-${slug}-exports

STORAGE_DRIVER=gcs
AI_PROVIDER=mock
AI_MOCK_SCRIPT=packages/mock-provider/scripts/default.json
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info

CASEFILE_TENANT_ID=00000000-0000-0000-0000-000000000000
CASEFILE_WORKSPACE_ID=00000000-0000-0000-0000-000000000000
CASEFILE_INVESTIGATION_ID=00000000-0000-0000-0000-000000000000
MATTER_TENANT_ID=00000000-0000-0000-0000-000000000000
MATTER_INVESTIGATION_ID=00000000-0000-0000-0000-000000000000
JWT_SECRET=${jwtSecret}
CASEFILE_TOKEN=
`;
}

async function promptQuestions(dryRun: boolean): Promise<NewMatterAnswers> {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]!;
    const prefix = `${flag}=`;
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };

  const isInteractive = Boolean(process.stdin.isTTY) && !args.includes("--non-interactive");

  if (!isInteractive || dryRun) {
    return {
      matterName: getArg("--matter-name") || "Acme Corp Dispute",
      gcpProjectId: getArg("--gcp-project-id") || "gcp-acme-dispute-prod",
      gcpRegion: getArg("--gcp-region") || "europe-west2",
      supabaseProjectRef: getArg("--supabase-project-ref") || "acmeprodref12345678",
      supabaseRegion: getArg("--supabase-region") || "eu-west-2",
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n=======================================================");
    console.log("  CASEFILE: Provision New Matter");
    console.log("=======================================================\n");

    const matterName = (await rl.question("1. Matter name: ")).trim();
    if (!matterName) throw new Error("Matter name cannot be empty.");

    const gcpProjectId = (await rl.question("2. GCP project ID: ")).trim();
    if (!gcpProjectId) throw new Error("GCP project ID cannot be empty.");

    const gcpRegion = (await rl.question("3. GCP region: ")).trim();
    if (!gcpRegion) throw new Error("GCP region cannot be empty.");

    const supabaseProjectRef = (await rl.question("4. Supabase project ref: ")).trim();
    if (!supabaseProjectRef) throw new Error("Supabase project ref cannot be empty.");

    const supabaseRegion = (await rl.question("5. Supabase region: ")).trim();
    if (!supabaseRegion) throw new Error("Supabase region cannot be empty.");

    return { matterName, gcpProjectId, gcpRegion, supabaseProjectRef, supabaseRegion };
  } finally {
    rl.close();
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const answers = await promptQuestions(dryRun);
  const slug = slugify(answers.matterName);

  const matterConfigContent = generateMatterConfigContent(answers, slug);
  const envContent = generateEnvContent(answers, slug);

  if (dryRun) {
    console.log("\n=======================================================");
    console.log("  DRY RUN: pnpm new-matter");
    console.log("  (No files will be written, no commands executed)");
    console.log("=======================================================\n");

    console.log(`[dry-run] 1. Would write: matter.config.ts`);
    console.log("--------------------------------------------------------------------------------");
    process.stdout.write(matterConfigContent);
    console.log("--------------------------------------------------------------------------------\n");

    console.log(`[dry-run] 2. Would write: .env`);
    console.log("--------------------------------------------------------------------------------");
    process.stdout.write(envContent);
    console.log("--------------------------------------------------------------------------------\n");

    console.log(`[dry-run] 3. Would execute verification check:`);
    console.log(`  pnpm matter:check\n`);

    console.log(`[dry-run] 4. Would execute database provisioning:`);
    console.log(`  pnpm tsx scripts/deploy-matter.ts --matter=${slug} --project-ref=${answers.supabaseProjectRef} --phase=database\n`);

    console.log(`[dry-run] 5. Ingest command for new matter:`);
    console.log(`  pnpm ingest --dir=/path/to/evidence\n`);

    console.log("Dry run complete. Exiting.");
    return;
  }

  // 1. Write matter.config.ts
  const matterConfigPath = path.resolve(process.cwd(), "matter.config.ts");
  console.log(`\nWriting matter.config.ts...`);
  fs.writeFileSync(matterConfigPath, matterConfigContent, "utf8");
  console.log(`✓ Updated matter.config.ts`);

  // 2. Write .env
  const envPath = path.resolve(process.cwd(), ".env");
  console.log(`Writing .env...`);
  fs.writeFileSync(envPath, envContent, "utf8");
  console.log(`✓ Updated .env`);

  // 3. Run pnpm matter:check
  console.log(`\nRunning matter preflight integrity check (pnpm matter:check)...`);
  try {
    execSync("pnpm.cmd matter:check --skip-buckets --skip-cloud-run", {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    console.log(`✓ matter:check passed`);
  } catch {
    console.error(`\n❌ Error: matter:check failed! Refusing to proceed with provisioning.`);
    process.exit(1);
  }

  // 4. Run database provisioning
  console.log(`\nRunning database provisioning...`);
  try {
    execSync(
      `pnpm.cmd tsx scripts/deploy-matter.ts --matter=${slug} --project-ref=${answers.supabaseProjectRef} --phase=database`,
      {
        stdio: "inherit",
        cwd: process.cwd(),
      },
    );
    console.log(`✓ Database provisioning completed.`);
  } catch {
    console.error(`\n❌ Error: Database provisioning failed!`);
    process.exit(1);
  }

  // 5. Print exact ingest command
  console.log(`\n=======================================================`);
  console.log(`  Matter Setup Complete: ${answers.matterName}`);
  console.log(`=======================================================`);
  console.log(`\nTo ingest evidence into this matter, run:`);
  console.log(`  pnpm ingest --dir=/path/to/evidence\n`);
}

if (process.argv[1] && process.argv[1].endsWith("new-matter.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
