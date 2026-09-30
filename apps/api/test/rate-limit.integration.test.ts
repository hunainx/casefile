import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";
import { rateLimitBucketKey } from "../src/rate-limit.js";

/**
 * D66: real rate limits, counted in Postgres so every Cloud Run instance shares them.
 * These tests pass small limits and a short window so the thresholds and the recovery are
 * observable; the production numbers are asserted separately.
 */
const WINDOW_SECONDS = 2;
const TEST_LIMITS = {
  rules: {
    login: { windowSeconds: WINDOW_SECONDS, perIp: 3, perAccount: 2 },
    password_reset: { windowSeconds: WINDOW_SECONDS, perIp: 3, perAccount: 2 },
    oauth_token: { windowSeconds: WINDOW_SECONDS, perIp: 3, perAccount: 2 },
    general: { windowSeconds: WINDOW_SECONDS, perIp: 4, perAccount: 4 },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The limiter measures windows with the database clock (NOW()), so recovery is awaited on that
 * clock too. A host-side sleep is not a measure of it: the local database runs in Docker's VM,
 * whose clock was measured running about 8% slower than the host's between resyncs (and
 * jumping forward at them), so a host sleep of window + 250 ms could still end inside the window
 * by the database's clock (Phase 3; captures/phase3/clock-probe-output.txt).
 * Polls until the bucket's window has ended by the database's clock.
 */
async function waitForWindowEnd(db: postgres.Sql, bucketKey: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [row] = await db<{ over: boolean }[]>`
      SELECT window_start + make_interval(secs => window_seconds) <= NOW() AS over
      FROM rate_limit_counters WHERE bucket_key = ${bucketKey}`;
    if (!row) throw new Error("no rate-limit counter for this bucket");
    if (row.over) return;
    if (Date.now() > deadline) throw new Error("the window did not end on the database clock within 20 s");
    await sleep(50);
  }
}
/** A fresh address per test so counters from earlier runs never interfere. */
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

describe("apps/api — rate limiting (D66)", () => {
  let app: ReturnType<typeof buildApp>;
  let db: postgres.Sql;
  let tenantId: string;

  beforeAll(async () => {
    db = createDbClient(getDbUrl());
    app = buildApp({ db, rateLimit: TEST_LIMITS });
    await app.ready();
    tenantId = randomUUID();
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  const login = (email: string, ip: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/token",
      remoteAddress: ip,
      payload: { email, password: "wrong-password-123", tenantId },
    });

  it("login: per-IP limit returns 429 with Retry-After, then recovers after the window", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await login(`ip_${randomUUID()}@casefile.test`, ip)).statusCode);
    expect(statuses.every((s) => s !== 429)).toBe(true);

    const blocked = await login(`ip_${randomUUID()}@casefile.test`, ip);
    expect(blocked.statusCode).toBe(429);
    const retryAfter = Number(blocked.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECONDS);
    expect(JSON.parse(blocked.body).status).toBe(429);

    // The window lasts WINDOW_SECONDS on the limiter's (database) clock; once that clock says
    // it has ended, the address is served again.
    const [counter] = await db<{ seconds: number }[]>`
      SELECT window_seconds AS seconds FROM rate_limit_counters WHERE bucket_key = ${rateLimitBucketKey("login", `ip:${ip}`)}`;
    expect(counter!.seconds).toBe(WINDOW_SECONDS);
    await waitForWindowEnd(db, rateLimitBucketKey("login", `ip:${ip}`));
    expect((await login(`ip_${randomUUID()}@casefile.test`, ip)).statusCode).not.toBe(429);
  });

  it("login: per-account limit applies across different IPs", async () => {
    const email = `acct_${randomUUID()}@casefile.test`;
    expect((await login(email, freshIp())).statusCode).not.toBe(429);
    expect((await login(email, freshIp())).statusCode).not.toBe(429);
    expect((await login(email, freshIp())).statusCode).toBe(429);
    expect((await login(email.toUpperCase(), freshIp())).statusCode).toBe(429);
  });

  it("password reset request and confirm are limited per IP and per account", async () => {
    const ip = freshIp();
    const req = (email: string, from: string) =>
      app.inject({ method: "POST", url: "/v1/auth/password-reset/request", remoteAddress: from, payload: { email, tenantId } });
    const email = `reset_${randomUUID()}@casefile.test`;
    expect((await req(email, freshIp())).statusCode).not.toBe(429);
    expect((await req(email, freshIp())).statusCode).not.toBe(429);
    expect((await req(email, freshIp())).statusCode).toBe(429);

    const confirm = (token: string) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/password-reset/confirm",
        remoteAddress: ip,
        payload: { token, newPassword: "NewPassword123456!", tenantId },
      });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await confirm(randomUUID())).statusCode);
    expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
    expect(codes[3]).toBe(429);
  });

  // The real endpoint since Phase 2A (D69); the refresh tokens here are unknown, so it answers
  // invalid_grant until the per-IP limit blocks the fourth request.
  it("the OAuth token endpoint is limited per IP", async () => {
    const ip = freshIp();
    const post = () =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        remoteAddress: ip,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: randomUUID(), client_id: "https://claude.ai/oauth/claude-code-client-metadata" }).toString(),
      });
    for (let i = 0; i < 3; i++) expect((await post()).statusCode).not.toBe(429);
    expect((await post()).statusCode).toBe(429);
  });

  it("everything else has a looser general limit", async () => {
    const ip = freshIp();
    const get = () => app.inject({ method: "GET", url: "/v1/workspaces", remoteAddress: ip });
    for (let i = 0; i < 4; i++) expect((await get()).statusCode).not.toBe(429);
    const blocked = await get();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("no response carries made-up x-ratelimit-* headers", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/workspaces", remoteAddress: freshIp() });
    for (const name of Object.keys(res.headers)) expect(name.startsWith("x-ratelimit")).toBe(false);
  });

  it("behind one trusted proxy, a client cannot dodge the per-IP limit by spoofing X-Forwarded-For", async () => {
    const saved = process.env.TRUST_PROXY_HOPS;
    process.env.TRUST_PROXY_HOPS = "1";
    const proxied = buildApp({ db, rateLimit: TEST_LIMITS });
    await proxied.ready();
    try {
      const realClient = freshIp();
      const attempt = () =>
        proxied.inject({
          method: "POST",
          url: "/v1/auth/token",
          remoteAddress: "169.254.8.1", // the proxy
          headers: { "x-forwarded-for": `${freshIp()}, ${realClient}` }, // spoofed first entry, real last
          payload: { email: `xff_${randomUUID()}@casefile.test`, password: "wrong-password-123", tenantId },
        });
      for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).not.toBe(429);
      expect((await attempt()).statusCode).toBe(429);
    } finally {
      await proxied.close();
      if (saved === undefined) delete process.env.TRUST_PROXY_HOPS;
      else process.env.TRUST_PROXY_HOPS = saved;
    }
  });

  it("if the counter store fails, sign-in fails closed (503) while general routes still reach their handler", async () => {
    // A real client pointed at a local port nothing listens on.
    const broken = postgres({ host: "127.0.0.1", port: 1, database: "unreachable", username: "unreachable", max: 1, connect_timeout: 2 });
    const isolated = buildApp({ db: broken, rateLimit: TEST_LIMITS });
    await isolated.ready();
    try {
      const signIn = await isolated.inject({
        method: "POST",
        url: "/v1/auth/token",
        remoteAddress: freshIp(),
        payload: { email: `down_${randomUUID()}@casefile.test`, password: "wrong-password-123", tenantId },
      });
      expect(signIn.statusCode).toBe(503);
      expect(signIn.headers["retry-after"]).toBe("5");

      // An authenticated route without a token answers 401 from its own handler, which it can
      // only do if the limiter let the request through.
      const general = await isolated.inject({ method: "GET", url: "/v1/workspaces", remoteAddress: freshIp() });
      expect(general.statusCode).toBe(401);
    } finally {
      await isolated.close();
      await broken.end({ timeout: 1 });
    }
  }, 30_000);

  it("RATE_LIMIT_SCALE is refused on Cloud Run or in production", () => {
    const saved = { scale: process.env.RATE_LIMIT_SCALE, kservice: process.env.K_SERVICE };
    try {
      process.env.RATE_LIMIT_SCALE = "1000";
      process.env.K_SERVICE = "casefile-api";
      expect(() => buildApp({ db })).toThrow(/RATE_LIMIT_SCALE/);
    } finally {
      if (saved.scale === undefined) delete process.env.RATE_LIMIT_SCALE;
      else process.env.RATE_LIMIT_SCALE = saved.scale;
      if (saved.kservice === undefined) delete process.env.K_SERVICE;
      else process.env.K_SERVICE = saved.kservice;
    }
  });
});
