/**
 * Generated fake-corpus files never live inside the repository (BIGDATA-1).
 *
 * `pnpm fake-corpus` writes outside the repository and refuses a folder inside it. This guardrail
 * catches a corpus, or part of one, copied in by hand: it walks every file under the repository
 * root (tracked, untracked and ignored alike; only .git and node_modules are skipped) and fails on
 *   - the corpus marker file, manifest or summary, by name;
 *   - the corpus marker bytes inside any file that is not source code. The generator writes the
 *     marker into every non-empty file it makes (email header, PDF info string, PNG tEXt chunk,
 *     zip comment, or appended bytes) and it never makes a source-code file, so .ts/.js files,
 *     where the marker is defined and tested, are not searched.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { MANIFEST_FILE, MARKER_FILE, MARKER_PREFIX, REPO_ROOT, SUMMARY_FILE } from "../tools/fake-corpus/src/marker.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);
const SOURCE_CODE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const CORPUS_NAMES = new Set([MARKER_FILE, MANIFEST_FILE, SUMMARY_FILE]);

export function findFakeCorpusFiles(root: string): string[] {
  const marker = Buffer.from(MARKER_PREFIX);
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full).replace(/\\/g, "/");
      if (CORPUS_NAMES.has(entry.name)) {
        hits.push(`${rel} (fake-corpus ${entry.name === MARKER_FILE ? "marker file" : "manifest/summary"})`);
        continue;
      }
      if (SOURCE_CODE.has(extname(entry.name).toLowerCase())) continue;
      if (statSync(full).size === 0) continue;
      if (readFileSync(full).includes(marker)) hits.push(`${rel} (contains the fake-corpus marker)`);
    }
  };
  walk(root);
  return hits;
}

describe("GUARDRAIL: no generated fake-corpus files inside the repository", () => {
  it("no file under the repository root is a generated corpus file", () => {
    expect(findFakeCorpusFiles(REPO_ROOT)).toEqual([]);
  });
});
