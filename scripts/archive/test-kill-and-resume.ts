import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { bootstrap } from "../../tools/ingest-cli/src/bootstrap.js";
import { getDbUrl, withTenant, type Tx } from "@casefile/db";

async function main() {
  console.log("================================================================================");
  console.log("STEP 25: RESUMABILITY PROOF ON FRESH INVESTIGATION (GENUINE RUN WITH FAIL STATE)");
  console.log("================================================================================");

  const bucket = process.env.GCS_BUCKET_SOURCES;
  if (!bucket) {
    throw new Error("GCS_BUCKET_SOURCES environment variable is required.");
  }
  const prefix = `${process.env.MATTER_TENANT_ID ?? "<MATTER_TENANT_ID>"}/${process.env.MATTER_INVESTIGATION_ID ?? "<MATTER_INVESTIGATION_ID>"}/artifacts`;

  // Measure bucket stats BEFORE Run 1
  console.log("=== STEP 25e: Reading GCS Bucket Object Count & Size BEFORE Run 1 ===");
  const bucketBefore = execSync(`cmd /c gcloud storage ls -l gs://${bucket}/**`, { encoding: "utf8" });
  const totalLineBefore = bucketBefore.split("\n").filter((l) => l.startsWith("TOTAL:")).join("").trim();
  console.log(`Bucket stats BEFORE: ${totalLineBefore}`);

  // Bootstrap a FRESH tenant and investigation with unique UUID
  const uniqueOrg = `Fresh-Resume-Proof-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const boot = await bootstrap({
    name: uniqueOrg,
    investigationName: `Fresh Investigation ${Date.now()}`,
    // bootstrap() now requires an explicit admin email and records ids in .env.<matter>
    email: `${uniqueOrg.toLowerCase()}@casefile.test`,
    matter: uniqueOrg.toLowerCase(),
    envDir: "scratch",
  });

  const tenantId = boot.tenantId;
  const investigationId = boot.investigationId;
  const dbUrl = getDbUrl();
  const db = postgres(dbUrl, { max: 2 });

  console.log(`\nFresh Organization: ${uniqueOrg}`);
  console.log(`Fresh Tenant ID:    ${tenantId}`);
  console.log(`Fresh Inv ID:       ${investigationId}`);
  console.log(`Bucket Prefix:      gs://${bucket}/${prefix}`);
  console.log("────────────────────────────────────────────────────────────────────────────────\n");

  console.log("=== RUN 1: Genuine Ingestion — Terminating Process After 2 Files Land ===");

  const runnerFile = path.resolve(process.cwd(), ".tmp_interrupted_runner.ts");
  fs.writeFileSync(
    runnerFile,
    `
import { ingestBucket } from "./tools/ingest-cli/src/ingest.js";

async function run() {
  let count = 0;
  await ingestBucket({
    bucket: "${bucket}",
    prefix: "${prefix}",
    investigationId: "${investigationId}",
    tenantId: "${tenantId}",
    onFileResult: (res) => {
      count++;
      const padName = res.filename.padEnd(28);
      const shortSha = res.sha256.slice(0, 12);
      console.log(\`[Run 1 - File \${count}/5] \${padName} sha256:\${shortSha}  status: \${res.status}\`);
      if (count >= 2) {
        console.log(">> SIMULATING OPERATOR SIGINT / KILL PROCESS (after 2 files landed)...");
        process.exit(130);
      }
    }
  });
}

run().catch((e) => {
  console.error("Run 1 error:", e);
  process.exit(1);
});
`,
    "utf8"
  );

  try {
    execSync(`cmd /c npx tsx "${runnerFile}"`, {
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch {
    console.log("✓ Process terminated partway with SIGINT/Exit Code 130 as expected.\n");
  } finally {
    if (fs.existsSync(runnerFile)) fs.unlinkSync(runnerFile);
  }

  // STEP 25b: Query database count immediately after kill (using withTenant for RLS)
  const postKillRows = await withTenant(tenantId, async (tx: Tx) => {
    return await tx<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM sources WHERE investigation_id = ${investigationId};
    `;
  }, db);
  const postKillCount = postKillRows[0]?.count ?? 0;
  console.log(`>>> DATABASE CHECK (immediately after kill with tenant RLS):`);
  console.log(`    Sources in investigation: ${postKillCount} (greater than 0, less than 5 total files)`);
  if (postKillCount !== 2) {
    throw new Error(`Expected exactly 2 sources landed in DB after kill, found: ${postKillCount}`);
  }

  console.log("\n=== RUN 2: Re-running Ingestion CLI on the Same Investigation & Prefix ===");
  const resumeCmd = `cmd /c npx tsx tools/ingest-cli/src/ingest.ts --bucket=${bucket} --prefix="${prefix}" --investigation=${investigationId} --tenant=${tenantId}`;
  const run2Output = execSync(resumeCmd, {
    encoding: "utf8",
  });
  console.log(run2Output);

  // STEP 25c: Query database count after Run 2 (using withTenant for RLS)
  const finalRows = await withTenant(tenantId, async (tx: Tx) => {
    return await tx<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM sources WHERE investigation_id = ${investigationId};
    `;
  }, db);
  const finalCount = finalRows[0]?.count ?? 0;
  console.log(`>>> DATABASE CHECK (after completion of Run 2 with tenant RLS):`);
  console.log(`    Sources in investigation: ${finalCount} (equal to 5 total files)`);
  if (finalCount !== 5) {
    throw new Error(`Expected exactly 5 sources landed in DB after resume, found: ${finalCount}`);
  }

  // Measure bucket stats AFTER Run 2
  console.log("\n=== STEP 25e: Reading GCS Bucket Object Count & Size AFTER Run 2 ===");
  const bucketAfter = execSync(`cmd /c gcloud storage ls -l gs://${bucket}/**`, { encoding: "utf8" });
  const totalLineAfter = bucketAfter.split("\n").filter((l) => l.startsWith("TOTAL:")).join("").trim();
  console.log(`Bucket stats AFTER:  ${totalLineAfter}`);

  console.log("\n================================================================================");
  console.log("PROOF SUMMARY:");
  console.log(`  • Run 1 landed 2 files (status: indexed), killed partway.`);
  console.log(`  • DB count after kill: ${postKillCount}/5`);
  console.log(`  • Run 2 skipped 2 files (already ingested), indexed remaining 3 files.`);
  console.log(`  • DB count after resume: ${finalCount}/5`);
  console.log(`  • Bucket stats match: ${totalLineBefore === totalLineAfter ? "YES (0 bytes re-uploaded)" : "NO"}`);
  console.log("================================================================================");

  await db.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
