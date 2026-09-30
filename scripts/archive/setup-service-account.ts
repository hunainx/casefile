import { execSync } from "node:child_process";
import { matterConfig } from "../../matter.config.js";

const MATTER = process.argv[2] || matterConfig.matterSlug;
const PROJECT_ID = process.env.GCP_PROJECT_ID || matterConfig.gcpProjectId;
const SA_NAME = `casefile-${MATTER}-sa`;
const SA_EMAIL = `${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com`;

console.log(`=== Setting up Least-Privilege Service Account: ${SA_EMAIL} ===\n`);

// 1. Create Service Account if not exists
try {
  execSync(`gcloud.cmd iam service-accounts describe ${SA_EMAIL} --project=${PROJECT_ID}`, { stdio: "pipe" });
  console.log(`✓ Service account ${SA_EMAIL} already exists.`);
} catch {
  console.log(`Creating service account ${SA_NAME}...`);
  execSync(
    `gcloud.cmd iam service-accounts create ${SA_NAME} --display-name="Casefile Cloud Run Service Account for ${MATTER}" --project=${PROJECT_ID}`,
    { stdio: "inherit" },
  );
  console.log(`✓ Created service account ${SA_EMAIL}.`);
}

// 2. Grant Secret Accessor on matter secrets ONLY (Resource-Level Bindings, NOT project-wide)
const matterSecrets = [
  `casefile-${MATTER}-database-url`,
  `casefile-${MATTER}-supabase-url`,
  `casefile-${MATTER}-supabase-publishable-key`,
  `casefile-${MATTER}-supabase-secret-key`,
];

console.log("\nGranting Secret Accessor role on matter secrets only...");
for (const secret of matterSecrets) {
  console.log(`Binding secretAccessor on ${secret}...`);
  execSync(
    `gcloud.cmd secrets add-iam-policy-binding ${secret} --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor" --project=${PROJECT_ID}`,
    { stdio: "inherit" },
  );
}

// 3. Grant Object Read/Write on matter's three buckets ONLY (Bucket-Level Bindings, NOT project-wide)
const sourcesBucket = process.env.GCS_BUCKET_SOURCES || `casefile-${MATTER}-sources`;
const artifactsBucket = process.env.GCS_BUCKET_ARTIFACTS || `casefile-${MATTER}-artifacts`;
const exportsBucket = process.env.GCS_BUCKET_EXPORTS || `casefile-${MATTER}-exports`;
const matterBuckets = [sourcesBucket, artifactsBucket, exportsBucket];

console.log("\nGranting objectUser role on matter buckets only...");
for (const bucket of matterBuckets) {
  console.log(`Binding storage.objectUser on gs://${bucket}...`);
  execSync(
    `gcloud.cmd storage buckets add-iam-policy-binding gs://${bucket} --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectUser" --project=${PROJECT_ID}`,
    { stdio: "inherit" },
  );
}

// 4. Verify no project-wide roles exist for this service account
console.log("\nVerifying absence of project-wide roles...");
const projectPolicy = execSync(
  `gcloud.cmd projects get-iam-policy ${PROJECT_ID} --format=json`,
  { encoding: "utf8" },
);
interface IamBinding {
  role: string;
  members?: string[];
}
const parsedPolicy = JSON.parse(projectPolicy) as { bindings?: IamBinding[] };
const projectRoles = (parsedPolicy.bindings || [])
  .filter((b) => b.members?.includes(`serviceAccount:${SA_EMAIL}`))
  .map((b) => b.role);

if (projectRoles.length > 0) {
  console.error(`FAIL: Found project-wide roles on service account: ${projectRoles.join(", ")}`);
  process.exit(1);
}

console.log("✓ Confirmed: Service account has 0 project-wide roles. All permissions are strictly resource-scoped.");
console.log("\n=== Service account setup complete ===");
