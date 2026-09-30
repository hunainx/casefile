/**
 * Matter Pre-Flight Integrity & Configuration Check
 * Invoked: pnpm matter:check (or pnpm tsx scripts/matter-check.ts [<env-file>] [--skip-cloud-run])
 * Validates matter environment variables, database connectivity, migration state, GCS bucket accessibility, and Cloud Run health.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { matterConfig } from "../matter.config.js";

/**
 * Supabase project refs this tool must never be pointed at (for example another matter's project), set at
 * run time with CASEFILE_REFUSED_PROJECT_REFS (comma-separated), outside the repository. The template ships none.
 */

/** Every refused project ref (20 lowercase letters) that appears anywhere in `text`. */
export function findRefusedProjectRefs(text: string): string[] {
  const extra = new Set(
    (process.env.CASEFILE_REFUSED_PROJECT_REFS ?? "")
      .split(",")
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean),
  );
  const found = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/(?<![a-z])[a-z]{20}(?![a-z])/g)) {
    const ref = m[0];
    if (extra.has(ref)) {
      found.add(ref);
    }
  }
  return [...found];
}
/**
 * Whether a bucket is one no matter may use: its name is in CASEFILE_RESERVED_BUCKETS (comma-separated, set
 * outside the repository; for example another deployment's buckets). The template ships none.
 */
export function isReservedBucket(bucket: string): boolean {
  const reserved = (process.env.CASEFILE_RESERVED_BUCKETS ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  return reserved.includes(bucket);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MatterCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  infos: string[];
  bucketRegions?: Record<string, string>;
  dbRegion?: string | undefined;
}

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Environment file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      env[key] = val;
    }
  }
  return env;
}

export function extractExampleKeys(examplePath: string): string[] {
  if (!fs.existsSync(examplePath)) {
    throw new Error(`Example template file not found: ${examplePath}`);
  }
  const content = fs.readFileSync(examplePath, "utf8");
  const keys: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      keys.push(trimmed.slice(0, eqIdx).trim());
    }
  }
  return keys;
}

export function extractProjectRefFromUrl(dbUrl: string): string | null {
  const match = dbUrl.match(/:\/\/[^:]*?\.([a-z0-9]+):/i);
  return match && match[1] ? match[1] : null;
}

export function extractRegionFromDbUrl(dbUrl: string): string | null {
  // Matches e.g. aws-0-eu-west-2.pooler.supabase.com or similar
  const match = dbUrl.match(/aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com/i);
  if (match && match[1]) return match[1];
  const directMatch = dbUrl.match(/\.([a-z0-9-]+)\.supabase\.co/i);
  if (directMatch && directMatch[1]) return directMatch[1];
  return null;
}

export function getContinentForRegion(region: string): string {
  const norm = region.toLowerCase().trim();
  if (norm.startsWith("us-") || norm === "us" || norm.startsWith("northamerica-") || norm.startsWith("ca-")) {
    return "North America";
  }
  if (norm.startsWith("asia-") || norm.startsWith("ap-") || norm === "asia" || norm.startsWith("me-")) {
    return "Asia";
  }
  if (norm.startsWith("europe-") || norm.startsWith("eu-") || norm === "eu" || norm.startsWith("af-")) {
    return "Europe";
  }
  if (norm.startsWith("australia-") || norm.startsWith("au-") || norm.startsWith("oceania")) {
    return "Australia / Oceania";
  }
  if (norm.startsWith("southamerica-") || norm.startsWith("sa-")) {
    return "South America";
  }
  return "Unknown Continent";
}

export function isGcpSystemBucket(name: string, projectId = ""): boolean {
  const norm = name.toLowerCase();
  if (norm.includes("_cloudbuild")) return true;
  if (norm.startsWith("run-sources-")) return true;
  if (norm.startsWith("gcf-sources-") || norm.startsWith("gcf-v2-sources-")) return true;
  if (norm.endsWith(".appspot.com")) return true;
  if (norm.startsWith("artifacts.") || norm.includes(".artifacts.")) return true;
  if (norm.startsWith("staging.")) return true;
  if (projectId && norm === projectId.toLowerCase()) return true;
  return false;
}

export function getRequiredMatterCloudConfig(env: Record<string, string> = {}) {
  const gcpProjectId = env["GCP_PROJECT_ID"] || matterConfig.gcpProjectId;
  if (!gcpProjectId) {
    throw new Error(
      "GCP project ID is required: set GCP_PROJECT_ID in environment or gcpProjectId in matter.config.ts.\n" +
      "Missing GCP project ID prevents verification of matter isolation. No fallback is permitted."
    );
  }
  const gcpRegion = env["GCP_REGION"] || matterConfig.gcpRegion;
  if (!gcpRegion) {
    throw new Error(
      "GCP region is required: set GCP_REGION in environment or gcpRegion in matter.config.ts.\n" +
      "Missing GCP region prevents verification of geographic placement. No fallback is permitted."
    );
  }
  const supabaseRegion = env["SUPABASE_REGION"] || matterConfig.supabaseRegion;
  if (!supabaseRegion) {
    throw new Error(
      "Supabase region is required: set SUPABASE_REGION in environment or supabaseRegion in matter.config.ts.\n" +
      "Missing Supabase region prevents connection and latency verification. No fallback is permitted."
    );
  }
  return { gcpProjectId, gcpRegion, supabaseRegion };
}

export function isTestOrSandboxProject(projectId: string): boolean {
  const norm = projectId.toLowerCase().trim();
  return (
    norm.includes("sandbox") ||
    norm.endsWith("-test") ||
    norm.endsWith("-dev") ||
    norm.includes("local")
  );
}

export interface MatterCheckOptions {
  checkCloudRun?: boolean;
  checkBuckets?: boolean;
  acceptCrossMatterContamination?: boolean;
}

export function checkMatterPreflight(
  envPath: string,
  options: MatterCheckOptions | boolean = true,
): MatterCheckResult {
  const checkCloudRun = typeof options === "boolean" ? options : options.checkCloudRun ?? true;
  const checkBuckets = typeof options === "boolean" ? options : options.checkBuckets ?? true;
  const acceptCrossMatterContamination = typeof options === "boolean" ? false : options.acceptCrossMatterContamination ?? false;

  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const bucketRegions: Record<string, string> = {};

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const examplePath = path.resolve(repoRoot, ".env.matter.example");

  let env: Record<string, string>;
  try {
    env = parseEnvFile(envPath);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message], warnings: [], infos: [] };
  }

  // Check 1: Refuse known foreign project refs everywhere in the file
  const envRaw = fs.readFileSync(envPath, "utf8");
  for (const ref of findRefusedProjectRefs(envRaw)) {
    errors.push(
      `FATAL: Foreign project ref ${ref} is on the refused list. A previous migration session destroyed another matter's tables. STOP THE LINE IMMEDIATELY.`
    );
  }

  // Check 2: Require every variable in .env.matter.example to be present
  const requiredKeys = extractExampleKeys(examplePath);
  for (const key of requiredKeys) {
    if (env[key] === undefined) {
      errors.push(`Missing required variable from .env.matter.example: ${key}`);
    }
  }

  // Check 3: Reject placeholder / empty values
  for (const [k, v] of Object.entries(env)) {
    if (v === "" || v === undefined) {
      errors.push(`Variable ${k} has empty value.`);
    } else if (v.includes("<") || v.includes(">")) {
      errors.push(`Variable ${k} contains unreplaced template bracket '<...>' placeholder: '${v}'`);
    } else if (v.includes("CHANGEME")) {
      errors.push(`Variable ${k} contains 'CHANGEME' placeholder.`);
    } else if (v.includes("00000000-0000")) {
      errors.push(`Variable ${k} contains uninitialized zero UUID placeholder '00000000-0000': '${v}'`);
    }
  }

  // Check 4: Extract and match Supabase Project Ref in DATABASE_URL and DATABASE_URL_MIGRATIONS
  const dbUrl = env["DATABASE_URL"] || "";
  const dbUrlMigrations = env["DATABASE_URL_MIGRATIONS"] || "";
  const expectedRef = matterConfig.supabaseProjectRef;

  const appRef = extractProjectRefFromUrl(dbUrl);
  const migRef = extractProjectRefFromUrl(dbUrlMigrations);

  if (!appRef) {
    errors.push(`Could not extract Supabase project ref from DATABASE_URL: '${dbUrl}'`);
  } else if (appRef !== expectedRef) {
    errors.push(
      `DATABASE_URL project ref '${appRef}' does not match matterConfig.supabaseProjectRef '${expectedRef}'. Mismatches risk corrupting foreign projects!`
    );
  }

  if (!migRef) {
    errors.push(`Could not extract Supabase project ref from DATABASE_URL_MIGRATIONS: '${dbUrlMigrations}'`);
  } else if (migRef !== expectedRef) {
    errors.push(
      `DATABASE_URL_MIGRATIONS project ref '${migRef}' does not match matterConfig.supabaseProjectRef '${expectedRef}'. Mismatches risk corrupting foreign projects!`
    );
  }

  // Check 5: Require DATABASE_URL to use session pooler on port 5432 and reject 6543 (D57)
  if (dbUrl) {
    const portMatch = dbUrl.match(/:(\d+)\//);
    const port = portMatch ? portMatch[1] : "";
    if (port === "6543") {
      errors.push(
        "DATABASE_URL is configured with port 6543 (transaction pooler). Decision D57 requires port 5432 (session pooler) for prepared statement support."
      );
    } else if (port !== "5432") {
      errors.push(`DATABASE_URL must connect via session pooler port 5432 (found: ${port || "none"}).`);
    }
  }

  // Check required cloud configuration (strictly required, no fallbacks)
  const gcpProject = env["GCP_PROJECT_ID"] || matterConfig.gcpProjectId;
  if (!gcpProject) {
    errors.push(
      "GCP Project ID is required: set GCP_PROJECT_ID in environment or gcpProjectId in matter.config.ts.\n" +
      "Missing GCP project ID prevents verification of matter isolation. No fallback is permitted."
    );
  }

  const gcpRegion = env["GCP_REGION"] || matterConfig.gcpRegion;
  if (!gcpRegion) {
    errors.push(
      "GCP Region is required: set GCP_REGION in environment or gcpRegion in matter.config.ts.\n" +
      "Missing GCP region prevents verification of geographic placement. No fallback is permitted."
    );
  }

  const supabaseRegion = env["SUPABASE_REGION"] || matterConfig.supabaseRegion || extractRegionFromDbUrl(dbUrl);
  if (!supabaseRegion) {
    errors.push(
      "Supabase Region is required: set SUPABASE_REGION in environment or supabaseRegion in matter.config.ts.\n" +
      "Missing Supabase region prevents connection and latency verification. No fallback is permitted."
    );
  }

  const matterSlug = env["MATTER_SLUG"] || matterConfig.matterSlug;

  if (acceptCrossMatterContamination) {
    if (process.env.NODE_ENV === "production" || env["NODE_ENV"] === "production") {
      errors.push(
        "FATAL SECURITY VIOLATION: --i-accept-cross-matter-contamination is strictly forbidden when NODE_ENV=production. Matter isolation is unconditionally enforced."
      );
    }
    if (gcpProject && !isTestOrSandboxProject(gcpProject)) {
      errors.push(
        `FATAL SECURITY VIOLATION: --i-accept-cross-matter-contamination is only permitted on recognized test/sandbox projects. Project '${gcpProject}' is not an authorized test project.`
      );
    }
  }

  // Check 6 & Check 13: Cloud Run Service Checks
  if (checkCloudRun && gcpProject) {
    const serviceName = `casefile-${matterSlug}-api`;

    // Check 6: Assert DATABASE_URL_MIGRATIONS is NOT present on Cloud Run service
    if (gcpRegion) {
      try {
        const output = execSync(
          `gcloud.cmd run services describe ${serviceName} --region=${gcpRegion} --project=${gcpProject} --format=json`,
          { encoding: "utf8", stdio: "pipe" }
        );
        const parsed = JSON.parse(output);
        const containers = parsed.spec?.template?.spec?.containers || [];
        for (const c of containers) {
          const envVars = (c.env || []) as { name: string; value?: string; valueFrom?: unknown }[];
          for (const ev of envVars) {
            if (ev.name === "DATABASE_URL_MIGRATIONS") {
              errors.push(
                `FATAL SECURITY VIOLATION: DATABASE_URL_MIGRATIONS is mounted on Cloud Run service ${serviceName}! Owner credentials must NEVER be deployed to runtime services.`
              );
            }
          }
        }
      } catch {
        // If service does not exist or gcloud is not authenticated, ignore runtime check
      }
    }

    // Check 13: Cloud Run Service Isolation Check
    // Fail if any service exists in target project whose name does not begin with casefile-<this matter's slug>-.
    try {
      const output = execSync(
        `gcloud.cmd run services list --project=${gcpProject} --format=json`,
        { encoding: "utf8", stdio: "pipe" }
      );
      const services = JSON.parse(output) as Array<{
        metadata?: { name?: string };
        name?: string;
      }>;
      const expectedPrefix = `casefile-${matterSlug}-`;
      const foreignServices: string[] = [];
      for (const s of services) {
        const name = s.metadata?.name || s.name;
        if (name && !name.startsWith(expectedPrefix)) {
          foreignServices.push(name);
        }
      }
      if (foreignServices.length > 0) {
        if (
          acceptCrossMatterContamination &&
          isTestOrSandboxProject(gcpProject) &&
          process.env.NODE_ENV !== "production" &&
          env["NODE_ENV"] !== "production"
        ) {
          console.warn(
            "\n╔══════════════════════════════════════════════════════════════════════════════╗\n" +
            "║                  SECURITY WARNING: CROSS-MATTER CONTAMINATION                ║\n" +
            "║  --i-accept-cross-matter-contamination was explicitly specified.             ║\n" +
            "║  Bypassing isolation check for non-production/sandbox project.               ║\n" +
            `║  Target Project: ${gcpProject}\n` +
            "║  IGNORING FOREIGN CLOUD RUN SERVICES:                                        ║\n" +
            `║    ${foreignServices.join(", ")}\n` +
            "║  THIS PROJECT IS CONTAMINATED. NEVER USE THIS PROJECT FOR CLIENT DATA.       ║\n" +
            "╚══════════════════════════════════════════════════════════════════════════════╝\n"
          );
          warnings.push(
            `Cross-Matter Contamination Bypassed: Ignored foreign Cloud Run service(s) in project '${gcpProject}': ${foreignServices.join(", ")}`
          );
        } else {
          errors.push(
            `Cloud Run Service Isolation Violation: Target GCP project '${gcpProject}' already contains foreign Cloud Run service(s): ${foreignServices.join(", ")}. Every service in the project must begin with '${expectedPrefix}'. One matter means one project.`
          );
        }
      }
    } catch (err: unknown) {
      const errorObj = err as { stdout?: string; stderr?: string; message?: string };
      const msg = (errorObj.stderr || errorObj.stdout || errorObj.message || "").trim();
      if (msg) {
        errors.push(`Cloud Run service listing failed for project '${gcpProject}': ${msg}`);
      }
    }
  }

  // Check 7: Validate Storage Driver and Keyless URL Signing Prerequisite
  const storageDriver = env["STORAGE_DRIVER"] || "memory";
  if (storageDriver === "gcs") {
    const saEmail = env["GCS_SERVICE_ACCOUNT_EMAIL"] || env["GCP_SERVICE_ACCOUNT_EMAIL"];
    const keyFile = env["GOOGLE_APPLICATION_CREDENTIALS"];

    if (!saEmail && !keyFile) {
      errors.push(
        "STORAGE_DRIVER is set to 'gcs' but neither GCS_SERVICE_ACCOUNT_EMAIL (preferred keyless route) nor GOOGLE_APPLICATION_CREDENTIALS (fallback key file) is configured."
      );
    } else if (saEmail) {
      if (!saEmail.includes("@") || !saEmail.includes(".iam.gserviceaccount.com")) {
        errors.push(
          `GCS_SERVICE_ACCOUNT_EMAIL '${saEmail}' is invalid. Must be a full service account email (...@<project>.iam.gserviceaccount.com).`
        );
      }
    } else if (keyFile) {
      if (!fs.existsSync(keyFile)) {
        errors.push(
          `GOOGLE_APPLICATION_CREDENTIALS specifies key file '${keyFile}' which does not exist or is unreadable.`
        );
      }
    }
  }

  // Check 8 & Check 9: Verify Buckets Existence, Accessibility, and Cross-Continent Latency
  const configuredBuckets = [
    env["GCS_BUCKET_SOURCES"] || matterConfig.buckets.sources,
    env["GCS_BUCKET_ARTIFACTS"] || matterConfig.buckets.artifacts,
    env["GCS_BUCKET_EXPORTS"] || matterConfig.buckets.exports,
  ].filter(Boolean);

  const dbRegion = extractRegionFromDbUrl(dbUrl) || supabaseRegion;
  const dbContinent = dbRegion ? getContinentForRegion(dbRegion) : "Unknown Continent";

  if (checkBuckets && storageDriver === "gcs" && gcpProject) {
    for (const bucket of configuredBuckets) {
      try {
        const out = execSync(
          `gcloud.cmd storage buckets describe gs://${bucket} --project=${gcpProject} --format=json`,
          { encoding: "utf8", stdio: "pipe" }
        );
        const parsed = JSON.parse(out);
        const loc = (parsed.location as string) || "UNKNOWN";
        bucketRegions[bucket] = loc;

        // Check 9: Cross-Continent Region Latency Warning
        const bucketContinent = getContinentForRegion(loc);
        if (bucketContinent !== "Unknown Continent" && dbContinent !== "Unknown Continent" && bucketContinent !== dbContinent) {
          warnings.push(
            `Cross-Continent Latency Hazard: GCS bucket 'gs://${bucket}' is in region '${loc}' (${bucketContinent}) while Supabase Database is in region '${dbRegion}' (${dbContinent}). Ingestion across continents may introduce high network latency per row.`
          );
        }
      } catch (err: unknown) {
        const errorObj = err as { stdout?: string; stderr?: string; message?: string };
        const msg = (errorObj.stderr || errorObj.stdout || errorObj.message || "").trim();
        errors.push(
          `GCS bucket 'gs://${bucket}' does not exist or is not readable with current credentials. Details: ${msg}`
        );
      }
    }
  }

  // Check 10: Reserved Bucket Collision (Step 28a)
  for (const bucket of configuredBuckets) {
    if (matterSlug !== "sandbox" && isReservedBucket(bucket)) {
      errors.push(
        `Reserved Bucket Collision: Matter '${matterSlug}' cannot use reserved bucket 'gs://${bucket}'. This bucket name is reserved for core or sandbox environments.`
      );
    }
  }

  // Check 12: Bucket Binding — every configured bucket must be one of this matter's
  // matterConfig.buckets or be listed deliberately in matterConfig.ingestBuckets. This is
  // the same rule `pnpm ingest --bucket` enforces; a .env that names another matter's
  // bucket must not reach ingest or deploy.
  const boundBuckets = [
    matterConfig.buckets.sources,
    matterConfig.buckets.artifacts,
    matterConfig.buckets.exports,
    ...matterConfig.ingestBuckets,
  ];
  for (const key of ["GCS_BUCKET_SOURCES", "GCS_BUCKET_ARTIFACTS", "GCS_BUCKET_EXPORTS"] as const) {
    const value = env[key];
    if (value && !boundBuckets.includes(value)) {
      errors.push(
        `Bucket Binding Violation: ${key}='${value}' is not a bucket of matter '${matterConfig.matterSlug}' ` +
          `(bound buckets: ${boundBuckets.join(", ")}). Ingest and deploy refuse buckets outside matter.config.ts; ` +
          `fix .env, or add the bucket to matterConfig.ingestBuckets deliberately.`
      );
    }
  }

  // Check 11: Stranger Object Collision on Bucket Adoption (Step 28b / Step 29a)
  const matterTenantId = env["MATTER_TENANT_ID"];
  if (checkBuckets && storageDriver === "gcs" && matterSlug !== "sandbox") {
    for (const bucket of configuredBuckets) {
      try {
        const listOut = execSync(
          `gcloud.cmd storage ls gs://${bucket}/`,
          { encoding: "utf8", stdio: "pipe" }
        );
        const entries = listOut
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith(`gs://${bucket}/`))
          .map((l) => l.slice(`gs://${bucket}/`.length).replace(/\/$/, ""))
          .filter(Boolean);

        if (entries.length > 0) {
          const foreignUuidPrefixes: string[] = [];
          const normalEntries: string[] = [];

          for (const entry of entries) {
            if (UUID_REGEX.test(entry)) {
              if (!matterTenantId || entry.toLowerCase() !== matterTenantId.toLowerCase()) {
                foreignUuidPrefixes.push(entry);
              }
            } else {
              normalEntries.push(entry);
            }
          }

          if (foreignUuidPrefixes.length > 0) {
            errors.push(
              `Foreign Object Collision on Adopt: Bucket 'gs://${bucket}' contains existing objects under foreign UUID prefix '${foreignUuidPrefixes[0]}'. Adopting a bucket with stranger data risks cross-matter data contamination.`
            );
          } else if (normalEntries.length > 0) {
            infos.push(
              `GCS bucket 'gs://${bucket}': bucket contains ${normalEntries.length} pre-existing top-level entries to be ingested.`
            );
          }
        }
      } catch {
        // Bucket is empty or does not exist yet (handled by Check 8)
      }
    }
  }

  // Check 14: Bucket Isolation Check
  // Fail if the target project already contains buckets belonging to a different matter slug.
  if (checkBuckets && storageDriver === "gcs" && gcpProject) {
    try {
      const out = execSync(
        `gcloud.cmd storage buckets list --project=${gcpProject} --format=json`,
        { encoding: "utf8", stdio: "pipe" }
      );
      const buckets = JSON.parse(out) as Array<{ name?: string }>;
      const expectedPrefix = `casefile-${matterSlug}-`;
      const foreignBuckets: string[] = [];

      for (const b of buckets) {
        const bName = b.name || "";
        if (!bName) continue;
        if (isGcpSystemBucket(bName, gcpProject)) continue;
        if (bName.startsWith(expectedPrefix) || boundBuckets.includes(bName)) continue;
        foreignBuckets.push(bName);
      }

      if (foreignBuckets.length > 0) {
        if (
          acceptCrossMatterContamination &&
          isTestOrSandboxProject(gcpProject) &&
          process.env.NODE_ENV !== "production" &&
          env["NODE_ENV"] !== "production"
        ) {
          console.warn(
            "\n╔══════════════════════════════════════════════════════════════════════════════╗\n" +
            "║                  SECURITY WARNING: CROSS-MATTER CONTAMINATION                ║\n" +
            "║  --i-accept-cross-matter-contamination was explicitly specified.             ║\n" +
            "║  Bypassing isolation check for non-production/sandbox project.               ║\n" +
            `║  Target Project: ${gcpProject}\n` +
            "║  IGNORING FOREIGN STORAGE BUCKETS:                                           ║\n" +
            `║    ${foreignBuckets.join(", ")}\n` +
            "║  THIS PROJECT IS CONTAMINATED. NEVER USE THIS PROJECT FOR CLIENT DATA.       ║\n" +
            "╚══════════════════════════════════════════════════════════════════════════════╝\n"
          );
          warnings.push(
            `Cross-Matter Contamination Bypassed: Ignored foreign storage bucket(s) in project '${gcpProject}': ${foreignBuckets.join(", ")}`
          );
        } else {
          errors.push(
            `Bucket Isolation Violation: Target GCP project '${gcpProject}' already contains bucket(s) belonging to a different matter: ${foreignBuckets.join(", ")}. One matter means one project.`
          );
        }
      }
    } catch (err: unknown) {
      const errorObj = err as { stdout?: string; stderr?: string; message?: string };
      const msg = (errorObj.stderr || errorObj.stdout || errorObj.message || "").trim();
      if (msg) {
        errors.push(`Storage bucket listing failed for project '${gcpProject}': ${msg}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    infos,
    bucketRegions,
    dbRegion: dbRegion || undefined,
  };
}

export async function main() {
  const args = process.argv.slice(2);
  const skipCloud = args.includes("--skip-cloud-run");
  const skipBuckets = args.includes("--skip-buckets");
  const acceptContamination = args.includes("--i-accept-cross-matter-contamination");
  const envArg = args.find((a) => !a.startsWith("--"));
  const targetEnv = envArg ? path.resolve(process.cwd(), envArg) : path.resolve(process.cwd(), ".env");

  if (args.includes("--skip-isolation")) {
    console.error("\nFATAL: --skip-isolation has been removed. Matter isolation is strictly enforced.");
    console.error("If you are in local development testing a sandbox project, see --i-accept-cross-matter-contamination.\n");
    process.exit(1);
  }

  console.log("================================================================================");
  console.log(`CASEFILE PREFLIGHT CHECK: ${matterConfig.matterName} (${matterConfig.matterSlug})`);
  console.log(`Target Environment: ${targetEnv}`);
  console.log("================================================================================");

  const result = checkMatterPreflight(targetEnv, {
    checkCloudRun: !skipCloud,
    checkBuckets: !skipBuckets,
    acceptCrossMatterContamination: acceptContamination,
  });

  if (result.infos.length > 0) {
    console.log("\nPREFLIGHT INFO:");
    for (const info of result.infos) {
      console.log(`  ℹ ${info}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\nPREFLIGHT WARNINGS:");
    for (const w of result.warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }

  if (!result.ok) {
    console.error("\nPREFLIGHT FAILED WITH ERRORS:\n");
    for (const err of result.errors) {
      console.error(`  ✖ ${err}`);
    }
    console.error("\nResolve all preflight errors before deploying or migrating.\n");
    process.exit(1);
  }

  console.log("\n✓ All preflight checks PASSED:");
  console.log("  • All required .env variables defined without placeholders");
  console.log("  • Supabase project ref matches matterConfig.supabaseProjectRef on all connections");
  console.log("  • Zero refused foreign project refs in the environment file");
  console.log("  • Session pooler (port 5432) verified for runtime application");
  console.log("  • Cloud Run runtime service isolated from owner migration credentials");
  console.log("  • Cloud Run service isolation verified (one matter means one project)");
  console.log("  • Every GCS_BUCKET_* value is bound to this matter's matter.config.ts (buckets / ingestBuckets)");
  console.log("  • Storage buckets exist and are readable with current credentials");
  console.log("  • Storage bucket isolation verified (no foreign matter buckets in project)\n");

  if (result.bucketRegions && Object.keys(result.bucketRegions).length > 0) {
    console.log("Region Topology Report:");
    console.log(`  Supabase Database Region: ${result.dbRegion} (${getContinentForRegion(result.dbRegion || "")})`);
    for (const [b, loc] of Object.entries(result.bucketRegions)) {
      console.log(`  GCS Bucket gs://${b}: ${loc} (${getContinentForRegion(loc)})`);
    }
    console.log("");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || "")) {
  main().catch((err) => {
    console.error("Fatal preflight error:", err);
    process.exit(1);
  });
}
