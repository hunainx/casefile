import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Verification Pipeline Integrity Guardrail", () => {
  it("package.json verify script contains all 7 stages in exact required order", () => {
    const pkgPath = resolve(ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const verifyScript = pkg.scripts?.verify;

    expect(verifyScript, "package.json must define a 'verify' script").toBeTruthy();

    const expectedStages = [
      "lint",
      "typecheck",
      "test:unit",
      "test:integration",
      "guardrails",
      "audit:verification",
      "trace:report",
    ];

    // Split verify script by && separators and extract the command names
    const parts = verifyScript
      .split("&&")
      .map((p: string) => p.trim())
      .map((p: string) => p.replace(/^pnpm\s+/, "").trim());

    expect(
      parts,
      `verify script must execute all 7 stages in exact order: ${expectedStages.join(" -> ")}`
    ).toEqual(expectedStages);
  });

  it("every integration test file declared it()/test() block count matches vitest collected test count", () => {
    const lastRunPath = resolve(ROOT, "test-results/.integration-last-run.json");
    expect(existsSync(lastRunPath), "test-results/.integration-last-run.json must exist from integration test run").toBe(true);

    const lastRun = JSON.parse(readFileSync(lastRunPath, "utf8"));
    const filesRan = lastRun.files as Record<string, { ran: number; failed: number; skipped: number }>;

    // Find all integration test files
    const integrationFiles: string[] = [];
    function findIntegrationTests(dir: string) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name === "build" ||
          entry.name === ".tmp-test-fixtures"
        ) {
          continue;
        }
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          findIntegrationTests(full);
        } else if (entry.name.endsWith(".integration.test.ts")) {
          integrationFiles.push(full);
        }
      }
    }
    findIntegrationTests(ROOT);

    const discrepancies: string[] = [];

    for (const filePath of integrationFiles) {
      const fileName = basename(filePath);
      const content = readFileSync(filePath, "utf8");

      // Count it(...) and test(...) declarations in source (excluding comments)
      const lines = content.split(/\r?\n/);
      let declaredCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        const matches = trimmed.match(/(?:^|\s)(?:it|test)(?:\.(?:skip|only|concurrent))?\s*\(/g);
        if (matches) {
          declaredCount += matches.length;
        }
      }

      const record = filesRan[fileName];
      if (!record) {
        discrepancies.push(`${fileName}: declared ${declaredCount} tests, but file was not executed in integration run`);
        continue;
      }

      const collectedCount = record.ran + record.skipped;
      if (declaredCount !== collectedCount) {
        discrepancies.push(
          `${fileName}: declared ${declaredCount} it/test blocks in source, but vitest collected ${collectedCount} (ran: ${record.ran}, skipped: ${record.skipped})`
        );
      }
    }

    const diskFileBasenames = new Set(integrationFiles.map((f) => basename(f)));

    // Reverse check: assert every file recorded in the run actually exists on disk in the repo
    const phantomFiles: string[] = [];
    for (const recordedFileName of Object.keys(filesRan)) {
      if (!diskFileBasenames.has(recordedFileName)) {
        phantomFiles.push(recordedFileName);
      }
    }

    expect(
      phantomFiles,
      `Phantom test files detected in integration run results that do not exist on disk:\n${phantomFiles.map((f) => `  ✖ ${f}`).join("\n")}`
    ).toEqual([]);

    // Check unit last run if present
    const unitRunPath = resolve(ROOT, "test-results/.unit-last-run.json");
    if (existsSync(unitRunPath)) {
      const unitRun = JSON.parse(readFileSync(unitRunPath, "utf8"));
      const unitFilesRan = unitRun.files as Record<string, unknown>;
      const unitPhantomFiles: string[] = [];
      // Collect unit files on disk
      const unitFilesOnDisk = new Set<string>();
      function findUnitTests(dir: string) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === "dist" ||
            entry.name === "build" ||
            entry.name === ".tmp-test-fixtures"
          ) {
            continue;
          }
          const full = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            findUnitTests(full);
          } else if (entry.name.endsWith(".unit.test.ts")) {
            unitFilesOnDisk.add(basename(full));
          }
        }
      }
      findUnitTests(ROOT);
      for (const recordedFileName of Object.keys(unitFilesRan)) {
        if (!unitFilesOnDisk.has(recordedFileName)) {
          unitPhantomFiles.push(recordedFileName);
        }
      }
      expect(
        unitPhantomFiles,
        `Phantom test files detected in unit run results that do not exist on disk:\n${unitPhantomFiles.map((f) => `  ✖ ${f}`).join("\n")}`
      ).toEqual([]);
    }

    expect(
      discrepancies,
      `Integration test count drift detected:\n${discrepancies.map((d) => `  ✖ ${d}`).join("\n")}`
    ).toEqual([]);
  });
});
