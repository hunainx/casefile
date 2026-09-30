import postgres from "postgres";
import { migrate } from "../../packages/db/migrate/index.js";

async function main() {
  console.log("Setting up throwaway local database 'casefile_guard_test'...");
  const adminSql = postgres("postgres://casefile:casefile@127.0.0.1:55432/postgres", { max: 1 });
  await adminSql`DROP DATABASE IF EXISTS casefile_guard_test`;
  await adminSql`CREATE DATABASE casefile_guard_test`;
  await adminSql.end();

  const throwawayUrl = "postgres://casefile:casefile@127.0.0.1:55432/casefile_guard_test";
  const testSql = postgres(throwawayUrl, { max: 1 });

  console.log("Seeding fake foreign migrations into schema_migrations...");
  await testSql`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await testSql`
    INSERT INTO schema_migrations (version) VALUES
      ('001_roles_and_extensions'),
      ('002_projects'),
      ('003_foreign_custom_table');
  `;
  await testSql.end();

  console.log("Running migrate runner against seeded local throwaway database...\n");
  try {
    await migrate({
      dbUrl: throwawayUrl,
      projectRef: "local",
    });
    console.error("FAIL: Runner should have aborted but succeeded!");
    process.exit(1);
  } catch (err: unknown) {
    console.log("\n[Expected Guard Rejection Caught Successfully]");
    console.log("Error message:", (err as Error).message);
  } finally {
    const cleanupSql = postgres("postgres://casefile:casefile@127.0.0.1:55432/postgres", { max: 1 });
    await cleanupSql`DROP DATABASE IF EXISTS casefile_guard_test`;
    await cleanupSql.end();
  }
}

main().catch(console.error);
