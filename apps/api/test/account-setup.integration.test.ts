import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildApp } from "../src/app.js";
import { createDbClient, getDbUrl, withTenant } from "@casefile/db";
import { AuthService } from "../src/auth/service.js";
import { generateTotp, hashPassword } from "../src/auth/crypto.js";
import { nextTotpCode } from "./helpers/totp.js";

/**
 * The admin-issued one-time link (D71): the only way to set a first password AND enrol TOTP.
 * Enrolment counts only after a valid code; a new link replaces the authenticator; every issue
 * and use is audited; the token never reaches a request log.
 */
describe("apps/api — one-time account setup link (Phase 2A, D71)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  const logLines: string[] = [];
  const T = randomUUID();
  const userId = randomUUID();
  const email = `setup-${randomUUID().slice(0, 8)}@casefile.test`;
  const savedTenant = process.env.MATTER_TENANT_ID;

  async function issue(): Promise<string> {
    const res = await withTenant(T, (tx) => AuthService.issuePasswordResetToken(tx, { tenantId: T, email, issuedBy: "test-admin", requestId: `test-${randomUUID()}` }), sql);
    return res.token;
  }

  async function open() {
    const page = await app.inject({ method: "GET", url: "/account/setup" });
    const cookie = /__Host-cf_csrf=([^;]+)/.exec(String(page.headers["set-cookie"]))![1]!;
    return { page, cookie, headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-cf_csrf=${cookie}` } };
  }

  async function start(token: string) {
    const o = await open();
    const res = await app.inject({ method: "POST", url: "/account/setup", headers: o.headers, payload: new URLSearchParams({ action: "start", csrf: o.cookie, token }).toString() });
    const secret = /<dd class="mono">([A-Z2-7]{16,})<\/dd>/.exec(res.body)?.[1];
    const flow = /name="flow" value="([^"]+)"/.exec(res.body)?.[1];
    return { ...o, res, secret: secret!, flow: flow! };
  }

  async function complete(s: Awaited<ReturnType<typeof start>>, token: string, fields: { password?: string; confirm?: string; code?: string }) {
    const password = fields.password ?? "A-New-Long-Password-2026";
    // Enrolment records the code's time step (D75); later sign-ins in a test use later steps.
    const code = fields.code ?? (await nextTotpCode(s.secret));
    return app.inject({
      method: "POST",
      url: "/account/setup",
      headers: s.headers,
      payload: new URLSearchParams({
        action: "complete",
        csrf: s.cookie,
        token,
        flow: s.flow,
        password,
        confirm: fields.confirm ?? password,
        code,
      }).toString(),
    });
  }

  /** audit_events.after comes back as JSON text. */
  const parsed = (after: unknown): Record<string, unknown> => (typeof after === "string" ? JSON.parse(after) : (after as Record<string, unknown>));

  const creds = () => withTenant(T, (tx) => tx<{ totp_enabled: boolean; totp_secret: string | null }[]>`
    SELECT totp_enabled, totp_secret FROM auth_credentials WHERE user_id = ${userId}`, sql).then((r) => r[0]!);

  beforeAll(async () => {
    process.env.MATTER_TENANT_ID = T;
    sql = createDbClient(getDbUrl());
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(...String(chunk).split("\n").filter((l) => l.trim() !== ""));
        cb();
      },
    });
    app = buildApp({ db: sql, logger: { stream } });
    await app.ready();
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Setup Matter')`;
      await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${userId}, ${T}, ${email}, 'New Colleague')`;
      await tx`INSERT INTO auth_credentials (user_id, tenant_id, password_hash) VALUES (${userId}, ${T}, ${await hashPassword("bootstrap-random-password")})`;
    }, sql);
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
    if (savedTenant === undefined) delete process.env.MATTER_TENANT_ID;
    else process.env.MATTER_TENANT_ID = savedTenant;
  });

  it("the page reads the token from the URL fragment with an inline, nonce-allowed script and nothing external", async () => {
    const { page } = await open();
    expect(page.statusCode).toBe(200);
    const csp = String(page.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    expect(page.body).toContain("location.hash");
    expect(page.body).toContain("history.replaceState");
    expect(page.body).not.toMatch(/<script[^>]+src=|<link|https?:\/\//);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(page.headers["cache-control"]).toBe("no-store");
  });

  it("shows the secret and otpauth URI, but enrols nothing until a valid code is entered", async () => {
    const token = await issue();
    const s = await start(token);
    expect(s.res.statusCode, s.res.body).toBe(200);
    expect(s.res.body).toContain(`otpauth://totp/Casefile%3A${encodeURIComponent(email)}?secret=${s.secret}&amp;issuer=Casefile`);
    expect((await creds()).totp_enabled).toBe(false);

    const wrong = await complete(s, token, { code: generateTotp(s.secret) === "123456" ? "654321" : "123456" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toMatch(/does not match/);
    const short = await complete(s, token, { password: "short" });
    expect(short.statusCode).toBe(400);
    const mismatch = await complete(s, token, { confirm: "A-Different-Long-Password" });
    expect(mismatch.statusCode).toBe(400);
    expect((await creds()).totp_enabled, "nothing counts before a valid code").toBe(false);

    const unused = await withTenant(T, (tx) => tx`SELECT id FROM password_reset_tokens WHERE user_id = ${userId} AND used_at IS NULL`, sql);
    expect(unused.length, "failed attempts must not spend the link").toBeGreaterThan(0);
  });

  it("a valid code sets the password, turns TOTP on, signs the user out everywhere, spends the link, and is audited", async () => {
    const sessionId = randomUUID();
    await withTenant(T, (tx) => tx`
      INSERT INTO auth_sessions (id, tenant_id, user_id, session_family_id, refresh_token_hash, expires_at)
      VALUES (${sessionId}, ${T}, ${userId}, ${randomUUID()}, ${randomUUID()}, NOW() + INTERVAL '1 hour')`, sql);
    const token = await issue();
    const s = await start(token);
    const done = await complete(s, token, { password: "First-Real-Password-2026" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).toMatch(/Your account is ready/);

    const c = await creds();
    expect(c.totp_enabled).toBe(true);
    expect(c.totp_secret).toBe(s.secret);
    const login = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password: "First-Real-Password-2026", tenantId: T } });
    expect(JSON.parse(login.body).mfaRequired, "the new password works and now needs TOTP").toBe(true);
    const [session] = await withTenant(T, (tx) => tx<{ is_revoked: boolean }[]>`SELECT is_revoked FROM auth_sessions WHERE id = ${sessionId}`, sql);
    expect(session!.is_revoked).toBe(true);

    const again = await start(token);
    expect(again.res.statusCode, "a link works once").toBe(400);
    expect(again.res.body).toMatch(/cannot be used/);

    const audit = await withTenant(T, (tx) => tx<{ action: string; after: Record<string, unknown> }[]>`
      SELECT action, after FROM audit_events WHERE tenant_id = ${T} AND object_id = ${userId}
        AND action IN ('auth.password_reset_issued', 'auth.account_setup_completed') ORDER BY seq`, sql);
    expect(audit.map((a) => a.action)).toContain("auth.password_reset_issued");
    const completed = audit.filter((a) => a.action === "auth.account_setup_completed");
    expect(completed).toHaveLength(1);
    expect(parsed(completed[0]!.after)).toMatchObject({ password_set: true, totp_enrolled: true, totp_replaced: false });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("a new link replaces the authenticator: the old one stops working", async () => {
    const before = (await creds()).totp_secret!;
    const token = await issue();
    const s = await start(token);
    expect(s.secret).not.toBe(before);
    const done = await complete(s, token, { password: "Second-Real-Password-2026" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).toMatch(/old one no longer works/);
    expect((await creds()).totp_secret).toBe(s.secret);
    const oldOk = await withTenant(T, (tx) => AuthService.verifyTotpCode(tx, { userId, tenantId: T, totpCode: generateTotp(before) }), sql);
    const newCode = await nextTotpCode(s.secret);
    const newOk = await withTenant(T, (tx) => AuthService.verifyTotpCode(tx, { userId, tenantId: T, totpCode: newCode }), sql);
    expect(oldOk).toBe(false);
    expect(newOk).toBe(true);
    const [last] = await withTenant(T, (tx) => tx<{ after: Record<string, unknown> }[]>`
      SELECT after FROM audit_events WHERE tenant_id = ${T} AND action = 'auth.account_setup_completed' ORDER BY seq DESC LIMIT 1`, sql);
    expect(parsed(last!.after).totp_replaced).toBe(true);
  });

  it("refuses an expired link, a made-up token, and a post without the CSRF cookie", async () => {
    const token = await issue();
    await withTenant(T, (tx) => tx`
      UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute'
      WHERE user_id = ${userId} AND used_at IS NULL`, sql);
    expect((await start(token)).res.statusCode).toBe(400);
    expect((await start("f".repeat(64))).res.statusCode).toBe(400);
    const noCookie = await app.inject({
      method: "POST",
      url: "/account/setup",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ action: "start", csrf: "x", token }).toString(),
    });
    expect(noCookie.statusCode).toBe(403);
  });

  it("the one-time token never appears in the request log", async () => {
    const token = await issue();
    const s = await start(token);
    const done = await complete(s, token, { password: "Third-Real-Password-2026" });
    expect(done.statusCode).toBe(200);

    const setupLines = logLines.filter((l) => l.includes("/account/setup"));
    expect(setupLines.length).toBeGreaterThan(0);
    expect(logLines.filter((l) => l.includes(token)), "no log line may contain the token").toEqual([]);
    // Printed for the record: what the request log holds for a setup-page request.
    process.stdout.write(`request log line for the setup page:\n${setupLines.find((l) => l.includes('"method":"POST"')) ?? setupLines[0]}\n`);
    process.stdout.write(`log lines captured: ${logLines.length}; lines containing the token: ${logLines.filter((l) => l.includes(token)).length}\n`);
  });
});
