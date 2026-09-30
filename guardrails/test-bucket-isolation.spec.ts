/**
 * GUARDRAIL: test-bucket-isolation
 *
 * Tests must never read from or write to a real matter's bucket. On 2026-09-04 the
 * format-parser integration suite was found downloading client evidence out of two live
 * matter buckets on every run. The fixtures are now synthetic files in test-corpus/, and
 * integration tests write only to the casefile-localtest-* buckets on the local fake-gcs
 * emulator (vitest.integration.config.ts). This suite makes sure it stays that way.
 *
 * Rule: any bucket name that appears in a file under a `test/` directory, or in a
 * `*.spec.ts` file, must start with `casefile-localtest-`. A bucket name is anything that
 * appears as
 *   - the host of a gs:// or gcs:// URI literal,
 *   - the first string argument to downloadBucketObject(), listBucketObjects() or
 *     runBucketInventory(),
 *   - the string argument to .bucket("...").
 * Template expressions (`gs://${...}`) and documentation placeholders (`gs://<...>`)
 * are not bucket names and are ignored.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_PREFIX = "casefile-localtest-";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".pgdata",
  ".pglogs",
  "scratch",
  "test-results",
  ".tmp-test-fixtures",
]);

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile() && /\.(ts|js|mjs|cjs|json|sh|ps1|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isTestPath(rel: string): boolean {
  return rel.split("/").includes("test") || rel.endsWith(".spec.ts");
}

// Built from fragments so this file does not itself contain a literal bucket URI.
const NAME = "([A-Za-z0-9._-]+)";
const BUCKET_REFERENCE_PATTERNS: RegExp[] = [
  new RegExp("g" + "s:" + "//" + NAME, "g"),
  new RegExp("gc" + "s:" + "//" + NAME, "g"),
  new RegExp("(?:downloadBucketObject|listBucketObjects|runBucketInventory)\\(\\s*[\"'`]" + NAME + "[\"'`]", "g"),
  new RegExp("\\.bucket\\(\\s*[\"'`]" + NAME + "[\"'`]", "g"),
];

export function findForeignBucketReferences(content: string): Array<{ line: number; name: string; text: string }> {
  const hits: Array<{ line: number; name: string; text: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const pattern of BUCKET_REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        const name = m[1]!;
        if (!name.startsWith(SANDBOX_PREFIX)) {
          hits.push({ line: i + 1, name, text: line.trim() });
        }
      }
    }
  }
  return hits;
}

describe("Tests never touch a real matter bucket", () => {
  it("every bucket name in a test/ path or *.spec.ts file starts with casefile-localtest-", () => {
    const violations: string[] = [];
    for (const file of collectFiles(ROOT)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (!isTestPath(rel)) continue;
      // This file deliberately contains foreign sample names for its own self-check.
      if (rel === "guardrails/test-bucket-isolation.spec.ts") continue;
      const content = readFileSync(file, "utf8");
      for (const hit of findForeignBucketReferences(content)) {
        violations.push(`${rel}:${hit.line} references bucket '${hit.name}': ${hit.text}`);
      }
    }
    expect(
      violations,
      `Test code references a bucket outside casefile-localtest-*. Tests must read fixtures ` +
        `from the local test-corpus/ directory and only write to casefile-localtest-* buckets.\n` +
        violations.join("\n"),
    ).toEqual([]);
  });

  it("the detector recognises every reference shape it claims to (self-check)", () => {
    const sample = [
      'const a = downloadBucketObject("some-matter", "x.pdf");',
      "const b = `gs" + "://another-matter/path`;",
      'const c = storage.bucket("third-matter");',
      'const ok1 = downloadBucketObject("casefile-localtest-sources", "test-corpus/x.pdf");',
      "const ok2 = `gs" + "://${bucket}/path`;",
    ].join("\n");
    const names = findForeignBucketReferences(sample).map((h) => h.name).sort();
    expect(names).toEqual(["another-matter", "some-matter", "third-matter"]);
  });
});
