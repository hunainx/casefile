import postgres from "postgres";

const ownerUrl = process.env.DATABASE_URL_MIGRATIONS ?? "";
if (!ownerUrl) {
  console.error("DATABASE_URL_MIGRATIONS is required (owner connection string for the project to inspect).");
  process.exit(1);
}

async function main() {
  const sql = postgres(ownerUrl, { max: 1 });
  try {
    console.log("=== 1. RLS ENABLED & FORCE STATUS ===");
    const rlsStatus = await sql`
      SELECT 
        c.relname as table_name,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' 
        AND c.relname IN ('audit_events', 'audit_chain_heads')
      ORDER BY c.relname;
    `;
    console.table(rlsStatus);

    console.log("\n=== 2. POLICIES ON AUDIT TABLES ===");
    const policies = await sql`
      SELECT 
        schemaname,
        tablename,
        policyname,
        permissive,
        roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
      WHERE tablename IN ('audit_events', 'audit_chain_heads')
      ORDER BY tablename, policyname;
    `;
    console.table(policies);
    console.log(JSON.stringify(policies, null, 2));

    console.log("\n=== 3. PERMISSIONS FOR anon AND authenticated ===");
    const privs = await sql`
      SELECT 
        role,
        table_name,
        has_table_privilege(role, table_name, 'SELECT') as can_select,
        has_table_privilege(role, table_name, 'INSERT') as can_insert,
        has_table_privilege(role, table_name, 'UPDATE') as can_update,
        has_table_privilege(role, table_name, 'DELETE') as can_delete,
        has_table_privilege(role, table_name, 'TRUNCATE') as can_truncate
      FROM (
        SELECT unnest(ARRAY['anon', 'authenticated']) as role,
               unnest(ARRAY['audit_events', 'audit_chain_heads']) as table_name
      ) t
      ORDER BY table_name, role;
    `;
    console.table(privs);

    const tablePrivs = await sql`
      SELECT 
        grantee,
        table_name,
        string_agg(privilege_type, ', ' ORDER BY privilege_type) as privileges
      FROM information_schema.role_table_grants
      WHERE table_name IN ('audit_events', 'audit_chain_heads')
      GROUP BY grantee, table_name
      ORDER BY table_name, grantee;
    `;
    console.log("\n=== 4. ROLE_TABLE_GRANTS ===");
    console.table(tablePrivs);

  } finally {
    await sql.end();
  }
}

main().catch(console.error);
