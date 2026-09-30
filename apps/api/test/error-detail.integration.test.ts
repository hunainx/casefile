import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Writable } from "node:stream";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient } from "@casefile/db";
import { buildApp } from "../src/app.js";

/**
 * FINAL, DEV-046. An unexpected error's own text went back to the caller: a 500's `detail` was `error.message` (a
 * database constraint message, a table name, a connection error), in every environment, and /healthz put the
 * database error in its 503. Now the caller gets a generic message and the request ID, and the full error goes to
 * the server log only, with the same request ID. A client error (4xx) still says what was wrong with the request.
 */
const GENERIC = /unexpected error.*request ID/i;

describe("FINAL — DEV-046: a server error never sends its own text to the caller", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let token: string;
  const log: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      log.push(String(chunk));
      done();
    },
  });

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql, logger: { stream } });
    // Probe routes go through the same wrapper and error handler as every real route.
    app.get("/v1/__probe/database-error", { config: { authenticated: true } }, async (req) => {
      await req.tx!`SELECT * FROM fake_table_that_does_not_exist_dev046`;
      return { unreachable: true };
    });
    app.get("/v1/__probe/internal-5xx", { config: { authenticated: true } }, async () => {
      throw Object.assign(new Error("fake internal detail: upstream host 10.9.8.7 refused"), { statusCode: 502 });
    });
    app.get("/v1/__probe/client-4xx", { config: { authenticated: true } }, async () => {
      throw Object.assign(new Error("the field 'name' is required"), { statusCode: 400 });
    });
    await app.ready();
    const email = `error-detail-${Date.now()}@casefile.test`;
    const reg = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password: "ErrorDetail123!", name: "Error Detail", orgName: "Error Detail Fake Org" } })).body);
    token = reg.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  const call = (url: string, requestId: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, "x-request-id": requestId } });

  it("a database error: 500, a generic message and the request ID; the database's text only in the server log", async () => {
    const res = await call("/v1/__probe/database-error", "req_dev046_database");
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.detail).toMatch(GENERIC);
    expect(body.request_id).toBe("req_dev046_database");
    expect(res.body).not.toMatch(/fake_table_that_does_not_exist_dev046|does not exist|relation/);
    const logged = log.join("");
    expect(logged).toContain("fake_table_that_does_not_exist_dev046");
    expect(logged).toContain("req_dev046_database");
  });

  it("any other 5xx the same way", async () => {
    const res = await call("/v1/__probe/internal-5xx", "req_dev046_5xx");
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).detail).toMatch(GENERIC);
    expect(res.body).not.toContain("10.9.8.7");
    expect(log.join("")).toContain("10.9.8.7");
  });

  it("a client error (4xx) still says what was wrong with the request", async () => {
    const res = await call("/v1/__probe/client-4xx", "req_dev046_4xx");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).detail).toBe("the field 'name' is required");
  });

  it("/healthz, /healthz/ and /ready with the database down: no connection error text, a request ID", async () => {
    const brokenDb = postgres({ host: "127.0.0.1", port: 1, database: "unreachable_dev046", username: "unreachable", max: 1, connect_timeout: 2 });
    const brokenApp = buildApp({ db: brokenDb, logger: { stream } });
    await brokenApp.ready();
    try {
      for (const url of ["/healthz", "/healthz/", "/ready"]) {
        const id = `req_dev046_health_${url.replace(/\W/g, "")}`;
        const res = await brokenApp.inject({ method: "GET", url, headers: { "x-request-id": id } });
        const body = JSON.parse(res.body);
        if (url === "/ready") {
          // /ready's transaction fails to open before the route runs, so it answers through the error handler:
          // a generic 500 (its status is older than DEV-046 and unchanged).
          expect(res.statusCode, url).toBe(500);
          expect(body.detail).toMatch(GENERIC);
        } else {
          expect(res.statusCode, url).toBe(503);
          expect(body.status).toBe("unhealthy");
        }
        expect(body.request_id).toBe(id);
        expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|unreachable_dev046/);
        expect(log.join("")).toContain(id);
      }
    } finally {
      await brokenApp.close();
      await brokenDb.end({ timeout: 1 });
    }
  });
});
