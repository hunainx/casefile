/**
 * GUARDRAIL: typecheck-coverage
 *
 * `pnpm typecheck` runs `tsc -b` on the root tsconfig.json, which is a solution file: it
 * checks exactly the projects listed in its `references` and nothing else. Until
 * 2026-09-26 it referenced none of the workspace packages, so apps/api and five packages
 * carried 145 type errors (two of them real bugs) while `pnpm verify` stayed green.
 *
 * This suite fails if:
 *   1. a workspace package (pnpm-workspace.yaml) that has a tsconfig.json is not referenced
 *      from the root tsconfig.json;
 *   2. a tracked TypeScript file is not part of any referenced project, so no project
 *      would ever type-check it;
 *   3. the `typecheck` script stops being `tsc -b` on the root solution.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toRel = (p: string) => relative(ROOT, p).split("\\").join("/");

function readConfig(configPath: string): { raw: unknown; parsed: ts.ParsedCommandLine } {
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  if (read.error) {
    throw new Error(`${toRel(configPath)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  return { raw: read.config, parsed };
}

/** Absolute tsconfig paths referenced by the root solution file. */
function referencedConfigs(): string[] {
  const { parsed } = readConfig(resolve(ROOT, "tsconfig.json"));
  return (parsed.projectReferences ?? []).map((ref) => {
    const p = ref.path;
    return existsSync(p) && statSync(p).isDirectory() ? resolve(p, "tsconfig.json") : p;
  });
}

/** Directories matched by pnpm-workspace.yaml. Supports exact paths and a trailing "/*". */
function workspacePackageDirs(): string[] {
  const doc: unknown = parseYaml(readFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "utf8"));
  const rawPackages: unknown = typeof doc === "object" && doc !== null && "packages" in doc ? doc.packages : undefined;
  // Array.isArray narrows to any[]; re-widen to unknown[] before inspecting elements.
  const entries: unknown[] = Array.isArray(rawPackages) ? [...(rawPackages as unknown[])] : [];
  const patterns = entries.filter((p): p is string => typeof p === "string");
  if (patterns.length === 0) throw new Error("pnpm-workspace.yaml lists no packages");
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const base = resolve(ROOT, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(resolve(base, entry.name));
      }
    } else if (!pattern.includes("*")) {
      dirs.push(resolve(ROOT, pattern));
    } else {
      // Fail loudly rather than silently skip a glob this suite does not understand.
      throw new Error(`Unsupported pnpm-workspace.yaml pattern '${pattern}'; extend workspacePackageDirs()`);
    }
  }
  return dirs;
}

function trackedTypeScriptFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return stdout
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => /\.(ts|mts|cts|tsx)$/.test(f) && !f.endsWith(".d.ts"))
    .filter((f) => existsSync(resolve(ROOT, f)));
}

describe("GUARDRAIL: typecheck-coverage — pnpm typecheck covers the whole repository", () => {
  it("every workspace package with a tsconfig.json is referenced from the root tsconfig.json", () => {
    const referenced = new Set(referencedConfigs().map(toRel));
    const missing = workspacePackageDirs()
      .map((dir) => resolve(dir, "tsconfig.json"))
      .filter((cfg) => existsSync(cfg))
      .map(toRel)
      .filter((cfg) => !referenced.has(cfg));
    expect(
      missing,
      `Workspace packages whose tsconfig.json is not referenced from the root tsconfig.json, ` +
        `so \`pnpm typecheck\` never checks them. Add each to "references":\n` +
        missing.map((m) => `  ✖ ${m}`).join("\n"),
    ).toEqual([]);
  });

  it("every tracked TypeScript file belongs to a referenced project", () => {
    const covered = new Set<string>();
    for (const cfg of referencedConfigs()) {
      for (const f of readConfig(cfg).parsed.fileNames) covered.add(toRel(f));
    }
    const uncovered = trackedTypeScriptFiles().filter((f) => !covered.has(f));
    expect(
      uncovered,
      `TypeScript files that no project referenced from the root tsconfig.json includes, ` +
        `so nothing type-checks them. Add them to a project's "include" (tsconfig.tooling.json ` +
        `for repository tooling):\n` +
        uncovered.map((f) => `  ✖ ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("the typecheck script is `tsc -b` on the root solution and the solution has references", () => {
    const pkg: unknown = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const script =
      typeof pkg === "object" && pkg !== null && "scripts" in pkg &&
      typeof pkg.scripts === "object" && pkg.scripts !== null && "typecheck" in pkg.scripts
        ? pkg.scripts.typecheck
        : undefined;
    expect(typeof script === "string" && /^tsc -b(\s|$)/.test(script), `package.json "typecheck" must run \`tsc -b\` on the root, got: ${String(script)}`).toBe(true);
    expect(referencedConfigs().length).toBeGreaterThan(0);
  });
});
