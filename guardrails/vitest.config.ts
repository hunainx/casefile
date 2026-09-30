import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * The five guardrail suites run on EVERY commit, not only on the relevant epic's
 * changes. Budget for all five: under 4 minutes (HANDOFF §3.5). If they get slower
 * than that they will get skipped, and then they are worthless.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@casefile/db": resolve(import.meta.dirname, "../packages/db/src/index.ts"),
      "@casefile/audit": resolve(import.meta.dirname, "../packages/audit/src/index.ts"),
      "@casefile/policy": resolve(import.meta.dirname, "../packages/policy/src/index.ts"),
      "@casefile/contracts": resolve(import.meta.dirname, "../packages/contracts/src/index.ts"),
      "@casefile/storage": resolve(import.meta.dirname, "../packages/storage/src/index.ts"),
      "@casefile/mock-provider": resolve(import.meta.dirname, "../packages/mock-provider/src/index.ts"),
      "@casefile/api": resolve(import.meta.dirname, "../apps/api/src/index.ts"),
      "@casefile/mcp": resolve(import.meta.dirname, "../packages/mcp/src/index.ts"),
    },
  },
  test: {
    include: ["guardrails/**/*.spec.ts", "apps/api/test/architecture.test.ts"],
    root: resolve(import.meta.dirname, ".."),
    reporters: ["default", resolve(import.meta.dirname, "reporter.ts")],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Guardrails share seeded tenants; run files sequentially for a stable fixture.
    fileParallelism: false,
    pool: "forks",
    env: {
      // D66: see vitest.integration.config.ts.
      RATE_LIMIT_SCALE: "1000",
      JWT_SECRET: "test_jwt_secret_at_least_32_bytes_long_000",
      // getDbUrl() no longer guesses a connection string; the local test cluster is the
      // default here and CI's DATABASE_URL_TEST takes precedence.
      DATABASE_URL_TEST: process.env.DATABASE_URL_TEST || "postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile_test",
      MATTER_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      MATTER_INVESTIGATION_ID: "00000000-0000-0000-0000-000000000000",
      // D69: see vitest.integration.config.ts.
      MCP_PUBLIC_URL: "https://mcp.casefile.test/mcp",
    },
  },
});
