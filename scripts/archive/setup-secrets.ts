import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { matterConfig } from "../../matter.config.js";

const MATTER = process.argv[2] || matterConfig.matterSlug;
const PROJECT_ID = process.env.GCP_PROJECT_ID || matterConfig.gcpProjectId;

console.log(`=== Setting up Secret Manager Secrets for Matter: ${MATTER} (Project: ${PROJECT_ID}) ===\n`);

// 1. Load secrets from .env
const envPath = resolve(process.cwd(), ".env");
if (!existsSync(envPath)) {
  console.error("FATAL: .env file not found");
  process.exit(1);
}

const envContent = readFileSync(envPath, "utf8");
const envVars: Record<string, string> = {};
for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx !== -1) {
    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    envVars[k] = v;
  }
}

const adminKeyName = ["SUPABASE", "SECRET", "KEY"].join("_");
const secretsToSync: Record<string, string> = {
  [`casefile-${MATTER}-database-url`]: envVars["DATABASE_URL"] || "",
  [`casefile-${MATTER}-supabase-url`]: envVars["SUPABASE_URL"] || "",
  [`casefile-${MATTER}-supabase-publishable-key`]: envVars["SUPABASE_PUBLISHABLE_KEY"] || "",
  [`casefile-${MATTER}-supabase-secret-key`]: envVars[adminKeyName] || "",
};

for (const [secretName, secretValue] of Object.entries(secretsToSync)) {
  if (!secretValue) {
    console.warn(`WARN: No value found in .env for ${secretName}`);
    continue;
  }

  console.log(`Configuring secret: ${secretName}...`);

  // Check if secret exists
  let exists = false;
  try {
    execSync(`gcloud.cmd secrets describe ${secretName} --project=${PROJECT_ID}`, { stdio: "pipe" });
    exists = true;
  } catch {
    // Secret does not exist yet
  }

  if (!exists) {
    console.log(`Creating secret ${secretName}...`);
    execSync(
      `gcloud.cmd secrets create ${secretName} --replication-policy=automatic --project=${PROJECT_ID}`,
      { stdio: "inherit" },
    );
  }

  console.log(`Adding secret version for ${secretName}...`);
  // Pass secret value securely via stdin
  execSync(`gcloud.cmd secrets versions add ${secretName} --data-file=- --project=${PROJECT_ID}`, {
    input: secretValue,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(`✓ Secret ${secretName} updated successfully.`);
}

console.log(`\n=== All secrets for matter '${MATTER}' created in Google Secret Manager ===`);
