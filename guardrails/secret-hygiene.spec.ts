/**
 * GUARDRAIL: secret-hygiene — REQ-M-SEC-017 / 018 / 019
 *
 * Closes the class of defect found on 2026-09-04: apps/api/src/auth/crypto.ts fell back
 * to a public literal when JWT_SECRET was unset, JWT_SECRET was set nowhere, and the
 * deploy script never mounted it — so every deployed matter signed sessions with a
 * string anyone could read out of the repository.
 *
 *   1. No literal fallback on a secret-shaped environment variable, anywhere in source.
 *   2. scripts/deploy-matter.ts mounts every secret the API requires to boot.
 *   3. The API process actually refuses to start when each required secret is missing.
 *
 * Real assertions only. Each of the five boot checks spawns the real entry point.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { REQUIRED_RUNTIME_SECRETS } from "../apps/api/src/config/required-secrets.js";
import { REQUIRED_RUNTIME_SETTINGS } from "../apps/api/src/config/required-settings.js";
import { findSecretFallbacks } from "./secret-hygiene-detector.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["apps", "packages", "tools", "scripts"];

/**
 * Root-level .ts configuration files. They are not under SCAN_DIRS, and on 2026-09-04
 * three test-cluster fallbacks were moved into them — exactly the shape REQ-M-SEC-017
 * forbids, sitting where the detector did not look. They are scanned individually.
 */
const ROOT_CONFIG_FILES = [
  "vitest.unit.config.ts",
  "vitest.integration.config.ts",
  "guardrails/vitest.config.ts",
  "matter.config.ts",
];

/**
 * The ONLY secret-shaped fallbacks permitted anywhere, as exact (file, variable) pairs.
 * Each points at the local test Postgres cluster brought up by scripts/dev-db.sh — no
 * remote host, no real credential — and exists so `pnpm test:integration` and
 * `pnpm guardrails` run on a fresh checkout without exporting anything, while CI's own
 * DATABASE_URL_TEST / DATABASE_URL_TEST_OWNER take precedence. Never allowlist by
 * directory, by regex, or by variable name alone: any other secret-shaped fallback in
 * these files fails, and a stale entry (fallback no longer present) also fails.
 */
const TEST_CLUSTER_FALLBACK_ALLOWLIST: ReadonlyArray<{ file: string; name: string; why: string }> = [
  {
    file: "vitest.integration.config.ts",
    name: "DATABASE_URL_TEST",
    why: "casefile_app role on the local test cluster (127.0.0.1:55432/casefile_test); replaces the literal removed from packages/db/src/client.ts",
  },
  {
    file: "vitest.integration.config.ts",
    name: "DATABASE_URL_TEST_OWNER",
    why: "owner role on the local test cluster, used only to run migrations in packages/db/test/tenancy.integration.test.ts",
  },
  {
    file: "guardrails/vitest.config.ts",
    name: "DATABASE_URL_TEST",
    why: "casefile_app role on the local test cluster for the guardrail suites' RLS probes",
  },
];

function isAllowlisted(rel: string, name: string): boolean {
  return TEST_CLUSTER_FALLBACK_ALLOWLIST.some((entry) => entry.file === rel && entry.name === name);
}
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", "coverage"]);
const SKIP_PATH_PREFIXES = ["scripts/archive/"];

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    const rel = relative(ROOT, full).split("\\").join("/");
    if (SKIP_PATH_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p))) continue;
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("REQ-M-SEC-017 — no literal fallback on a secret-shaped environment variable", () => {
  it("no .ts file under apps/, packages/, tools/, scripts/ defaults a secret-shaped env var to a string literal", () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectTsFiles(resolve(ROOT, dir))) {
        const rel = relative(ROOT, file).split("\\").join("/");
        for (const hit of findSecretFallbacks(readFileSync(file, "utf8"))) {
          violations.push(`${rel}:${hit.line} — process.env.${hit.name} falls back to a string literal`);
        }
      }
    }
    expect(
      violations,
      `A secret-shaped environment variable has a hardcoded default. A missing secret must fail loudly.\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("no root-level .ts config file defaults a secret-shaped env var to a string literal, except the named (file, variable) test-cluster pairs", () => {
    const violations: string[] = [];
    for (const rel of ROOT_CONFIG_FILES) {
      const content = readFileSync(resolve(ROOT, rel), "utf8");
      for (const hit of findSecretFallbacks(content)) {
        if (isAllowlisted(rel, hit.name)) continue;
        violations.push(`${rel}:${hit.line} — process.env.${hit.name} falls back to a string literal (not in TEST_CLUSTER_FALLBACK_ALLOWLIST)`);
      }
    }
    expect(
      violations,
      `A root config file defaults a secret-shaped environment variable. Only the exact (file, variable) pairs in ` +
        `TEST_CLUSTER_FALLBACK_ALLOWLIST may do that, and only for the local test cluster.\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("every allowlisted (file, variable) pair is real: the detector finds exactly those fallbacks in the root config files", () => {
    // Proves the pair-matching does the work: the detector DOES flag these three lines,
    // and the allowlist — not a blind spot — is what lets them through. A stale entry
    // (fallback removed) or an unlisted extra (fallback added) both fail here.
    const found: string[] = [];
    for (const rel of ROOT_CONFIG_FILES) {
      for (const hit of findSecretFallbacks(readFileSync(resolve(ROOT, rel), "utf8"))) {
        found.push(`${rel} ${hit.name}`);
      }
    }
    const expected = TEST_CLUSTER_FALLBACK_ALLOWLIST.map((e) => `${e.file} ${e.name}`);
    expect(found.sort()).toEqual([...expected].sort());
    for (const entry of TEST_CLUSTER_FALLBACK_ALLOWLIST) {
      expect(entry.why.length, `allowlist entry ${entry.file} ${entry.name} must say why it exists`).toBeGreaterThan(20);
    }
  });

  it("the detector recognises the shapes it claims to (self-check)", () => {
    const sample = [
      'const a = process.env.FOO_SECRET || "x";',
      "const b = process.env.BAR_TOKEN ??\n  'y';",
      'const c = process.env["BAZ_PASSWORD"] || `z`;',
      'const ok1 = process.env.LOG_LEVEL || "info";',
      "const ok2 = process.env.JWT_SECRET;",
    ].join("\n");
    expect(findSecretFallbacks(sample).map((h) => h.name)).toEqual(["FOO_SECRET", "BAR_TOKEN", "BAZ_PASSWORD"]);
  });
});

describe("REQ-M-SEC-019 — deploy-matter.ts mounts every secret the API requires", () => {
  it("every name in REQUIRED_RUNTIME_SECRETS appears in the secretsFlag array of scripts/deploy-matter.ts", () => {
    const source = readFileSync(resolve(ROOT, "scripts/deploy-matter.ts"), "utf8");
    const match = source.match(/const secretsFlag = \[([\s\S]*?)\]\.join\(/);
    expect(match, "scripts/deploy-matter.ts must define `const secretsFlag = [ ... ].join(`").not.toBeNull();
    const block = match![1]!;
    const missing = REQUIRED_RUNTIME_SECRETS.filter((name) => !block.includes(`${name}=`));
    expect(
      missing,
      `deploy-matter.ts --set-secrets does not mount: ${missing.join(", ")}. The API refuses to boot without them.`,
    ).toEqual([]);
  });

  it("scripts/deploy-matter.ts never deletes, destroys or disables a Secret Manager secret (D73)", () => {
    // Retiring the static MCP token of an existing matter is a manual, reviewed step
    // (docs/PLAN-MCP-AUTH.md section 6, step 7); the deploy script only ever adds versions.
    const source = readFileSync(resolve(ROOT, "scripts/deploy-matter.ts"), "utf8");
    const hits = source
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /secrets\s+(delete|versions\s+(destroy|disable))/i.test(line));
    expect(hits.map((h) => `${h.n}: ${h.line.trim()}`)).toEqual([]);
  });

  it("every name in REQUIRED_RUNTIME_SETTINGS appears in the envVarsFlag array of scripts/deploy-matter.ts", () => {
    const source = readFileSync(resolve(ROOT, "scripts/deploy-matter.ts"), "utf8");
    const match = source.match(/const envVarsFlag = \[([\s\S]*?)\]\.join\(/);
    expect(match, "scripts/deploy-matter.ts must define `const envVarsFlag = [ ... ].join(`").not.toBeNull();
    const missing = REQUIRED_RUNTIME_SETTINGS.filter((name) => !match![1]!.includes(`${name}=`));
    expect(
      missing,
      `deploy-matter.ts --set-env-vars does not set: ${missing.join(", ")}. The API refuses to boot without them.`,
    ).toEqual([]);
  });
});

describe("REQ-M-SEC-018 — the API refuses to boot without each required runtime secret", () => {
  const TSX_CLI = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
  const SERVER = resolve(ROOT, "apps/api/src/server.ts");

  // A complete, syntactically valid environment. Values are dummies: the boot gate runs
  // before anything connects, and PORT=0 keeps a (wrongly) surviving server off real ports.
  const COMPLETE_ENV: Record<string, string> = {
    DATABASE_URL: "postgres://casefile_app:not-a-real-password@127.0.0.1:1/casefile_test",
    SUPABASE_URL: "https://example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "pk_test_not_a_real_key",
    JWT_SECRET: "test_jwt_secret_at_least_32_bytes_long_000",
    MCP_PUBLIC_URL: "https://mcp.casefile.test/mcp",
    PORT: "0",
    HOST: "127.0.0.1",
    NODE_ENV: "production",
  };

  function bootWithout(name: string, overrides: Record<string, string> = {}): { status: number | null; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, ...COMPLETE_ENV, ...overrides };
    if (name !== "") delete env[name];
    delete env.VITEST;
    const res = spawnSync(process.execPath, [TSX_CLI, SERVER], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 25_000,
      windowsHide: true,
    });
    return { status: res.status, stderr: `${res.stderr ?? ""}${res.error ? `\n${res.error.message}` : ""}` };
  }

  function expectRefusal(name: string, res: { status: number | null; stderr: string }): void {
    expect(res.status, `server.ts must exit non-zero without ${name} (null = still running when killed)\n${res.stderr}`).not.toBeNull();
    expect(res.status, `server.ts must exit non-zero without ${name}\n${res.stderr}`).not.toBe(0);
    expect(res.stderr, `stderr must name the missing variable ${name}`).toContain(name);
  }

  it("refuses to boot without DATABASE_URL", () => {
    expect(REQUIRED_RUNTIME_SECRETS).toContain("DATABASE_URL");
    expectRefusal("DATABASE_URL", bootWithout("DATABASE_URL"));
  });

  it("refuses to boot without SUPABASE_URL", () => {
    expect(REQUIRED_RUNTIME_SECRETS).toContain("SUPABASE_URL");
    expectRefusal("SUPABASE_URL", bootWithout("SUPABASE_URL"));
  });

  it("refuses to boot without SUPABASE_PUBLISHABLE_KEY", () => {
    expect(REQUIRED_RUNTIME_SECRETS).toContain("SUPABASE_PUBLISHABLE_KEY");
    expectRefusal("SUPABASE_PUBLISHABLE_KEY", bootWithout("SUPABASE_PUBLISHABLE_KEY"));
  });

  it("refuses to boot without JWT_SECRET", () => {
    expect(REQUIRED_RUNTIME_SECRETS).toContain("JWT_SECRET");
    expectRefusal("JWT_SECRET", bootWithout("JWT_SECRET"));
  });

  it("refuses to boot without MCP_PUBLIC_URL (D69)", () => {
    expect(REQUIRED_RUNTIME_SETTINGS).toContain("MCP_PUBLIC_URL");
    expectRefusal("MCP_PUBLIC_URL", bootWithout("MCP_PUBLIC_URL"));
  });

  it("refuses to boot with an MCP_PUBLIC_URL that is not canonical HTTPS (D69)", () => {
    for (const bad of ["http://mcp.casefile.test/mcp", "https://mcp.casefile.test/mcp/", "https://MCP.casefile.test/mcp"]) {
      const res = bootWithout("", { MCP_PUBLIC_URL: bad });
      expectRefusal("MCP_PUBLIC_URL", res);
    }
  });
});
