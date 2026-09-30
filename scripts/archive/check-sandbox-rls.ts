import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const match = envContent.match(/DATABASE_URL_MIGRATIONS=(.+)/);
const dbUrl = match && match[1] ? match[1].trim() : process.env.DATABASE_URL_MIGRATIONS || "";

async function main() {
  const sql = postgres(dbUrl, { max: 1 });

  console.log("=== Checking RLS and FORCE RLS on all tables ===");
  const rows = await sql<{
    tablename: string;
    rowsecurity: boolean;
    forcerowsecurity: boolean;
  }[]>`
    SELECT 
      c.relname AS tablename,
      c.relrowsecurity AS rowsecurity,
      c.relforcerowsecurity AS forcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname ASC;
  `;

  let allValid = true;
  for (const r of rows) {
    const status = (r.rowsecurity && r.forcerowsecurity) ? "✓ PASS" : (r.tablename === "schema_migrations" ? "— SYSTEM" : "❌ FAIL");
    console.log(`${r.tablename.padEnd(35)} | rowsecurity: ${String(r.rowsecurity).padEnd(5)} | forcerowsecurity: ${String(r.forcerowsecurity).padEnd(5)} | ${status}`);
    if (r.tablename !== "schema_migrations" && (!r.rowsecurity || !r.forcerowsecurity)) {
      allValid = false;
    }
  }

  await sql.end();

  if (!allValid) {
    console.error("\nABORT: Found tenant table without BOTH rowsecurity AND forcerowsecurity true!");
    process.exit(1);
  } else {
    console.log(`\n✓ All ${rows.length} tables verified with forced RLS!`);
  }
}

main().catch((err) => {
  console.error("Check failed:", err);
  process.exit(1);
});
