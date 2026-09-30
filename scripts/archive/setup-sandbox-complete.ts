import { execSync } from "node:child_process";
import crypto from "node:crypto";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

function generateSafePassword(length = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!_-^.~$";
  let pwd = "";
  const bytes = crypto.randomBytes(length * 2);
  for (let i = 0; i < bytes.length && pwd.length < length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      const idx = byte % chars.length;
      const ch = chars[idx];
      if (ch) pwd += ch;
    }
  }
  return pwd;
}

import { matterConfig } from "../../matter.config.js";

// Read from the environment only; the file holds no value: SUPABASE_ACCESS_TOKEN, SUPABASE_ORG_ID.
const SUPABASE_TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";
const ORG_ID = process.env.SUPABASE_ORG_ID ?? "";
if (!SUPABASE_TOKEN || !ORG_ID) {
  console.error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_ORG_ID in the environment first.");
  process.exit(1);
}
const REGION = matterConfig.supabaseRegion || "<SUPABASE_REGION>";
const PROJECT_NAME = process.argv[2] ? `casefile-${process.argv[2]}` : `casefile-${matterConfig.matterSlug}`;

async function main() {
  console.log("=== Step 2a: Generating DB Passwords ===");
  const ownerPassword = generateSafePassword(24);
  const appPassword = generateSafePassword(24);

  console.log(`Generated owner password ending in: ...${ownerPassword.slice(-4)}`);
  console.log(`Generated app password ending in:   ...${appPassword.slice(-4)}`);

  // Write passwords immediately
  const credsDir = path.resolve(import.meta.dirname, "../scratch");
  if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });
  fs.writeFileSync(
    path.join(credsDir, "sandbox-creds.json"),
    JSON.stringify({ ownerPassword, appPassword }, null, 2),
    "utf8"
  );

  console.log(`\n=== Step 2b: Creating Supabase Project ${PROJECT_NAME} in ${REGION} ===`);
  const createCmd = `npx supabase projects create ${PROJECT_NAME} --org-id ${ORG_ID} --region ${REGION} --db-password "${ownerPassword}" --output json`;
  const createOutput = execSync(createCmd, {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: SUPABASE_TOKEN },
    encoding: "utf8",
  });
  
  const jsonStart = createOutput.indexOf("{");
  const created = JSON.parse(createOutput.slice(jsonStart));
  const projectRef = created.id || created.ref;
  console.log(`Created Project Ref: ${projectRef}`);

  const supabaseUrl = `https://${projectRef}.supabase.co`;

  console.log("\n=== Step 2c: Fetching API Keys via CLI ===");
  let keysOutput = "";
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      keysOutput = execSync(
        `npx supabase projects api-keys --project-ref ${projectRef} --reveal --output json`,
        {
          env: { ...process.env, SUPABASE_ACCESS_TOKEN: SUPABASE_TOKEN },
          encoding: "utf8",
        }
      );
      if (keysOutput.includes("anon") || keysOutput.includes("service")) {
        break;
      }
    } catch {
      console.log(`[Keys attempt ${attempt}] waiting...`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  interface SupabaseApiKey {
    name?: string;
    tags?: string;
    api_key?: string;
    key?: string;
  }
  const keysStart = keysOutput.indexOf("[");
  const keys = JSON.parse(keysOutput.slice(keysStart)) as SupabaseApiKey[];
  const anonKeyObj = keys.find((k) => k.name === "anon" || k.tags === "anon");
  const serviceKeyObj = keys.find((k) => k.name?.startsWith("service") || k.tags?.startsWith("service"));

  const anonKey = anonKeyObj ? (anonKeyObj.api_key || anonKeyObj.key) : "";
  const serviceKey = serviceKeyObj ? (serviceKeyObj.api_key || serviceKeyObj.key) : "";

  console.log(`Project URL: ${supabaseUrl}`);
  console.log(`Anon Key present: ${Boolean(anonKey)}`);
  console.log(`Admin Secret Key present: ${Boolean(serviceKey)}`);

  const encodedOwnerPassword = encodeURIComponent(ownerPassword);
  const encodedAppPassword = encodeURIComponent(appPassword);

  const ownerPoolerUrl = `postgresql://postgres.${projectRef}:${encodedOwnerPassword}@aws-0-${REGION}.pooler.supabase.com:5432/postgres`;
  const appPoolerUrl = `postgresql://casefile_app.${projectRef}:${encodedAppPassword}@aws-0-${REGION}.pooler.supabase.com:5432/postgres`;

  console.log("\n=== Step 2d: Waiting for Database to accept connections ===");
  let sql: postgres.Sql | null = null;
  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      sql = postgres(ownerPoolerUrl, { max: 1, connect_timeout: 8 });
      await sql`SELECT 1 as healthy`;
      console.log(`Database connected on attempt ${attempt}`);
      break;
    } catch (err: unknown) {
      console.log(`[DB attempt ${attempt}] not ready yet: ${(err as Error).message}`);
      if (sql) await sql.end({ timeout: 1 }).catch(() => {});
      sql = null;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (!sql) {
    throw new Error("Could not connect to database with owner credentials");
  }

  console.log("\n=== Step 2e: Enabling extensions vector and pg_trgm ===");
  await sql`CREATE EXTENSION IF NOT EXISTS vector;`;
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm;`;

  const exts = await sql<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')`;
  console.log("Verified installed extensions:", exts.map((e) => e.extname));

  console.log("\n=== Step 2f: Creating application role casefile_app ===");
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'casefile_app') THEN
        CREATE ROLE casefile_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}';
      ELSE
        ALTER ROLE casefile_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}';
      END IF;
    END
    $$;
  `);

  await sql`GRANT CONNECT ON DATABASE postgres TO casefile_app;`;
  await sql`GRANT USAGE ON SCHEMA public TO casefile_app;`;
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO casefile_app;`;
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO casefile_app;`;
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO casefile_app;`;

  // Verify public schema is empty before migration
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public';
  `;
  console.log("Public schema table count before migration:", tables.length);

  await sql.end();

  // Save complete credentials
  fs.writeFileSync(
    path.join(credsDir, "sandbox-creds.json"),
    JSON.stringify(
      {
        projectRef,
        region: REGION,
        ownerPassword,
        appPassword,
        ownerPoolerUrl,
        appPoolerUrl,
        supabaseUrl,
        anonKey,
        serviceKey,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("\n✓ Sandbox project creation & configuration COMPLETE!");
  console.log(`Project Ref: ${projectRef}`);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
