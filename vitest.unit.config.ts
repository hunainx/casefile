import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit tests: pure logic only — confidence composition, temporal comparison,
 * diagnosticity, epistemic transitions. Anything that touches Postgres belongs in
 * the integration project, because D35 forbids testing tenancy against a mock.
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
    },
  },
  test: {
    include: [
      "packages/**/*.unit.test.ts",
      "apps/**/*.unit.test.ts",
      "tools/**/*.unit.test.ts",
    ],
    passWithNoTests: true,
    environment: "node",
    env: {
      JWT_SECRET: "test_jwt_secret_at_least_32_bytes_long_000",
      MATTER_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      MATTER_INVESTIGATION_ID: "00000000-0000-0000-0000-000000000000",
    },
  },
});
