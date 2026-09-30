import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collectFiles(dir: string, fileList: string[] = []): string[] {
  const ignored = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".turbo",
    ".gemini",
    "test-results",
    "coverage",
    ".tmp-test-fixtures",
  ];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.includes(entry.name)) continue;
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, fileList);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") ||
        entry.name.endsWith(".js") ||
        entry.name.endsWith(".sh") ||
        entry.name.endsWith(".ps1") ||
        entry.name.endsWith(".json"))
    ) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

describe("Standing Rule D62 Guardrail — GCS Bucket Object Deletion Prohibition", () => {
  it("prohibits storage rm, deleteFiles, storage .delete(), and recursive gs:// deletions outside packages/storage/src/gcs.ts", () => {
    const files = collectFiles(ROOT);
    const violations: Array<{ file: string; line: number; match: string }> = [];

    const allowedFiles = [
      resolve(ROOT, "packages/storage/src/gcs.ts"),
      resolve(ROOT, "packages/storage/test/storage.unit.test.ts"),
      resolve(ROOT, "guardrails/bucket-deletion.spec.ts"),
    ];

    // Patterns indicating GCS bucket object deletion or rm commands
    const forbiddenPatterns = [
      /\bstorage\s+rm\b/,
      /\bdeleteFiles\s*\(/,
      /\.delete\s*\([^)]*gs:\/\//,
      /--recursive\s+[^\n]*gs:\/\//,
      /gs:\/\/[^\n\s]*\s+[^\n]*--recursive/,
    ];

    for (const filePath of files) {
      if (allowedFiles.some((allowed) => resolve(filePath) === allowed)) {
        continue;
      }

      const content = readFileSync(filePath, "utf-8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Skip comment lines in docs or test explanations if they cite rule prohibitions
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(line)) {
            violations.push({
              file: relative(ROOT, filePath).replace(/\\/g, "/"),
              line: i + 1,
              match: line.trim(),
            });
          }
        }
      }
    }

    expect(
      violations,
      `Standing Rule D62 violation: Found forbidden GCS deletion commands in codebase:\n${violations
        .map((v) => `  ${v.file}:${v.line} -> ${v.match}`)
        .join("\n")}`
    ).toEqual([]);
  });
});

/**
 * BIGDATA-3 (D98): triage, the report and the include command only RECORD decisions. Their code
 * may list and read bucket objects, never write one: no delete, move, copy, rename, overwrite
 * (save / upload / write stream / object store put), metadata change or compose. The include
 * command re-admits a skipped object through ingest.ts's processSingleItem, which is where the
 * existing ingest writes new source objects (zip entries and attachments); nothing here does.
 * tools/ingest-cli/test/triage-bucket-readonly.integration.test.ts checks the same at run time.
 */
describe("BIGDATA-3 — triage, report and include never write to a bucket", () => {
  const TRIAGE_FILES = [
    "tools/ingest-cli/src/triage.ts",
    "tools/ingest-cli/src/report.ts",
    "tools/ingest-cli/src/include.ts",
    // BIGDATA-3B: the mailbox readers only read (mailbox-ingest.ts stores new sources, as ingest.ts does).
    "tools/ingest-cli/src/mailbox.ts",
    "tools/ingest-cli/src/mailbox-paths.ts",
    "tools/ingest-cli/src/mbox.ts",
    "tools/ingest-cli/src/pst.ts",
  ];
  // Pure rule code: it must not even import a storage client.
  const PURE_FILES = ["tools/ingest-cli/src/triage-rules.ts", "tools/ingest-cli/src/near-duplicates.ts"];

  it("the pure rule files import no storage client", () => {
    const found: string[] = [];
    for (const rel of PURE_FILES) {
      const content = readFileSync(resolve(ROOT, rel), "utf-8");
      for (const m of content.matchAll(/from\s+["']([^"']+)["']/g)) if (/storage|gcs|node:fs/.test(m[1]!)) found.push(`${rel} imports ${m[1]}`);
    }
    expect(found).toEqual([]);
  });
  const WRITE_CALLS: Array<[string, RegExp]> = [
    ["delete", /\.delete\s*\(/],
    ["deleteFiles", /\bdeleteFiles\s*\(/],
    ["move", /\.move\s*\(/],
    ["copy", /\.copy\s*\(/],
    ["rename", /\.rename\s*\(/],
    ["save", /\.save\s*\(/],
    ["upload", /\.upload\s*\(/],
    ["createWriteStream", /\bcreateWriteStream\s*\(/],
    ["createResumableUpload", /\bcreateResumableUpload\s*\(/],
    ["setMetadata", /\bsetMetadata\s*\(/],
    ["combine", /\.combine\s*\(/],
    ["object store put", /\.put(File)?\s*\(/],
    ["getObjectStore", /\bgetObjectStore\s*\(/],
    ["gcloud storage write", /\b(storage|gsutil)\s+(rm|mv|cp)\b/],
  ];

  it("each triage file exists, and none of them calls a bucket write", () => {
    const found: string[] = [];
    for (const rel of TRIAGE_FILES) {
      const content = readFileSync(resolve(ROOT, rel), "utf-8");
      content.split(/\r?\n/).forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may name what is forbidden
        for (const [name, re] of WRITE_CALLS) if (re.test(line)) found.push(`${rel}:${i + 1} (${name}) -> ${line.trim()}`);
      });
    }
    expect(found, `Triage must only record decisions (D98). Bucket writes found:\n${found.join("\n")}`).toEqual([]);
  });
});
