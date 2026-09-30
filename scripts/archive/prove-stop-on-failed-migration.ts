import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

async function main() {
  console.log("=== Proving Item 1c: Runner exits NON-ZERO and STOPS on first failed migration ===");

  const adminSql = postgres("postgres://casefile:casefile@127.0.0.1:55432/postgres", { max: 1 });
  await adminSql`DROP DATABASE IF EXISTS casefile_stop_test`;
  await adminSql`CREATE DATABASE casefile_stop_test`;
  await adminSql.end();

  const throwawayUrl = "postgres://casefile:casefile@127.0.0.1:55432/casefile_stop_test";

  // Create temporary migrations directory
  const tempDir = path.resolve(process.cwd(), "scratch/temp_migrations_test");
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  fs.writeFileSync(
    path.join(tempDir, "0001_initial.sql"),
    "CREATE TABLE test_table_1 (id INT PRIMARY KEY, name TEXT);\nINSERT INTO test_table_1 VALUES (1, 'initial');\n"
  );
  fs.writeFileSync(
    path.join(tempDir, "0002_broken.sql"),
    "SELECT * FROM nonexistent_table_will_fail_migration;\n"
  );
  fs.writeFileSync(
    path.join(tempDir, "0003_subsequent.sql"),
    "CREATE TABLE test_table_3 (id INT PRIMARY KEY);\n"
  );

  console.log(`Created 3 test migrations in ${tempDir}:`);
  console.log("  - 0001_initial.sql (valid)");
  console.log("  - 0002_broken.sql  (fails)");
  console.log("  - 0003_subsequent.sql (must NOT be executed)");

  let exitCode = 0;
  let cliOutput: string;
  try {
    cliOutput = execSync(
      `pnpm tsx packages/db/migrate/index.ts --project-ref local --migrations-dir "${tempDir}"`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL_MIGRATIONS: throwawayUrl,
          DATABASE_URL: throwawayUrl,
        },
        stdio: "pipe",
      }
    ).toString();
  } catch (err: unknown) {
    const errorObj = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    exitCode = errorObj.status ?? 1;
    cliOutput = (errorObj.stdout?.toString() || "") + "\n" + (errorObj.stderr?.toString() || "");
  }

  console.log("\n--- Migration Runner Output ---");
  console.log(cliOutput.trim());
  console.log(`\nExit Code: ${exitCode}`);

  // Now verify database state
  const checkSql = postgres(throwawayUrl, { max: 1 });
  const tables = await checkSql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
  `;
  const tableNames = tables.map((t) => t.tablename);
  console.log("\nTables in database after halt:", tableNames);

  const applied = await checkSql<{ version: string }[]>`
    SELECT version FROM schema_migrations ORDER BY version;
  `;
  console.log("Recorded schema_migrations versions:", applied.map((a) => a.version));

  await checkSql.end();

  // Cleanup
  const cleanupSql = postgres("postgres://casefile:casefile@127.0.0.1:55432/postgres", { max: 1 });
  await cleanupSql`DROP DATABASE IF EXISTS casefile_stop_test`;
  await cleanupSql.end();
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (exitCode !== 0 && !tableNames.includes("test_table_3") && applied.length === 1 && applied[0]?.version === "0001_initial.sql") {
    console.log("\n✓ PROOF SUCCESSFUL: Runner exited non-zero (exit code 1), halted on first failure, and 0003 was never executed.");
  } else {
    console.error("\n✗ PROOF FAILED: Runner behavior did not meet required halt invariants.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Proof script execution failed:", err);
  process.exit(1);
});
