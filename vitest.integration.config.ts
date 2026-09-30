import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Integration tests run against a REAL Postgres with RLS enabled and an application
 * role that cannot bypass it (D35, I7). There is no mock-database mode and there must
 * never be one: a mocked database would make every tenancy assertion vacuous while
 * reporting green.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@casefile/db": resolve(__dirname, "packages/db/src/index.ts"),
      "@casefile/audit": resolve(__dirname, "packages/audit/src/index.ts"),
      "@casefile/policy": resolve(__dirname, "packages/policy/src/index.ts"),
      "@casefile/contracts": resolve(__dirname, "packages/contracts/src/index.ts"),
      "@casefile/storage": resolve(__dirname, "packages/storage/src/index.ts"),
      "@casefile/mock-provider": resolve(__dirname, "packages/mock-provider/src/index.ts"),
      "@casefile/api": resolve(__dirname, "apps/api/src/index.ts"),
      "@casefile/mcp": resolve(__dirname, "packages/mcp/src/index.ts"),
      "pdf-lib": resolve(__dirname, "apps/api/node_modules/pdf-lib"),
    },
  },
  test: {
    include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts", "tools/**/*.integration.test.ts"],
    passWithNoTests: true,
    environment: "node",
    fileParallelism: false,
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ["default", resolve(__dirname, "infra/ci/integration-reporter.ts")],
    env: {
      STORAGE_DRIVER: "gcs",
      STORAGE_EMULATOR_HOST: "http://127.0.0.1:4443",
      GCS_BUCKET_SOURCES: "casefile-localtest-sources",
      GCS_BUCKET_ARTIFACTS: "casefile-localtest-artifacts",
      GCS_BUCKET_EXPORTS: "casefile-localtest-exports",
      // D66: the suite signs in hundreds of times from 127.0.0.1; limits stay active but are
      // scaled up. apps/api/test/rate-limit.integration.test.ts proves the real thresholds.
      RATE_LIMIT_SCALE: "1000",
      JWT_SECRET: "test_jwt_secret_at_least_32_bytes_long_000",
      // getDbUrl() no longer guesses a connection string; the local test cluster is the
      // default here and CI's DATABASE_URL_TEST takes precedence.
      DATABASE_URL_TEST: process.env.DATABASE_URL_TEST || "postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile_test",
      // Owner connection the tenancy test uses to run migrations against the local test
      // cluster (previously a literal inside packages/db/test/tenancy.integration.test.ts).
      DATABASE_URL_TEST_OWNER: process.env.DATABASE_URL_TEST_OWNER || "postgres://casefile:casefile@127.0.0.1:55432/casefile_test",
      MATTER_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      MATTER_INVESTIGATION_ID: "00000000-0000-0000-0000-000000000000",
      // D69: the OAuth resource identifier. A fake, never-resolving .test name.
      MCP_PUBLIC_URL: "https://mcp.casefile.test/mcp",
    },
  },
});
