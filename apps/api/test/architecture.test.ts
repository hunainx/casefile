import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildApp } from "../src/app.js";

const ROOT = resolve(process.cwd());

function getSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist" && entry !== ".git") {
        files.push(...getSourceFiles(fullPath));
      }
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("apps/api — Architecture & Security Gates", () => {
  it("deny-by-default at routing layer: all registered routes declare permission, authenticated, or public", async () => {
    const app = buildApp({ logger: false });
    await app.ready();

    // Verify app booted and inspected routes during onRoute registration
    // If any route lacked declaration, buildApp / app.ready would throw during registration.
    expect(app).toBeDefined();
    await app.close();
  });

  it("no route handler in apps/api/src/routes directly imports a database client or postgres", () => {
    const routesDir = resolve(ROOT, "apps/api/src/routes");
    const routeFiles = getSourceFiles(routesDir);

    for (const file of routeFiles) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/from\s+["']postgres["']/);
      expect(content).not.toMatch(/getDb\s*\(/);
      expect(content).not.toMatch(/createDbClient\s*\(/);
      expect(content).not.toMatch(/new\s+Client\s*\(/);
    }
  });

  it("logging content scanner (§48, HANDOFF §7.1): no logger call formats content-bearing variables or PII", () => {
    const srcDir = resolve(ROOT, "apps/api/src");
    const srcFiles = getSourceFiles(srcDir);

    // Forbidden variable names in logging contexts per PRD §48
    const forbiddenPatterns = [
      /\b(req\.log|fastify\.log|logger|console\.(log|info|debug))\s*\(\s*[^)]*\b(prompt|completion|raw_content|document_content|plaintext|unredacted_body|pii_payload|ssn|credit_card)\b/i,
      /\b(req\.log|fastify\.log|logger|console\.(log|info|debug))\s*\(\s*[^)]*\b(password|secret_key|totp_secret|refresh_token)\b/i,
    ];

    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(
          content,
          `File ${file} contains a logging call matching forbidden content/PII pattern: ${pattern.toString()}`,
        ).not.toMatch(pattern);
      }
    }
  });
});
