import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { matterConfig } from "../../matter.config.js";

const credsPath = path.resolve(import.meta.dirname, "../scratch/sandbox-creds.json");
const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
const PROJECT_ID = process.env.GCP_PROJECT_ID || matterConfig.gcpProjectId;
const MATTER = process.argv[2] || matterConfig.matterSlug;

console.log(`=== Updating .env with Credentials for ${MATTER} ===`);
const envPath = path.resolve(import.meta.dirname, "../.env");

const envContent = `# Casefile — matter environment
# Auto-configured for matter: ${MATTER}

DATABASE_URL=${creds.appPoolerUrl}
DATABASE_URL_TEST=postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile_test

SUPABASE_URL=${creds.supabaseUrl}
SUPABASE_PUBLISHABLE_KEY=${creds.anonKey}

GCP_PROJECT_ID=${PROJECT_ID}
GCS_BUCKET_SOURCES=casefile-${MATTER}-sources
GCS_BUCKET_ARTIFACTS=casefile-${MATTER}-artifacts
GCS_BUCKET_EXPORTS=casefile-${MATTER}-exports

STORAGE_DRIVER=gcs
AI_PROVIDER=mock
AI_MOCK_SCRIPT=packages/mock-provider/scripts/default.json
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info
`;

fs.writeFileSync(envPath, envContent, "utf8");
console.log("✓ .env file updated with sandbox configuration.");

console.log("\n=== Syncing Secrets to Google Secret Manager ===");
const secretsToSync: Record<string, string> = {
  [`casefile-${MATTER}-database-url`]: creds.appPoolerUrl,
  [`casefile-${MATTER}-supabase-url`]: creds.supabaseUrl,
  [`casefile-${MATTER}-supabase-publishable-key`]: creds.anonKey,
  [`casefile-${MATTER}-supabase-secret-key`]: creds.serviceKey,
};

for (const [secretName, secretValue] of Object.entries(secretsToSync)) {
  console.log(`Configuring secret: ${secretName}...`);
  let exists = false;
  try {
    execSync(`gcloud.cmd secrets describe ${secretName} --project=${PROJECT_ID}`, { stdio: "pipe" });
    exists = true;
  } catch {
    // Secret does not exist
  }

  if (!exists) {
    console.log(`Creating secret ${secretName}...`);
    execSync(
      `gcloud.cmd secrets create ${secretName} --replication-policy=automatic --project=${PROJECT_ID}`,
      { stdio: "inherit" }
    );
  }

  console.log(`Adding secret version for ${secretName}...`);
  execSync(`gcloud.cmd secrets versions add ${secretName} --data-file=- --project=${PROJECT_ID}`, {
    input: secretValue,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(`✓ Secret ${secretName} updated successfully.`);
}

console.log("\n✓ All 4 sandbox secrets created in Google Secret Manager!");
