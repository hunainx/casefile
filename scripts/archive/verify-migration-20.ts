import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is required (casefile_app connection string for the project to inspect).");
  process.exit(1);
}

async function run() {
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  
  console.log("=== Querying pg_constraint on sources ===");
  const constraints = await sql`
    SELECT conname, pg_get_constraintdef(oid) as def
    FROM pg_constraint
    WHERE conrelid = 'sources'::regclass AND contype = 'c';
  `;
  for (const c of constraints) {
    console.log(`Constraint: ${c.conname}`);
    console.log(`Definition: ${c.def}`);
  }

  console.log("\n=== Checking geneva_settlement_smoke.txt in the matter ===");
  const tenantId = process.env.MATTER_TENANT_ID ?? "<MATTER_TENANT_ID>";
  const sources = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return await tx`SELECT id, filename, status, byte_size, created_at FROM sources WHERE filename = 'geneva_settlement_smoke.txt'`;
  });
  console.log("Found source:", sources);

  await sql.end();
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
