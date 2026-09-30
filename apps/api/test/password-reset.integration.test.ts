import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";

/**
 * D65: self-service password reset must not hand out reset tokens, and must not reveal
 * which email addresses have accounts. Until an email channel exists the request endpoint
 * delivers nothing; tokens are issued only by an administrator (scripts/issue-password-reset.ts).
 */
describe("apps/api — password reset request reveals nothing (D65)", () => {
  let app: ReturnType<typeof buildApp>;
  let db: postgres.Sql;
  let tenantId: string;
  let userId: string;
  let realEmail: string;

  beforeAll(async () => {
    db = createDbClient(getDbUrl());
    app = buildApp({ db });
    await app.ready();

    realEmail = `reset_probe_${Date.now()}@casefile.test`;
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: realEmail, password: "ResetProbePassword123!", name: "Reset Probe", orgName: "Reset Probe Org" },
    });
    expect(reg.statusCode).toBe(201);
    const body = JSON.parse(reg.body);
    tenantId = body.user.tenantId;
    userId = body.user.id;
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  const request = (email: string) =>
    app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { email, tenantId } });

  it("the response carries no reset token", async () => {
    const res = await request(realEmail);
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("resetToken");
    expect(body).not.toHaveProperty("token");
    // No 64-hex-character value (the token format) anywhere in the body.
    expect(res.body).not.toMatch(/[0-9a-f]{64}/);
  });

  it("the response is identical for a real and a non-existent email", async () => {
    const real = await request(realEmail);
    const fake = await request(`nobody_${randomUUID()}@casefile.test`);
    expect(fake.statusCode).toBe(real.statusCode);
    expect(fake.body).toBe(real.body);
    // Every header except the per-request id and the clock must match.
    const comparable = (h: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(h).filter(([k]) => k !== "x-request-id" && k !== "date"));
    expect(comparable(fake.headers)).toEqual(comparable(real.headers));
  });

  it("a self-service request issues no token at all (nothing is delivered yet)", async () => {
    const count = () =>
      withTenant(tenantId, async (tx) => {
        const rows = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM password_reset_tokens WHERE user_id = ${userId};
        `;
        return Number(rows[0]?.n ?? "0");
      }, db);
    const before = await count();
    await request(realEmail);
    expect(await count()).toBe(before);
  });

  it("the admin command issues a one-hour single-use token, prints how to use it, and audits it", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const stdout = execFileSync(
      process.execPath,
      [resolve(repoRoot, "node_modules/tsx/dist/cli.mjs"), "scripts/issue-password-reset.ts",
        "--email", realEmail, "--tenant", tenantId, "--api-url", "https://casefile.example/", "--issued-by", "test-admin"],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env } },
    );
    const token = stdout.match(/^\s{2}([0-9a-f]{64})$/m)?.[1];
    expect(token, stdout).toBeDefined();
    // D71: the command now prints the one-time account setup link; the token is in its fragment.
    expect(stdout).toContain(`https://casefile.example/account/setup#token=${token}`);
    {
      const confirm = await app.inject({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        payload: { token, tenantId, newPassword: "AdminIssuedPassword123!" },
      });
      expect(confirm.statusCode).toBe(200);
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/token",
        payload: { email: realEmail, password: "AdminIssuedPassword123!", tenantId },
      });
      expect(login.statusCode).toBe(200);

      await withTenant(tenantId, async (tx) => {
        const audit = await tx<{ actor_id: string; actor_display: string; object_id: string; after: unknown }[]>`
          SELECT actor_id, actor_display, object_id, after FROM audit_events
          WHERE tenant_id = ${tenantId} AND action = 'auth.password_reset_issued'
          ORDER BY seq DESC LIMIT 1;
        `;
        expect(audit[0]?.actor_id).toBe("00000000-0000-0000-0000-000000000000");
        expect(audit[0]?.actor_display).toBe("Admin CLI (test-admin)");
        expect(audit[0]?.object_id).toBe(userId);
        expect(JSON.stringify(audit[0]?.after)).not.toContain(token!);

        const tokens = await tx<{ minutes: number }[]>`
          SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 60 AS minutes
          FROM password_reset_tokens WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1;
        `;
        expect(Math.round(Number(tokens[0]?.minutes))).toBe(60);
      }, db);
    }
  }, 60_000);
});
