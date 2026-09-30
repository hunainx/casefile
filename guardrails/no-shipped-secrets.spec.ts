/**
 * GUARDRAIL: no-shipped-secrets
 *
 * Ensures the template repository does not ship with credentials, live infrastructure
 * identifiers, or the names of real people and matters:
 * 1. No .env file exists at the repository root or in packages/apps.
 * 2. No scanned file contains a denylisted Supabase project ref or the live GCP project id.
 * 3. No scanned file contains a *.run.app URL (placeholder or live).
 * 4. No scanned file contains a postgres:// or postgresql:// connection string with a
 *    literal password. Placeholders (<...>), interpolations ($VAR / ${...}), redactions
 *    (***) and loopback hosts (the local Docker stack) are not passwords.
 * 5. No scanned file contains a denylisted real person or matter name, or a string
 *    lifted from a real case document.
 * 5a. No scanned file contains a database password known to have leaked, in any form.
 * 6. No scanned file or root env template contains a JWT-shaped token (/^eyJhbGciOi/).
 * 7. No scanned file names a denylisted real Cloud Storage bucket (FINAL).
 * 8. No scanned file holds a credential in a format gitleaks' default rules miss: a Supabase access token
 *    (sbp_), a Supabase secret key, Google, GitHub, Anthropic, OpenAI, AWS, Slack or Stripe keys, a private key,
 *    a service-account JSON, a minted Casefile MCP token (CLEANUP; the same rules are in .gitleaks.toml).
 *
 * "Scanned" means every tracked file plus every untracked file git does not ignore, plus
 * any .env* file on disk. There are no whole-file exceptions (docs/PRD.md and
 * traceability/requirements.yaml were scanned-exempt until decision D63), and
 * SCOPED_EXCEPTIONS is empty (CLEANUP removed the last one; the mechanism stays for a future, justified case). Files containing NUL
 * bytes are binary and are not scanned as text.
 *
 * The denylist lives in guardrails/sensitive-denylist.ts as SHA-256 hashes so that this
 * guardrail does not itself publish the names it keeps out.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  DENYLIST,
  findDenylistHits,
  findPostgresPasswordHits,
  findRunAppHits,
  findKeyFormatHits,
  KEY_FORMATS,
  normaliseWords,
  sha256,
  type DenylistKind,
} from "./sensitive-denylist.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Narrow, per-file exceptions for a single denylist entry. Each one names why the
 * string cannot be removed from that file.
 */
interface ScopedException {
  file: string;
  sha256: string;
  reason: string;
  /** If set, the exception applies only between a line matching `start` and one matching `end`. */
  region?: { start: RegExp; end: RegExp };
}
const SCOPED_EXCEPTIONS: ScopedException[] = [];

function getScannedFiles(): string[] {
  let listed: string[];
  try {
    const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    listed = stdout.split(/\r?\n/).map((f) => f.trim()).filter((f) => f.length > 0);
  } catch {
    listed = [];
  }
  for (const envFile of readdirSync(ROOT)) {
    if (envFile.startsWith(".env")) listed.push(envFile);
  }
  return [...new Set(listed.map((f) => f.replace(/\\/g, "/")))]
    .filter((f) => {
      const full = resolve(ROOT, f);
      return existsSync(full) && statSync(full).isFile();
    });
}

function readText(rel: string): string | null {
  const buf = readFileSync(resolve(ROOT, rel));
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

function lineIsInRegion(content: string, line: number, region: { start: RegExp; end: RegExp }): boolean {
  const lines = content.split(/\r?\n/);
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inside && region.start.test(lines[i]!)) inside = true;
    if (i + 1 === line) return inside;
    if (inside && region.end.test(lines[i]!)) inside = false;
  }
  return false;
}

function denylistViolations(kinds: DenylistKind[]): string[] {
  const entries = DENYLIST.filter((e) => kinds.includes(e.kind));
  const violations: string[] = [];
  for (const rel of getScannedFiles()) {
    const content = readText(rel);
    if (content === null) continue;
    for (const hit of findDenylistHits(content, entries)) {
      const excused = SCOPED_EXCEPTIONS.some(
        (x) => x.file === rel && x.sha256 === hit.sha256 && (!x.region || lineIsInRegion(content, hit.line, x.region)),
      );
      if (excused) continue;
      violations.push(`${rel}:${hit.line}: ${hit.kind} [sha256 ${hit.sha256.slice(0, 12)}]: ${hit.text}`);
    }
  }
  return violations;
}

describe("GUARDRAIL: no-shipped-secrets — template credential & secret hygiene", () => {
  it("no .env file exists anywhere in the repository root or packages/apps", () => {
    const violations: string[] = [];

    const rootEnv = resolve(ROOT, ".env");
    if (existsSync(rootEnv)) {
      violations.push(".env (at repository root)");
    }

    function checkDir(dir: string) {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".turbo" || entry.name === ".git") continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(full);
        } else if (entry.name === ".env") {
          violations.push(relative(ROOT, full).replace(/\\/g, "/"));
        }
      }
    }

    checkDir(ROOT);

    expect(
      violations,
      `Shipped .env file found! The template must never ship with a .env file.\n` +
        `Delete .env and use .env.example / .env.local.example instead.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("no scanned file contains a denylisted Supabase project ref or GCP project id", () => {
    const violations = denylistViolations(["supabase-project-ref", "gcp-project-id"]);
    expect(
      violations,
      `Live Supabase project refs or GCP project ids found. Replace with <SUPABASE_PROJECT_REF> / <GCP_PROJECT_ID>.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("no scanned file contains a *.run.app URL", () => {
    const violations: string[] = [];
    for (const rel of getScannedFiles()) {
      const content = readText(rel);
      if (content === null) continue;
      for (const hit of findRunAppHits(content)) violations.push(`${rel}:${hit.line}: ${hit.text}`);
    }
    expect(
      violations,
      `Cloud Run URLs found. Use <CASEFILE_API_URL> or read CASEFILE_API_URL from the environment.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("no scanned file contains a postgres(ql):// connection string with a literal password", () => {
    const violations: string[] = [];
    for (const rel of getScannedFiles()) {
      const content = readText(rel);
      if (content === null) continue;
      for (const hit of findPostgresPasswordHits(content)) violations.push(`${rel}:${hit.line}: ${hit.text}`);
    }
    expect(
      violations,
      `Connection strings with embedded passwords found. Use <PASSWORD> placeholders or environment variables.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("the key-format detector catches a fake credential of every format, and never prints it", () => {
    // Built at run time so this file holds no literal credential of any format.
    const hex40 = "0123456789abcdef".repeat(3).slice(0, 40);
    const alnum40 = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7dEf0h";
    const fakes: Record<string, string> = {
      "supabase-access-token": "sbp" + "_" + hex40,
      "supabase-secret-key": "sb" + "_secret_" + alnum40,
      "google-api-key": "AI" + "za" + alnum40.slice(0, 35),
      "google-oauth-access-token": "ya" + "29." + alnum40,
      "private-key": "-----BEGIN " + "PRIVATE KEY-----",
      "google-service-account-json": '{ "type"' + ': "service' + '_account" }',
      "github-token": "gh" + "p_" + alnum40,
      "anthropic-api-key": "sk-" + "ant-" + alnum40,
      "openai-api-key": "sk-" + alnum40,
      "aws-access-key-id": "AK" + "IA" + "ABCDEFGHIJKLMNOP",
      "slack-token": "xo" + "xb-" + "1234567890-abcdef",
      "stripe-live-key": "sk" + "_live_" + alnum40,
      "casefile-mcp-token": "mcp" + "_sec_" + alnum40,
    };
    expect(Object.keys(fakes).sort()).toEqual(KEY_FORMATS.map((k) => k.kind).sort());
    for (const [kind, value] of Object.entries(fakes)) {
      const hits = findKeyFormatHits(`const x = "${value}";`);
      expect(hits.map((h) => h.kind), kind).toContain(kind);
      for (const h of hits) expect(h.redacted.length < value.length || value.length <= 6, kind).toBe(true);
      for (const h of hits) if (value.length > 12) expect(h.redacted).not.toContain(value);
    }
    // Test values and placeholders used in this repository are not credentials.
    for (const ok of ["sbp_fakefakefakefakefake0000", "mcp_sec_wrong_invalid_secret_token_123", "<SUPABASE_ACCESS_TOKEN>", "process.env.SUPABASE_ACCESS_TOKEN"]) {
      expect(findKeyFormatHits(ok), ok).toEqual([]);
    }
  });

  it("no scanned file holds a credential in a format gitleaks' default rules miss", () => {
    const violations: string[] = [];
    for (const rel of getScannedFiles()) {
      const content = readText(rel);
      if (content === null) continue;
      for (const hit of findKeyFormatHits(content)) violations.push(`${rel}:${hit.line}: ${hit.kind}: ${hit.redacted}`);
    }
    expect(
      violations,
      `Credentials found. Remove them, read them from the environment, and revoke them at their source.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("no scanned file names a denylisted real Cloud Storage bucket", () => {
    const violations = denylistViolations(["real-bucket"]);
    expect(
      violations,
      `Real bucket names found. Use a placeholder (casefile-<matter>-sources) or the local test buckets.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("no scanned file contains a denylisted real person or matter name, or a real case-document string", () => {
    const violations = denylistViolations(["real-name", "real-case-string"]);
    expect(
      violations,
      `Real person or matter names found. Replace with fictional placeholders (Jane Doe, Acme Holdings).\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("no scanned file contains a known leaked database password", () => {
    const violations = denylistViolations(["leaked-password"]);
    expect(
      violations,
      `Leaked database passwords found. Remove them and rotate the credential if it is still live.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("the detectors recognise what they claim to (self-check)", () => {
    // Synthetic denylist entry so the self-check never needs a real name in plaintext.
    const synthetic = [{ kind: "real-name" as const, words: 2, sha256: sha256(normaliseWords("Widget Baron").join(" ")) }];
    expect(findDenylistHits("contact: widget baron", synthetic)).toHaveLength(1);
    expect(findDenylistHits("const WIDGET_BARON_REF = 1;", synthetic)).toHaveLength(1);
    expect(findDenylistHits("const widgetBaronRef = 1;", synthetic)).toHaveLength(1);
    expect(findDenylistHits("widget and baron", synthetic)).toHaveLength(0);

    const runApp = "https://svc-abc123-uc.a" + ".run" + ".app/health";
    expect(findRunAppHits(`url = ${runApp}`)).toHaveLength(1);
    expect(findRunAppHits("https://api.example.com")).toHaveLength(0);

    const scheme = "postgres" + "ql://";
    expect(findPostgresPasswordHits(`${scheme}app.ref:hunter2@db.example.com:5432/postgres`)).toHaveLength(1);
    expect(findPostgresPasswordHits(`${scheme}app.ref:<PASSWORD>@db.example.com:5432/postgres`)).toHaveLength(0);
    expect(findPostgresPasswordHits(`${scheme}app.ref:\${pw}@db.example.com:5432/postgres`)).toHaveLength(0);
    expect(findPostgresPasswordHits(`${scheme}app:app@127.0.0.1:55432/casefile_test`)).toHaveLength(0);
    expect(findPostgresPasswordHits(`${scheme}app@db.example.com/postgres`)).toHaveLength(0);
  });

  it("no scanned file or template contains a live JWT token matching /^eyJhbGciOi/", () => {
    const JWT_PATTERN = /eyJhbGciOi[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/;
    const violations: string[] = [];

    for (const rel of getScannedFiles()) {
      if (rel === "guardrails/no-shipped-secrets.spec.ts") continue;
      const content = readText(rel);
      if (content === null) continue;
      const match = content.match(JWT_PATTERN);
      if (match) {
        violations.push(`${rel}: contains JWT-shaped token starting with '${match[0].slice(0, 20)}...'`);
      }
    }

    expect(
      violations,
      `Files contain JWT-shaped tokens matching /^eyJhbGciOi/.\n` +
        violations.map((v) => `  ✖ ${v}`).join("\n"),
    ).toEqual([]);
  });
});
