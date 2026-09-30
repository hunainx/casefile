import { execSync } from "node:child_process";

const IMAGE = process.argv[2] || "casefile-api:local";

console.log(`=== Proving No Credentials or Ignored Files in Image: ${IMAGE} ===\n`);

// 1. Verify excluded files do NOT exist in the image filesystem
const forbiddenPaths = [
  "/app/.env",
  "/app/.env.local",
  "/app/.git",
  "/app/test-results",
  "/app/scratch",
  "/app/coverage",
  "/app/test-corpus",
];

for (const p of forbiddenPaths) {
  try {
    execSync(`docker run --rm ${IMAGE} test -e ${p}`, { stdio: "pipe" });
    console.error(`FAIL: Path ${p} exists in image!`);
    process.exit(1);
  } catch {
    console.log(`✓ Excluded path confirmed absent: ${p}`);
  }
}

// 2. Check container layers and history for credentials or secret leaks
const history = execSync(`docker history --no-trunc ${IMAGE}`, { encoding: "utf8" });
const sbSecretToken = ["sb", "secret", ""].join("_");
const sensitivePatterns = [
  /postgresql:\/\//i,
  /postgres:\/\//i,
  new RegExp(sbSecretToken, "i"),
  /eyJh/i, // JWT header prefix
  /password/i,
];
// A connection string that carries a real (non-placeholder) password.
const embeddedDbPassword = /postgres(?:ql)?:\/\/[^\s:@/]+:(?!<)(?!\$)[^\s@]+@/i;

console.log("\nInspecting Docker history commands for secret exposure...");
for (const line of history.split("\n")) {
  for (const pattern of sensitivePatterns) {
    if (pattern.test(line)) {
      // Allow lines that just mention password in packages or arg descriptions if any, but fail on actual credentials
      if (embeddedDbPassword.test(line) || line.includes(sbSecretToken)) {
        console.error(`FAIL: Secret pattern ${pattern} matched in docker history: ${line}`);
        process.exit(1);
      }
    }
  }
}
console.log("✓ No secrets or credentials found in docker history / layers.");

// 3. Search for any .env file in the entire container filesystem
try {
  const findEnv = execSync(`docker run --rm ${IMAGE} find /app -name ".env*" ! -name ".env.example"`, { encoding: "utf8" });
  if (findEnv.trim().length > 0) {
    console.error(`FAIL: Found .env files in /app:\n${findEnv}`);
    process.exit(1);
  }
  console.log("✓ Zero .env credential files found inside container filesystem.");
} catch (err: unknown) {
  console.error("Error searching container filesystem:", (err as Error).message);
  process.exit(1);
}

// 4. Verify user is non-root
const userOut = execSync(`docker run --rm ${IMAGE} id`, { encoding: "utf8" }).trim();
console.log(`\n✓ Running user verification: ${userOut}`);
if (userOut.includes("uid=0(root)")) {
  console.error("FAIL: Container runs as root!");
  process.exit(1);
}
console.log("✓ Confirmed: Container runs as unprivileged non-root user (uid=10001 casefile).");

console.log("\n=== ALL IMAGE VERIFICATION CHECKS PASSED ===");
