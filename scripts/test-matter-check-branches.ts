/**
 * Automated Test Harness for matter-check.ts Pre-Flight Branches
 * Invoked: pnpm tsx scripts/test-matter-check-branches.ts
 * Synthesizes valid and invalid matter environment configurations to verify that every
 * matter-check guard fires when it should and stays quiet when it should not.
 *
 * Exit code: 0 only if every expected-fail branch failed and every expected-pass branch
 * passed. Any mismatch is counted and the process exits 1. A harness that prints "FAIL"
 * and exits 0 is indistinguishable from one that passed (found 2026-09-04).
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// The real reserved buckets are stored in matter.config.ts only as hashes, so branches 10 and 11a use a synthetic
// reserved bucket through the same check (CASEFILE_RESERVED_BUCKETS is inherited by every child matter-check run).
const reservedTestBucket = "casefile-reserved-synthetic-sources";
process.env.CASEFILE_RESERVED_BUCKETS = reservedTestBucket;

// The real refused refs are stored in matter-check.ts only as hashes, so branch 5 refuses a
// synthetic ref through the same code path (CASEFILE_REFUSED_PROJECT_REFS is inherited by
// every child matter-check run).
const SYNTHETIC_REFUSED_REF = "refusedforeignrefxyz";
process.env.CASEFILE_REFUSED_PROJECT_REFS = SYNTHETIC_REFUSED_REF;

const envPath = fs.existsSync(path.resolve(process.cwd(), ".env"))
  ? path.resolve(process.cwd(), ".env")
  : fs.existsSync(path.resolve(process.cwd(), ".env.local.example"))
    ? path.resolve(process.cwd(), ".env.local.example")
    : path.resolve(process.cwd(), ".env.matter.example");
const baseEnv = fs.readFileSync(envPath, "utf8");

interface BranchOutcome {
  name: string;
  expected: "fail" | "pass";
  actual: "fail" | "pass";
}

const outcomes: BranchOutcome[] = [];

function runCheck(tmpEnv: string, extraFlags: string): { passed: boolean; output: string } {
  try {
    const out = execSync(`npx tsx scripts/matter-check.ts "${tmpEnv}" --skip-cloud-run ${extraFlags}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { passed: true, output: out };
  } catch (err: unknown) {
    const errorObj = err as { stdout?: string; stderr?: string; message?: string };
    const output = (errorObj.stdout || "") + (errorObj.stderr || "") || errorObj.message || String(err);
    return { passed: false, output };
  }
}

function testBranch(name: string, description: string, mutator: (env: string) => string, extraFlags = "--skip-buckets") {
  console.log(`\n================================================================================`);
  console.log(`TESTING FAILING BRANCH: ${name}`);
  console.log(`Description: ${description}`);
  console.log(`================================================================================`);
  const brokenContent = mutator(baseEnv);
  const tmpEnv = path.resolve(process.cwd(), ".env.broken.tmp");
  fs.writeFileSync(tmpEnv, brokenContent, "utf8");

  try {
    const res = runCheck(tmpEnv, extraFlags);
    if (res.passed) {
      console.error(`FAIL: Expected check to fail, but it passed:\n${res.output}`);
      outcomes.push({ name, expected: "fail", actual: "pass" });
    } else {
      console.log(res.output.trim());
      console.log(`OK: check failed as expected.`);
      outcomes.push({ name, expected: "fail", actual: "fail" });
    }
  } finally {
    if (fs.existsSync(tmpEnv)) {
      fs.unlinkSync(tmpEnv);
    }
  }
}

function testPassingBranch(name: string, description: string, mutator: (env: string) => string, extraFlags = "--skip-buckets") {
  console.log(`\n================================================================================`);
  console.log(`TESTING PASSING BRANCH: ${name}`);
  console.log(`Description: ${description}`);
  console.log(`================================================================================`);
  const modifiedContent = mutator(baseEnv);
  const tmpEnv = path.resolve(process.cwd(), ".env.passing.tmp");
  fs.writeFileSync(tmpEnv, modifiedContent, "utf8");

  try {
    const res = runCheck(tmpEnv, extraFlags);
    if (res.passed) {
      console.log(res.output.trim());
      console.log(`OK: check passed as expected.`);
      outcomes.push({ name, expected: "pass", actual: "pass" });
    } else {
      console.error(`FAIL: Expected check to pass, but it failed:\n${res.output}`);
      outcomes.push({ name, expected: "pass", actual: "fail" });
    }
  } finally {
    if (fs.existsSync(tmpEnv)) {
      fs.unlinkSync(tmpEnv);
    }
  }
}

function testCustomBranch(
  name: string,
  description: string,
  mutator: (env: string) => string,
  flags: string,
  expected: "fail" | "pass" = "fail"
) {
  console.log(`\n================================================================================`);
  console.log(`TESTING ${expected.toUpperCase()}ING BRANCH: ${name}`);
  console.log(`Description: ${description}`);
  console.log(`================================================================================`);
  const content = mutator(baseEnv);
  const tmpEnv = path.resolve(process.cwd(), `.env.custom.${expected}.tmp`);
  fs.writeFileSync(tmpEnv, content, "utf8");

  try {
    let passed = false;
    let output = "";
    try {
      output = execSync(`npx tsx scripts/matter-check.ts "${tmpEnv}" ${flags}`, {
        encoding: "utf8",
        stdio: "pipe",
      });
      passed = true;
    } catch (err: unknown) {
      const errorObj = err as { stdout?: string; stderr?: string; message?: string };
      output = (errorObj.stdout || "") + (errorObj.stderr || "") || errorObj.message || String(err);
      passed = false;
    }

    const actual = passed ? "pass" : "fail";
    if (actual === expected) {
      console.log(output.trim());
      console.log(`OK: check ${actual}ed as expected.`);
      outcomes.push({ name, expected, actual });
    } else {
      console.error(`FAIL: Expected check to ${expected}, but it ${actual}ed:\n${output}`);
      outcomes.push({ name, expected, actual });
    }
  } finally {
    if (fs.existsSync(tmpEnv)) {
      fs.unlinkSync(tmpEnv);
    }
  }
}

async function run() {
  // Branch 1: Missing required variable
  testBranch("1. Missing Required Variable", "Omit SUPABASE_PROJECT_REF from .env", (env) =>
    env.split("\n").filter((line) => !line.startsWith("SUPABASE_PROJECT_REF=")).join("\n")
  );

  // Branch 2a: Unreplaced <...> placeholder
  testBranch("2a. Template Placeholder <PROJECT_REF>", "Set SUPABASE_URL to https://<PROJECT_REF>.supabase.co", (env) =>
    env.replace(/SUPABASE_URL=.*/, "SUPABASE_URL=https://<PROJECT_REF>.supabase.co")
  );

  // Branch 2b: CHANGEME placeholder
  testBranch("2b. CHANGEME Placeholder", "Set JWT_SECRET to CHANGEME_SECRET_TOKEN", (env) =>
    env.replace(/JWT_SECRET=.*/, "JWT_SECRET=CHANGEME_SECRET_TOKEN")
  );

  // Branch 2c: Zero UUID 00000000-0000 placeholder
  testBranch("2c. Zero UUID Placeholder", "Set MATTER_TENANT_ID to 00000000-0000-0000-0000-000000000000", (env) =>
    env.replace(/MATTER_TENANT_ID=.*/, "MATTER_TENANT_ID=00000000-0000-0000-0000-000000000000")
  );

  // Branch 3: DATABASE_URL project ref mismatch
  testBranch("3. DATABASE_URL Project Ref Mismatch", "Change DATABASE_URL ref to wrongref999", (env) =>
    env.replace(/DATABASE_URL=postgresql:\/\/casefile_app\.[a-z0-9]+:/, "DATABASE_URL=postgresql://casefile_app.wrongref999:")
  );

  // Branch 4: DATABASE_URL_MIGRATIONS project ref mismatch
  testBranch("4. DATABASE_URL_MIGRATIONS Project Ref Mismatch", "Change DATABASE_URL_MIGRATIONS ref to foreignmig888", (env) =>
    env.replace(/DATABASE_URL_MIGRATIONS=postgresql:\/\/postgres\.[a-z0-9]+:/, "DATABASE_URL_MIGRATIONS=postgresql://postgres.foreignmig888:")
  );

  // Branch 5: Refused foreign project ref
  testBranch("5. Refused Foreign Project Ref", `Inject refused ref ${SYNTHETIC_REFUSED_REF} into DATABASE_URL`, (env) =>
    env.replace(/DATABASE_URL=.*/, `DATABASE_URL=postgresql://casefile_app.${SYNTHETIC_REFUSED_REF}:<APP_PASSWORD>@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`)
  );

  // Branch 6: Port 6543 (transaction pooler) rejected
  testBranch("6. Transaction Pooler Port 6543 Rejected", "Configure DATABASE_URL with port 6543 instead of session pooler 5432", (env) =>
    env.replace(/:5432\/postgres/, ":6543/postgres")
  );

  // Branch 7a: Missing Keyless Signing Service Account Email when STORAGE_DRIVER=gcs
  testBranch("7a. Missing Keyless Service Account Email", "STORAGE_DRIVER=gcs with neither GCS_SERVICE_ACCOUNT_EMAIL nor key file", (env) =>
    env.split("\n").filter((line) => !line.startsWith("GCS_SERVICE_ACCOUNT_EMAIL=")).join("\n")
  );

  // Branch 7b: Invalid Service Account Email
  testBranch("7b. Invalid Service Account Email", "Set GCS_SERVICE_ACCOUNT_EMAIL to invalid_email_string", (env) =>
    env.replace(/GCS_SERVICE_ACCOUNT_EMAIL=.*/, "GCS_SERVICE_ACCOUNT_EMAIL=invalid_email_string")
  );

  // Branch 8: Nonexistent GCS Bucket (live bucket check active)
  testBranch("8. Nonexistent GCS Bucket", "Set GCS_BUCKET_SOURCES to casefile-nonexistent-bucket-99999", (env) =>
    env.replace(/GCS_BUCKET_SOURCES=.*/, "GCS_BUCKET_SOURCES=casefile-nonexistent-bucket-99999"),
    ""
  );

  // Branch 10: Reserved Bucket Collision (Step 28a)
  testBranch("10. Reserved Bucket Collision", `Set GCS_BUCKET_SOURCES to reserved bucket ${reservedTestBucket} for non-sandbox matter`, (env) =>
    env.replace(/GCS_BUCKET_SOURCES=.*/, `GCS_BUCKET_SOURCES=${reservedTestBucket}\nMATTER_SLUG=meridian`),
    ""
  );

  // Branch 11a: Foreign Object Collision on Adopt - Foreign UUID Prefix Rejected (Step 28b / Step 29a)
  testBranch("11a. Foreign UUID Collision on Adopt (FAIL)", `Adopt bucket ${reservedTestBucket} containing objects under foreign UUID prefixes`, (env) =>
    env.replace(/GCS_BUCKET_SOURCES=.*/, `GCS_BUCKET_SOURCES=${reservedTestBucket}\nMATTER_TENANT_ID=11111111-2222-3333-4444-555555555555`) +
    "\nMATTER_SLUG=meridian",
    ""
  );

  // Branch 11b: Baseline configuration passes with live bucket checks when explicit bypass flag is provided for sandbox.
  testPassingBranch(
    "11b. Baseline .env (PASS)",
    "The committed .env passes every check including live bucket describe",
    (env) => env,
    "--i-accept-cross-matter-contamination"
  );

  // Branch 12: Bucket Binding — a bucket outside matterConfig.buckets / ingestBuckets is refused
  testBranch("12. Bucket Binding Violation", "Set GCS_BUCKET_SOURCES to another matter's bucket casefile-othermatter-sources", (env) =>
    env.replace(/GCS_BUCKET_SOURCES=.*/, "GCS_BUCKET_SOURCES=casefile-othermatter-sources")
  );

  // Branch 13: Cloud Run Service Isolation Violation (one matter means one project)
  testCustomBranch(
    "13. Cloud Run Service Isolation Violation",
    "Refuse GCP project containing foreign Cloud Run services not matching casefile-<slug>-",
    (env) => env,
    "--skip-buckets",
    "fail"
  );

  // Branch 14: Bucket Isolation Violation (one matter means one project)
  testCustomBranch(
    "14. Bucket Isolation Violation",
    "Refuse GCP project containing foreign buckets belonging to another matter",
    (env) => env,
    "--skip-cloud-run",
    "fail"
  );

  // Branch 15: Missing GCP_PROJECT_ID
  testBranch(
    "15. Missing GCP_PROJECT_ID",
    "Omit GCP_PROJECT_ID from environment",
    (env) => env.split("\n").filter((l) => !l.startsWith("GCP_PROJECT_ID=")).join("\n")
  );

  // Branch 16: Missing GCP_REGION
  testBranch(
    "16. Missing GCP_REGION",
    "Omit GCP_REGION from environment",
    (env) => env.split("\n").filter((l) => !l.startsWith("GCP_REGION=")).join("\n")
  );

  // Branch 17: Missing SUPABASE_REGION
  testBranch(
    "17. Missing SUPABASE_REGION",
    "Omit SUPABASE_REGION from environment and omit region from DATABASE_URL",
    (env) =>
      env
        .split("\n")
        .filter((l) => !l.startsWith("SUPABASE_REGION="))
        .join("\n")
        .replace(/@aws-\d+-[a-z0-9-]+\.pooler/, "@db.pooler")
  );

  // Branch 18: --i-accept-cross-matter-contamination rejected when NODE_ENV=production
  testCustomBranch(
    "18. Contamination flag rejected in production",
    "Reject --i-accept-cross-matter-contamination when NODE_ENV=production",
    (env) => env + "\nNODE_ENV=production",
    "--i-accept-cross-matter-contamination",
    "fail"
  );

  // Branch 19: --i-accept-cross-matter-contamination rejected on non-test project
  testCustomBranch(
    "19. Contamination flag rejected on foreign client project",
    "Reject --i-accept-cross-matter-contamination when targeting client project",
    (env) => env.replace(/GCP_PROJECT_ID=.*/, "GCP_PROJECT_ID=client-sensitive-matter-prod"),
    "--i-accept-cross-matter-contamination",
    "fail"
  );

  // ── Summary and exit code ───────────────────────────────────────────────────
  const mismatches = outcomes.filter((o) => o.expected !== o.actual);
  console.log(`\n================================================================================`);
  console.log(`HARNESS SUMMARY: ${outcomes.length} branches, ${outcomes.length - mismatches.length} behaved as expected, ${mismatches.length} did not`);
  for (const o of outcomes) {
    const mark = o.expected === o.actual ? "OK  " : "FAIL";
    console.log(`  ${mark}  ${o.name}  (expected ${o.expected}, got ${o.actual})`);
  }
  console.log(`================================================================================`);
  process.exitCode = mismatches.length > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error("Harness crashed:", err);
  process.exitCode = 1;
});
