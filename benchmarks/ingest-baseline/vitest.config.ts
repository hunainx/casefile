import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Runs the BIGDATA-1 ingest baseline (ingest-baseline.bench-run.ts). Not part of `pnpm verify`:
 * it takes minutes to hours and needs a generated corpus. Started by run-baseline.sh.
 * One fork; the run records its own CPU profile through node:inspector (a --cpu-prof profile
 * is never written, because vitest ends the fork without a normal exit).
 */
const root = resolve(import.meta.dirname, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@casefile/db": resolve(root, "packages/db/src/index.ts"),
      "@casefile/audit": resolve(root, "packages/audit/src/index.ts"),
      "@casefile/policy": resolve(root, "packages/policy/src/index.ts"),
      "@casefile/contracts": resolve(root, "packages/contracts/src/index.ts"),
      "@casefile/storage": resolve(root, "packages/storage/src/index.ts"),
      "pdf-lib": resolve(root, "apps/api/node_modules/pdf-lib"),
    },
  },
  test: {
    root,
    include: ["benchmarks/ingest-baseline/ingest-baseline.bench-run.ts"],
    environment: "node",
    pool: "forks",
    // Vitest 4 removed poolOptions (D135): one fork, not isolated, same heap size as before.
    maxWorkers: 1,
    isolate: false,
    execArgv: ["--max-old-space-size=8192"],
    fileParallelism: false,
    testTimeout: 4 * 60 * 60 * 1000,
    hookTimeout: 60_000,
  },
});
