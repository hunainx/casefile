import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function generateSafePassword(length = 32): string {
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

async function main() {
  const projectId = process.env.GCP_PROJECT_ID || "<GCP_PROJECT_ID>";
  const secretName = `casefile-${process.env.MATTER_SLUG || "<MATTER_SLUG>"}-mcp-token`;
  const newToken = `mcp_sec_${generateSafePassword(32)}`;

  const tempFile = path.resolve(process.cwd(), ".tmp_token.txt");
  fs.writeFileSync(tempFile, newToken, "utf8");

  try {
    console.log(`Adding new secret version to Secret Manager (${secretName})...`);
    execSync(`gcloud.cmd secrets versions add ${secretName} --data-file="${tempFile}" --project=${projectId}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    console.log("✓ Added new version to Secret Manager.");
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }

  // Update .env with new token
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    let content = fs.readFileSync(envPath, "utf8");
    content = content.replace(/MCP_TOKEN=.*/, `MCP_TOKEN=${newToken}`);
    fs.writeFileSync(envPath, content, "utf8");
    console.log("✓ Updated .env with new rotated token.");
  }
}

main().catch((err) => {
  console.error("Rotation error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
