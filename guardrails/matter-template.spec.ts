import { describe, it, expect } from "vitest";
import { MCP_TOOLS } from "../packages/mcp/src/index.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { matterConfig } from "../matter.config.js";
import { DENYLIST, findDenylistHits } from "./sensitive-denylist.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Supabase project refs that must never appear in the template (held in the denylist, as hashes only). */
const REFUSED_REF = DENYLIST.filter((e) => e.kind === "supabase-project-ref");

/**
 * Recursively collects file paths from a directory, ignoring specified folders.
 */
function walkDir(dir: string, ignoredDirs: string[]): string[] {
  let results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.includes(entry.name)) continue;
      results = results.concat(walkDir(fullPath, ignoredDirs));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

describe("Matter Template Guardrails", () => {
  it("matter.config.ts defines complete matter metadata", () => {
    expect(matterConfig.matterName).toBeTruthy();
    expect(matterConfig.matterSlug).toBeTruthy();
    expect(matterConfig.investigationName).toBeTruthy();
    expect(matterConfig.objective).toBeTruthy();
    expect(matterConfig.supabaseProjectRef).toBeTruthy();

    expect(matterConfig.buckets.sources).toBe(`casefile-${matterConfig.matterSlug}-sources`);
    expect(matterConfig.buckets.artifacts).toBe(`casefile-${matterConfig.matterSlug}-artifacts`);
    expect(matterConfig.buckets.exports).toBe(`casefile-${matterConfig.matterSlug}-exports`);

    expect(matterConfig.secrets.dbUrl).toBe(`casefile-${matterConfig.matterSlug}-db-url`);
    expect(matterConfig.secrets.jwtSecret).toBe(`casefile-${matterConfig.matterSlug}-jwt-secret`);
    expect(matterConfig.secrets.encryptionKey).toBe(`casefile-${matterConfig.matterSlug}-encryption-key`);
    expect(matterConfig.secrets.auditPepper).toBe(`casefile-${matterConfig.matterSlug}-audit-pepper`);
  });

  it(".env.matter.example exists and documents all required variables", () => {
    const envExamplePath = resolve(ROOT, ".env.matter.example");
    expect(existsSync(envExamplePath), ".env.matter.example must exist").toBe(true);

    const content = readFileSync(envExamplePath, "utf8");
    const requiredVars = [
      "DATABASE_URL",
      "DATABASE_URL_MIGRATIONS",
      "SUPABASE_PROJECT_REF",
      "GCS_BUCKET_SOURCES",
      "GCS_BUCKET_ARTIFACTS",
      "MATTER_TENANT_ID",
      "MATTER_INVESTIGATION_ID",
      "CASEFILE_API_URL",
    ];

    for (const v of requiredVars) {
      expect(content, `.env.matter.example must define ${v}`).toContain(`${v}=`);
    }
  });

  it("Step 12b: Foreign-project isolation: scans entire repository (including .env) for the refused foreign project ref", () => {
    const allFiles = walkDir(ROOT, ["node_modules", ".git", "dist", "coverage", "docs"]);

    // Include root .env files if present
    for (const envFile of [".env", ".env.local", ".env.sandbox", ".env.matter.example"]) {
      const p = resolve(ROOT, envFile);
      if (existsSync(p) && !allFiles.includes(p)) {
        allFiles.push(p);
      }
    }

    // No allowlist: the refs are held only as hashes (guardrails/sensitive-denylist.ts),
    // so no file has a legitimate reason to contain one.
    const violations: string[] = [];
    for (const filePath of allFiles) {
      const relPath = relative(ROOT, filePath).replace(/\\/g, "/");
      try {
        const content = readFileSync(filePath, "utf8");
        for (const hit of findDenylistHits(content, REFUSED_REF)) {
          violations.push(`${relPath}:${hit.line}: ${hit.text}`);
        }
      } catch {
        // binary or unreadable file
      }
    }

    expect(
      violations,
      `FATAL: Refused foreign project ref found in repository!\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("Step 13a: Template Purity: scans codebase for hardcoded matter slugs, deployed URLs, or static matter resource names", () => {
    const ignoredDirs = [
      "node_modules",
      ".git",
      "dist",
      "coverage",
      "scratch",
      "docs",
      "traceability",
      "test-results",
    ];

    const allFiles = walkDir(ROOT, ignoredDirs);

    // Named allowlist of files with justification:
    const ALLOWLIST_FILES: Record<string, string> = {
      "matter.config.ts": "Single source of truth defining matter metadata and slug",
      ".env": "Active instance runtime configuration for the local machine",
      ".env.matter.example": "Example matter deployment environment template",
      "scripts/deploy-matter.ts": "Matter deployment orchestrator that provisions matter names",
      "scripts/matter-check.ts": "Preflight check validator displaying active matterConfig",
      "scripts/test-matter-check-branches.ts": "Test runner exercising preflight check branches",
      "guardrails/reserved-buckets.spec.ts": "Proves the reserved-bucket refusal with synthetic bucket names (the real ones are held only as hashes)",
      "guardrails/matter-template.spec.ts": "This guardrail test inspecting template properties",
      "guardrails/tenancy.spec.ts": "PRD security invariant I7 test referencing parser sandbox isolation",
      "guardrails/test-bucket-isolation.spec.ts": "Pins every test bucket reference to casefile-localtest-* by design and must name that prefix to enforce it",
      "tools/ingest-cli/test/format-parsers.integration.test.ts": "Reads synthetic parser fixtures only from the local test-corpus/ directory, regardless of which matter the template is deployed as",
      ".env.local.example": "Local Docker development environment template",
      "vitest.integration.config.ts": "Integration test runner configuration setting up the local test buckets (casefile-localtest-*)",
      "guardrails/no-shipped-secrets.spec.ts": "Guardrail preventing shipped secrets, live infrastructure identifiers and real names",
      "scripts/new-matter.ts": "Interactive CLI for scaffolding new matter configurations",
      "MATTER-SETUP.md": "Documentation guide with exemplary configuration snippets",
      "README.md": "Root repository documentation",
    };

    const matterSlug = matterConfig.matterSlug;
    // Legacy-prefixed resource names are caught everywhere by no-shipped-secrets.spec.ts.
    const resourcePattern = /casefile-[a-z0-9-]+-(api|sources|artifacts|exports)/i;
    const cloudRunUrlPattern = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.run\.app/i;
    const hardcodedSlugLiteral = new RegExp(`['"\`]${matterSlug}['"\`]`, "i");

    const violations: string[] = [];

    for (const filePath of allFiles) {
      const relPath = relative(ROOT, filePath).replace(/\\/g, "/");

      if (ALLOWLIST_FILES[relPath]) {
        continue;
      }

      // Check file content
      try {
        const content = readFileSync(filePath, "utf8");
        const lines = content.split("\n");

        lines.forEach((line, lineIdx) => {
          // Check for hardcoded matter slug string literal (if not a generic placeholder)
          if (!matterSlug.includes("<") && hardcodedSlugLiteral.test(line)) {
            violations.push(`${relPath}:${lineIdx + 1} contains hardcoded matter slug '${matterSlug}': ${line.trim()}`);
          }
          // Check for hardcoded resource names
          else if (resourcePattern.test(line) && !line.includes("${") && !line.includes("-<") && !line.includes("<MATTER_SLUG>")) {
            violations.push(`${relPath}:${lineIdx + 1} contains hardcoded resource pattern: ${line.trim()}`);
          }
          // Check for hardcoded Cloud Run *.run.app URLs
          else if (cloudRunUrlPattern.test(line) && !line.includes("<MATTER_SLUG>")) {
            violations.push(`${relPath}:${lineIdx + 1} contains hardcoded Cloud Run URL: ${line.trim()}`);
          }
        });
      } catch {
        // Binary / unreadable file
      }
    }

    expect(
      violations,
      `Template purity violations found! Code must use matterConfig or dynamic env vars instead of hardcoded matter literals:\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("Step 20c: Tool Documentation Parity: verifies tools documented in MATTER-SETUP.md match MCP_TOOLS exactly", () => {
    const setupPath = resolve(ROOT, "MATTER-SETUP.md");
    const setupContent = readFileSync(setupPath, "utf8");

    // Extract tool names from numbered list in Section 5: e.g. "1. `matter_status`:"
    const docToolMatches = [...setupContent.matchAll(/^\d+\.\s+`([a-z_]+)`:/gm)];
    const docTools = new Set(docToolMatches.map((m) => m[1]));

    // The tools /mcp and the stdio CLI serve (packages/mcp/src/dispatch.ts since Phase 3, D77).
    const codeTools = new Set(MCP_TOOLS.map((t) => t.name));
    expect(codeTools.size, "MCP_TOOLS is empty").toBeGreaterThan(0);

    expect(
      Array.from(docTools).sort(),
      `Mismatch between MATTER-SETUP.md documented tools and MCP_TOOLS in packages/mcp/src/dispatch.ts`
    ).toEqual(Array.from(codeTools).sort());
  });
});
