import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { completeSetupLink } from "./helpers/setup-link.js";
import { claudeCodeCimdTransport, mcpPost, signInForMcp, MCP_RESOURCE, type McpPerson } from "./helpers/mcp-oauth.js";

/**
 * Phase 4 close, section A (DEV-030, D87): `pnpm admin:add-user` gives a colleague an account on
 * the matter. It runs the real command, then follows the printed link the way the person would:
 * setup page (password + TOTP), OAuth sign-in, /mcp with the role they were given.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX = resolve(REPO, "node_modules/tsx/dist/cli.mjs");

describe("DEV-030: pnpm admin:add-user", () => {
  let app: ReturnType<typeof buildApp>;
  let sql: postgres.Sql;
  let envFile: string;
  const T = randomUUID();
  const WS = randomUUID();
  const INV = randomUUID();
  const savedEnv: Record<string, string | undefined> = {};
  const password = "New-Colleague-Password-2026!";

  const addUser = (args: string[]) => {
    const r = spawnSync(process.execPath, [TSX, "scripts/admin-add-user.ts", "--env", envFile, "--issued-by", "test-admin", ...args], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env },
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
  };
  const tokenFrom = (stdout: string) => /\/account\/setup#token=([0-9a-f]{64})\s*$/m.exec(stdout)?.[1];
  const rowsFor = (email: string) =>
    withTenant(T, async (tx) => ({
      users: await tx<{ id: string; name: string; status: string }[]>`SELECT id, name, status FROM users WHERE tenant_id = ${T} AND lower(email) = ${email.toLowerCase()}`,
      creds: await tx<{ user_id: string }[]>`SELECT c.user_id FROM auth_credentials c JOIN users u ON u.id = c.user_id WHERE u.tenant_id = ${T} AND lower(u.email) = ${email.toLowerCase()}`,
      members: await tx<{ role: string; workspace_id: string }[]>`SELECT m.role, m.workspace_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.tenant_id = ${T} AND lower(u.email) = ${email.toLowerCase()}`,
      links: await tx<{ id: string }[]>`SELECT t.id FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.tenant_id = ${T} AND lower(u.email) = ${email.toLowerCase()}`,
    }), sql);

  beforeAll(async () => {
    for (const k of ["MATTER_TENANT_ID", "MATTER_INVESTIGATION_ID"]) savedEnv[k] = process.env[k];
    process.env.MATTER_TENANT_ID = T;
    process.env.MATTER_INVESTIGATION_ID = INV;
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql, oauth: { cimdTransport: claudeCodeCimdTransport } });
    await app.ready();
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Add-user Matter')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Add-user WS')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, stage) VALUES (${INV}, ${T}, ${WS}, 'Add-user Investigation', 'collecting')`;
    }, sql);
    envFile = join(mkdtempSync(join(tmpdir(), "casefile-add-user-")), ".env.addusertest");
    writeFileSync(envFile, [
      `DATABASE_URL=${getDbUrl()}`,
      `MATTER_TENANT_ID=${T}`,
      `MATTER_INVESTIGATION_ID=${INV}`,
      `MCP_PUBLIC_URL=${MCP_RESOURCE}`,
    ].join("\n") + "\n");
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a new investigator: account with no password and no TOTP, workspace role, audit row, setup link; then setup, sign-in and /mcp with that role", async () => {
    const email = `new-investigator-${randomUUID().slice(0, 8)}@casefile.test`;
    const r = addUser(["--email", email, "--name", "New Investigator", "--role", "investigator"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain(`Added ${email} to the matter as investigator.`);
    const token = tokenFrom(r.stdout);
    expect(token, r.stdout).toBeDefined();
    expect(r.stdout).toContain(`https://mcp.casefile.test/account/setup#token=${token}`);

    const rows = await rowsFor(email);
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0]).toMatchObject({ name: "New Investigator", status: "active" });
    expect(rows.creds, "no password and no TOTP until the person completes the link").toEqual([]);
    expect(rows.members).toEqual([{ role: "investigator", workspace_id: WS }]);
    const userId = rows.users[0]!.id;
    const [audit] = await withTenant(T, (tx) => tx<{ actor_id: string; actor_display: string; after: unknown; workspace_id: string }[]>`
      SELECT actor_id, actor_display, after, workspace_id FROM audit_events
      WHERE tenant_id = ${T} AND action = 'user.create' AND object_id = ${userId}`, sql);
    expect(audit?.actor_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(audit?.actor_display).toBe("Admin CLI (test-admin)");
    expect(audit?.workspace_id).toBe(WS);
    const after = typeof audit?.after === "string" ? JSON.parse(audit.after) : audit?.after;
    expect(after).toMatchObject({ email, role: "investigator", workspace_id: WS, password_set: false, totp_enrolled: false });

    // Before the link is used the account cannot sign in: there is no password.
    const early = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId: T } });
    expect(early.statusCode).toBe(401);

    const { secret } = await completeSetupLink(app, { tenantId: T, token: token!, password });
    const person: McpPerson = { id: userId, email, password, secret, tenantId: T };
    const signIn = await signInForMcp(app, person);
    expect(signIn.tokens, signIn.body).toBeDefined();
    const list = await mcpPost(app, signIn.tokens!.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = JSON.parse(list.body).result.tools.map((t: { name: string }) => t.name).sort();
    expect(tools).toHaveLength(8);
    expect(tools).not.toContain("get_download_link");
    const status = await mcpPost(app, signIn.tokens!.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "matter_status", arguments: {} } });
    expect(JSON.parse(JSON.parse(status.body).result.content[0].text).investigation.id).toBe(INV);
  });

  it("a viewer gets an account and a working setup link, but cannot connect Claude", async () => {
    const email = `new-viewer-${randomUUID().slice(0, 8)}@casefile.test`;
    const r = addUser(["--email", email, "--name", "New Viewer", "--role", "viewer"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const token = tokenFrom(r.stdout);
    expect(token, r.stdout).toBeDefined();
    const [row] = (await rowsFor(email)).users;
    const { secret } = await completeSetupLink(app, { tenantId: T, token: token!, password });
    const signIn = await signInForMcp(app, { id: row!.id, email, password, secret, tenantId: T });
    expect(signIn.tokens).toBeUndefined();
    expect(signIn.body).toMatch(/Claude cannot be connected/);
    expect(signIn.body).toMatch(/viewer/);
  });

  it("an email that already exists in the tenant is refused, in any letter case; nothing is created or issued", async () => {
    const email = `taken-${randomUUID().slice(0, 8)}@casefile.test`;
    expect(addUser(["--email", email, "--name", "First", "--role", "analyst"]).status).toBe(0);
    const before = await rowsFor(email);
    for (const again of [email, email.toUpperCase()]) {
      const r = addUser(["--email", again, "--name", "Second", "--role", "ws_admin"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/already has an account/);
      expect(r.stdout).not.toMatch(/account\/setup#token=/);
    }
    const after = await rowsFor(email);
    expect(after.users).toEqual(before.users);
    expect(after.members).toEqual([{ role: "analyst", workspace_id: WS }]);
    expect(after.links).toHaveLength(before.links.length);
  });

  it("a role that is not in the policy matrix is refused and nothing is created", async () => {
    for (const role of ["admin", "lead_investigator", "superuser", ""]) {
      const email = `bad-role-${randomUUID().slice(0, 8)}@casefile.test`;
      const r = addUser(["--email", email, "--name", "Bad Role", "--role", role]);
      expect(r.status, `role "${role}"`).not.toBe(0);
      expect(r.stderr).toMatch(role ? /is not a role/ : /Usage/);
      expect((await rowsFor(email)).users).toEqual([]);
    }
  });
});
