/**
 * `pnpm matter:preflight` only reads (D83).
 *
 * The preflight runs against live matters before they are upgraded, so it must not change
 * anything: no INSERT, UPDATE, DELETE or DDL, no gcloud command, no web call.
 *
 *   1. Static: scripts/matter-preflight.ts has no write statement, no child_process, no fetch,
 *      and opens every transaction READ ONLY.
 *   2. Dynamic: a real run against the local test database, with every statement the
 *      database driver sends recorded and child_process / fetch replaced by spies. Nothing but
 *      reads is sent, no command runs, and the report is right for the fake matter.
 *   3. The mechanism is real: a READ ONLY transaction of the same kind refuses a write.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const sent = vi.hoisted(() => ({ statements: [] as string[], commands: [] as string[] }));

vi.mock("postgres", async (importOriginal) => {
  const mod = await importOriginal<{ default: (url: string, opts?: Record<string, unknown>) => unknown }>();
  const real = mod.default;
  const recording = (url: string, opts: Record<string, unknown> = {}) =>
    real(url, { ...opts, debug: (_conn: number, query: string) => sent.statements.push(query) });
  return { ...mod, default: recording };
});

vi.mock("node:child_process", () => {
  const refuse = (name: string) => (...args: unknown[]) => {
    sent.commands.push(`${name} ${String(args[0])}`);
    throw new Error(`child_process.${name} must not be called by the preflight`);
  };
  return {
    execSync: refuse("execSync"),
    exec: refuse("exec"),
    execFile: refuse("execFile"),
    execFileSync: refuse("execFileSync"),
    spawn: refuse("spawn"),
    spawnSync: refuse("spawnSync"),
    fork: refuse("fork"),
  };
});

const { createDbClient, getDbUrl, withTenant } = await import("@casefile/db");
const { runPreflight, formatReport, UPGRADE_MIGRATIONS } = await import("../scripts/matter-preflight.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = "scripts/matter-preflight.ts";

/** Statements that change something. Matched against code with comments removed. */
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|REFRESH|LOCK|CALL|COMMENT ON|SECURITY LABEL|NOTIFY|nextval|setval|pg_advisory)\b/;

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("matter:preflight — static: the source can only read", () => {
  const code = codeOnly(readFileSync(resolve(ROOT, PREFLIGHT), "utf8"));

  it("contains no write statement", () => {
    const hits = code.split(/\r?\n/).map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => WRITE_WORDS.test(l));
    expect(hits.map((h) => `${h.n}: ${h.l.trim()}`)).toEqual([]);
  });

  it("runs no command and calls no web service", () => {
    // A gcloud command is a string that starts with it (the report's heading only mentions it).
    expect(code).not.toMatch(/child_process|execSync|spawn\(|execFile|\bfetch\(|[`'"]\s*gcloud|\.unsafe\(/);
  });

  it("opens every transaction READ ONLY", () => {
    const begins = [...code.matchAll(/\.begin\(([^,)]*)/g)].map((m) => m[1]!.trim());
    expect(begins.length, "the preflight must use a transaction").toBeGreaterThan(0);
    expect(begins.filter((b) => b !== `"read only"`)).toEqual([]);
  });
});

describe("matter:preflight — dynamic: a real run sends only reads", () => {
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  const OTHER_INV = randomUUID();
  let sql: ReturnType<typeof createDbClient>;
  let dir: string;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  const person = (email: string, status = "active") => ({ id: randomUUID(), email: `${email}-${T.slice(0, 8)}@preflight.test`, status });
  const lead = person("lead");
  const analyst = person("analyst");
  const viewer = person("viewer");
  const suspended = person("suspended", "suspended");
  const outsider = person("outsider");
  const walled = person("walled");

  function envFile(name: string, extra: Record<string, string>): string {
    const file = join(dir, name);
    const lines = { DATABASE_URL: getDbUrl(), MATTER_TENANT_ID: T, MATTER_INVESTIGATION_ID: INV, ...extra };
    writeFileSync(file, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    return file;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "casefile-preflight-"));
    sql = createDbClient(getDbUrl(), { max: 2 });
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Preflight Fake Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Preflight WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, stage) VALUES (${INV}, ${T}, ${WS}, 'Preflight Investigation', 'collecting')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, stage) VALUES (${OTHER_INV}, ${T}, ${WS}, 'Other', 'collecting')`;
      for (const p of [lead, analyst, viewer, suspended, outsider, walled]) {
        await tx`INSERT INTO users (id, tenant_id, email, name, status) VALUES (${p.id}, ${T}, ${p.email}, ${p.email}, ${p.status})`;
      }
      // Fake hashes and a fake TOTP secret: the preflight only looks at whether they are set.
      await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash, totp_secret, totp_enabled) VALUES (${lead.id}, ${T}, 'fake-hash', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', true)`;
      await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash) VALUES (${analyst.id}, ${T}, 'fake-hash')`;
      for (const [p, role] of [[lead, "admin"], [analyst, "investigator"], [viewer, "viewer"], [suspended, "investigator"], [walled, "investigator"]] as const) {
        await tx`INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role) VALUES (${randomUUID()}, ${T}, ${WS}, ${p.id}, ${role})`;
      }
      await tx`INSERT INTO investigation_members (id, tenant_id, investigation_id, user_id, role) VALUES (${randomUUID()}, ${T}, ${INV}, ${lead.id}, 'lead_investigator')`;
      await tx`INSERT INTO ethical_walls (id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason) VALUES (${randomUUID()}, ${T}, ${WS}, 'user', ${walled.id}, ${INV}, 'conflict')`;
    }, sql);
  });

  afterAll(async () => {
    await sql.end();
    fetchSpy.mockRestore();
  });

  it("reports the fake matter correctly and sends nothing but reads", async () => {
    const file = envFile("ready.env", { MCP_PUBLIC_URL: "https://mcp.casefile.test/mcp" });
    sent.statements.length = 0;
    sent.commands.length = 0;
    const report = await runPreflight(file);
    const out = formatReport(report);

    const writes = sent.statements.filter((s) => WRITE_WORDS.test(codeOnly(s)));
    expect(sent.statements.length, "the run must have queried the database").toBeGreaterThan(5);
    expect(writes).toEqual([]);
    expect(sent.commands).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(report.readOnlyConfirmed).toBe(true);
    expect(report.migrations.missing).toEqual([]);
    for (const f of UPGRADE_MIGRATIONS) expect(out).toContain(`${f}: applied`);
    const claude = Object.fromEntries(report.users.map((u) => [u.email, u.claude]));
    expect(claude).toEqual({
      [lead.email]: "yes",
      [analyst.email]: "after-setup-link",
      [viewer.email]: "no",
      [suspended.email]: "no",
      [outsider.email]: "no",
      [walled.email]: "no",
    });
    expect(out).toMatch(/Canonical: yes/);
    expect(out).toMatch(/RESULT: READY/);
    expect(out).not.toContain(getDbUrl().replace(/^.*:\/\/[^:]+:([^@]+)@.*$/, "$1@"));
  });

  it("says NOT READY, with the reason, when MCP_PUBLIC_URL is missing or not canonical", async () => {
    const missing = formatReport(await runPreflight(envFile("no-url.env", {})));
    expect(missing).toMatch(/RESULT: NOT READY\n {2}- MCP_PUBLIC_URL is not set/);
    const slash = formatReport(await runPreflight(envFile("slash.env", { MCP_PUBLIC_URL: "https://mcp.casefile.test/mcp/" })));
    expect(slash).toMatch(/Canonical: NO/);
    expect(slash).toMatch(/RESULT: NOT READY/);
    expect(sent.commands).toEqual([]);
  });

  it("DEV-039: every migration added after the version before MCP sign-in (0025 and later) is on the upgrade list, so a new one cannot be missed", () => {
    const later = readdirSync(resolve(ROOT, "packages/db/migrations"))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) >= 25)
      .sort();
    expect([...UPGRADE_MIGRATIONS].sort()).toEqual(later);
    expect(later.length).toBeGreaterThanOrEqual(7);
    expect(later).toEqual(expect.arrayContaining(["0029_ingest_triage.sql", "0030_mailbox_message_identity.sql", "0031_ingest_work_queue.sql"]));
  });

  it("the mechanism is real: a READ ONLY transaction refuses a write", async () => {
    const err = await sql
      .begin("read only", (tx) => tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${randomUUID()}, ${randomUUID()}, 'must fail')`)
      .then(() => null, (e: { code?: string; message?: string }) => e);
    expect(err?.code, String(err?.message)).toBe("25006");
    expect(err?.message).toMatch(/read-only transaction/);
  });
});
