import { execSync } from "node:child_process";
import { matterConfig } from "../../matter.config.js";

const MATTER = process.argv[2] || matterConfig.matterSlug;
const PROJECT_ID = process.env.GCP_PROJECT_ID || matterConfig.gcpProjectId;
const REGION = matterConfig.gcpRegion || "<GCP_REGION>";
const SERVICE_NAME = `casefile-${MATTER}-api`;
const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT_ID}/casefile/casefile-api:${MATTER}`;
const SA_EMAIL = `casefile-${MATTER}-sa@${PROJECT_ID}.iam.gserviceaccount.com`;

console.log(`=== Deploying ${SERVICE_NAME} to Cloud Run in ${REGION} ===\n`);
console.log(`Image: ${IMAGE}`);
console.log(`Service Account: ${SA_EMAIL}`);

const secretsFlag = [
  `DATABASE_URL=casefile-${MATTER}-database-url:latest`,
  `SUPABASE_URL=casefile-${MATTER}-supabase-url:latest`,
  `SUPABASE_PUBLISHABLE_KEY=casefile-${MATTER}-supabase-publishable-key:latest`,
  `MCP_TOKEN=casefile-${MATTER}-mcp-token:latest`,
].join(",");

const envVarsFlag = [
  "NODE_ENV=production",
  "STORAGE_DRIVER=gcs",
  `GCP_PROJECT_ID=${PROJECT_ID}`,
  `GCS_SERVICE_ACCOUNT_EMAIL=${SA_EMAIL}`,
  `GCS_BUCKET_SOURCES=casefile-${MATTER}-sources`,
  `GCS_BUCKET_ARTIFACTS=casefile-${MATTER}-artifacts`,
  `GCS_BUCKET_EXPORTS=casefile-${MATTER}-exports`,
  `MATTER_TENANT_ID=${process.env.MATTER_TENANT_ID ?? "<MATTER_TENANT_ID>"}`,
  `MATTER_INVESTIGATION_ID=${process.env.MATTER_INVESTIGATION_ID ?? "<MATTER_INVESTIGATION_ID>"}`,
].join(",");

const deployCmd = [
  "gcloud.cmd run deploy",
  SERVICE_NAME,
  `--image=${IMAGE}`,
  `--region=${REGION}`,
  `--project=${PROJECT_ID}`,
  `--service-account=${SA_EMAIL}`,
  `--set-secrets="${secretsFlag}"`,
  `--set-env-vars="${envVarsFlag}"`,
  "--port=8080",
  "--memory=512Mi",
  "--cpu=1",
  "--allow-unauthenticated",
  "--format=json",
].join(" ");

console.log(`Executing deployment command...\n`);
const result = execSync(deployCmd, { encoding: "utf8" });
const parsed = JSON.parse(result);
const serviceUrl = parsed.status?.url || parsed.status?.address?.url;

console.log(`\n✓ Deployment Successful!`);
console.log(`Service URL: ${serviceUrl}`);
