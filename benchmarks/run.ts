/* eslint-disable no-console */
import { randomUUID } from "node:crypto";
import autocannon from "autocannon";
import type postgres from "postgres";
import { createDbClient, withTenant } from "@casefile/db";
import { hashPassword, signJwt } from "../apps/api/src/auth/crypto.js";
import { buildApp } from "../apps/api/src/app.js";

interface BenchmarkResult {
  endpoint: string;
  method: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  targetP50: number;
  targetP95: number;
  status: "PASS" | "FAIL";
}

async function seedBenchmarkData(db: postgres.Sql) {
  const tenantId = randomUUID();
  const password = "BenchPassword123!";
  const pwdHash = await hashPassword(password);

  console.log("────────────────────────────────────────────────────────────");
  console.log("CASEFILE BENCHMARK HARNESS (PRD §49 / §53.5)");
  console.log("Scale envelope: Seeded at 1/100 scale (10 workspaces, 20 users, 50 memberships)");
  console.log("────────────────────────────────────────────────────────────");

  let adminUserId = "";
  const workspaceIds: string[] = [];

  await withTenant(tenantId, async (tx) => {
    // 1. Create Organization
    await tx`
      INSERT INTO organizations (id, tenant_id, name)
      VALUES (${tenantId}, ${tenantId}, 'Benchmark Tenant Corp')
      ON CONFLICT (id) DO NOTHING;
    `;

    // 2. Create Admin User
    adminUserId = randomUUID();
    await tx`
      INSERT INTO users (id, tenant_id, email, name, status)
      VALUES (${adminUserId}, ${tenantId}, 'bench_admin@casefile.test', 'Bench Admin', 'active')
      ON CONFLICT (id) DO NOTHING;
    `;

    await tx`
      INSERT INTO auth_credentials (user_id, tenant_id, password_hash)
      VALUES (${adminUserId}, ${tenantId}, ${pwdHash})
      ON CONFLICT (user_id) DO NOTHING;
    `;

    // 3. Create 10 Workspaces
    for (let i = 0; i < 10; i++) {
      const wsId = randomUUID();
      workspaceIds.push(wsId);
      await tx`
        INSERT INTO workspaces (id, tenant_id, name, created_by, policy, retention_policy, confidence_weights)
        VALUES (
          ${wsId}, ${tenantId}, ${`Bench Workspace ${i + 1}`}, ${adminUserId},
          ${JSON.stringify({ separation_of_duties: true, mfa_required: false })}::jsonb,
          ${JSON.stringify({ floor_days: 90, delete_after_days: 730 })}::jsonb,
          ${JSON.stringify({ corroboration_weight: 0.5, source_credibility: 0.5 })}::jsonb
        )
        ON CONFLICT (id) DO NOTHING;
      `;
    }

    // 4. Create 20 Users and 50 Memberships
    for (let i = 0; i < 20; i++) {
      const uId = randomUUID();
      await tx`
        INSERT INTO users (id, tenant_id, email, name, status)
        VALUES (${uId}, ${tenantId}, ${`user_${i}@casefile.test`}, ${`User ${i}`}, 'active')
        ON CONFLICT (id) DO NOTHING;
      `;

      // Assign to 2-3 workspaces
      for (let w = 0; w < 3; w++) {
        const targetWs = workspaceIds[(i + w) % workspaceIds.length]!;
        await tx`
          INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
          VALUES (${randomUUID()}, ${tenantId}, ${targetWs}, ${uId}, 'investigator')
          ON CONFLICT (workspace_id, user_id) DO NOTHING;
        `;
      }
    }
  }, db);

  const token = signJwt({
    sub: adminUserId,
    tid: tenantId,
    sid: randomUUID(),
    roles: ["org_admin", "workspace_admin"],
    mfa: true,
  });

  return { tenantId, adminUserId, workspaceId: workspaceIds[0]!, token, email: "bench_admin@casefile.test", password };
}

async function runBenchmark(
  name: string,
  url: string,
  method: "GET" | "POST" | "PATCH",
  headers: Record<string, string>,
  body?: string,
  targetP50 = 400,
  targetP95 = 1000,
): Promise<BenchmarkResult> {
  // autocannon's latency histogram has no p95 (its percentiles jump from p90 to p97.5),
  // so record every response time and compute the true p95 the §49 targets are set in.
  const responseTimesMs: number[] = [];
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url,
        method,
        headers,
        body,
        duration: 3, // 3s per test
        connections: 10,
        pipelining: 1,
      },
      (err, result) => {
        if (err) return reject(err);
        const p50 = result.latency.p50;
        const p95 = percentile(responseTimesMs, 95);
        const p99 = result.latency.p99;
        const status = p95 <= targetP95 ? "PASS" : "FAIL";

        resolve({
          endpoint: name,
          method,
          requests: result.requests.total,
          p50,
          p95,
          p99,
          targetP50,
          targetP95,
          status,
        });
      },
    );
    instance.on("response", (_client, _statusCode, _resBytes, responseTime) => {
      responseTimesMs.push(responseTime);
    });
  });
}

/** Nearest-rank percentile; Infinity when nothing was measured, so an empty run fails its target. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.POSITIVE_INFINITY;
}

async function main() {
  process.env.NODE_ENV = "test";
  // D66: the benchmark sends thousands of requests from one address; keep the limiter in the
  // measured path but scale its thresholds out of the way.
  process.env.RATE_LIMIT_SCALE ??= "100000";
  const dbUrl =
    process.env.DATABASE_URL_TEST ||
    "postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile_test";
  const db = createDbClient(dbUrl);
  const seed = await seedBenchmarkData(db);

  const app = buildApp({ db, logger: false });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  console.log(`Server listening for benchmarks on ${address}`);

  const results: BenchmarkResult[] = [];

  try {
    // 1. Benchmark: POST /v1/auth/token (Credential exchange with Argon2id)
    console.log("Measuring POST /v1/auth/token...");
    results.push(
      await runBenchmark(
        "/v1/auth/token",
        `${address}/v1/auth/token`,
        "POST",
        { "content-type": "application/json" },
        JSON.stringify({ email: seed.email, password: seed.password, tenantId: seed.tenantId }),
        500,
        1500,
      ),
    );

    // 2. Benchmark: GET /v1/me (Profile lookup with JWT verification)
    console.log("Measuring GET /v1/me...");
    results.push(
      await runBenchmark(
        "/v1/me",
        `${address}/v1/me`,
        "GET",
        { authorization: `Bearer ${seed.token}` },
        undefined,
        100,
        300,
      ),
    );

    // 3. Benchmark: GET /v1/workspaces (Workspace list query)
    console.log("Measuring GET /v1/workspaces...");
    results.push(
      await runBenchmark(
        "/v1/workspaces",
        `${address}/v1/workspaces?limit=20`,
        "GET",
        { authorization: `Bearer ${seed.token}` },
        undefined,
        200,
        600,
      ),
    );

    // 4. Benchmark: GET /v1/workspaces/:id/members (Member list query)
    console.log("Measuring GET /v1/workspaces/:id/members...");
    results.push(
      await runBenchmark(
        "/v1/workspaces/:id/members",
        `${address}/v1/workspaces/${seed.workspaceId}/members`,
        "GET",
        { authorization: `Bearer ${seed.token}` },
        undefined,
        200,
        600,
      ),
    );

    // 5. Benchmark: GET /v1/workspaces/:id/policy (Policy read)
    console.log("Measuring GET /v1/workspaces/:id/policy...");
    results.push(
      await runBenchmark(
        "/v1/workspaces/:id/policy",
        `${address}/v1/workspaces/${seed.workspaceId}/policy`,
        "GET",
        { authorization: `Bearer ${seed.token}` },
        undefined,
        200,
        600,
      ),
    );

    // 6. Benchmark: PATCH /v1/workspaces/:id/policy (Policy write)
    console.log("Measuring PATCH /v1/workspaces/:id/policy...");
    results.push(
      await runBenchmark(
        "/v1/workspaces/:id/policy",
        `${address}/v1/workspaces/${seed.workspaceId}/policy`,
        "PATCH",
        { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
        JSON.stringify({ separation_of_duties: true, retention_policy: { floor_days: 90 } }),
        300,
        800,
      ),
    );

    console.log("\nBENCHMARK RESULTS (Scale Ratio: 1/100 §53.5)");
    console.log("────────────────────────────────────────────────────────────────────────────────────────");
    console.log("Endpoint                          | Req/sec | p50 (ms) | p95 (ms) | Target p95 | Status");
    console.log("──────────────────────────────────┼─────────┼──────────┼──────────┼────────────┼────────");
    for (const r of results) {
      const name = `${r.method} ${r.endpoint}`.padEnd(33, " ");
      const reqSec = (r.requests / 3).toFixed(0).padStart(7, " ");
      const p50 = r.p50.toFixed(1).padStart(8, " ");
      const p95 = r.p95.toFixed(1).padStart(8, " ");
      const tgt = `${r.targetP95} ms`.padStart(10, " ");
      const st = r.status.padStart(6, " ");
      console.log(`${name} | ${reqSec} | ${p50} | ${p95} | ${tgt} | ${st}`);
    }
    console.log("────────────────────────────────────────────────────────────────────────────────────────\n");
  } finally {
    await app.close();
    await db.end();
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
