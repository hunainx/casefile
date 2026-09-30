import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, "../migrations");

// Load .env if present
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

export interface MigrateOptions {
  dbUrl?: string | undefined;
  migrationsDir?: string | undefined;
  projectRef?: string | undefined;
}

export function extractProjectRef(dbUrl: string): string | null {
  try {
    const parsed = new URL(dbUrl);
    // 1. Hostname is db.<ref>.supabase.co or <ref>.supabase.co
    const hostParts = parsed.hostname.split(".");
    if (
      hostParts.length >= 3 &&
      hostParts[hostParts.length - 2] === "supabase" &&
      hostParts[hostParts.length - 1] === "co"
    ) {
      const part = hostParts[0];
      return part === "db" ? (hostParts[1] ?? null) : (part ?? null);
    }
    // 2. Pooler URL where username is <role>.<ref>
    const username = decodeURIComponent(parsed.username);
    const dotIdx = username.lastIndexOf(".");
    if (dotIdx !== -1) {
      return username.slice(dotIdx + 1);
    }
    // 3. Local database
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return "local";
    }
    return null;
  } catch {
    return null;
  }
}

export async function preflightGuard(
  sql: postgres.Sql,
  dbUrl: string,
  providedRef: string | undefined,
  migrationsDir: string
): Promise<{
  targetHost: string;
  projectRef: string;
  tableCount: number;
  hasSchemaMigrations: boolean;
  appliedVersions: string[];
}> {
  // Check (a): Project ref required and matched
  if (!providedRef) {
    throw new Error(
      "ABORT: Missing required argument --project-ref <ref>.\n" +
      "To prevent accidental migrations against foreign databases, the target project ref must be explicitly specified."
    );
  }

  const extractedRef = extractProjectRef(dbUrl);
  if (!extractedRef) {
    const masked = dbUrl.replace(/:[^:@]+@/, ":***@");
    throw new Error(
      `ABORT: Could not determine project ref from DATABASE_URL (${masked}).\n` +
      "Refusing to migrate an unrecognized database URL format."
    );
  }

  if (providedRef !== extractedRef) {
    throw new Error(
      `ABORT: Project ref mismatch!\n` +
      `  Provided argument:    ${providedRef}\n` +
      `  Extracted from dbUrl: ${extractedRef}\n` +
      "A wrong .env or target must not be able to silently redirect a migration. Aborting."
    );
  }

  const targetHost = new URL(dbUrl).hostname;

  // Check (d): Query existing public table count and check schema_migrations existence
  const countRows = await sql<{ count: number }[]>`
    SELECT count(*)::int as count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  `;
  const tableCount = Number(countRows[0]?.count ?? 0);

  console.log("=== Pre-flight Migration Guard ===");
  console.log(`Target host:        ${targetHost}`);
  console.log(`Project ref:        ${extractedRef}`);
  console.log(`Public table count: ${tableCount}`);

  const regRows = await sql<{ reg: string | null }[]>`
    SELECT to_regclass('public.schema_migrations')::text as reg;
  `;
  const hasSchemaMigrations = Boolean(regRows[0]?.reg);

  // Check (c): If public contains any table but schema_migrations is absent, ABORT.
  if (tableCount > 0 && !hasSchemaMigrations) {
    throw new Error(
      `ABORT: Target database public schema contains ${tableCount} table(s), but schema_migrations is absent!\n` +
      "A non-empty schema with no history of ours is someone else's database. Refusing to run."
    );
  }

  // Check (b): Read schema_migrations. If it contains entries whose filenames are not in packages/db/migrations, ABORT and print them.
  let appliedVersions: string[] = [];
  if (hasSchemaMigrations) {
    try {
      const rows = await sql<{ version: string }[]>`
        SELECT version FROM public.schema_migrations ORDER BY version ASC;
      `;
      appliedVersions = rows.map((r) => r.version);
    } catch (err: unknown) {
      const errorObj = err as { code?: string; message?: string };
      if (errorObj.code === "42501" && process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
        // Fallback to service role REST API query if connected as unprivileged app user (permitted caller per D45)
        const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/schema_migrations?select=version&order=version.asc`, {
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          },
        });
        if (res.ok) {
          const rows = (await res.json()) as { version: string }[];
          appliedVersions = rows.map((r) => r.version);
        } else {
          throw new Error(`Failed to query schema_migrations via Supabase REST API: ${res.statusText}`, { cause: err });
        }
      } else {
        throw err;
      }
    }

    const knownFiles = new Set(
      readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
    );

    const foreignEntries = appliedVersions.filter((v) => !knownFiles.has(v));
    if (foreignEntries.length > 0) {
      console.error(`\nABORT: schema_migrations contains ${foreignEntries.length} foreign/unknown migration(s) not present in packages/db/migrations:`);
      for (const f of foreignEntries) {
        console.error(`  - ${f}`);
      }
      throw new Error(
        `ABORT: Database contains foreign migration history (${foreignEntries.length} unknown migrations). Refusing to migrate.`
      );
    }

    console.log(`History check:      ${appliedVersions.length} applied migration(s) verified against packages/db/migrations (0 foreign)`);
  } else {
    console.log(`History check:      Clean database (no prior schema_migrations)`);
  }

  console.log("Pre-flight check:   PASSED — proceeding with migration.\n");

  return {
    targetHost,
    projectRef: extractedRef,
    tableCount,
    hasSchemaMigrations,
    appliedVersions,
  };
}

async function verifyTableOwnershipForMigration(
  sql: postgres.Sql,
  file: string,
  content: string
): Promise<void> {
  const alterRegex = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi;
  const tablesToAlter = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = alterRegex.exec(content)) !== null) {
    const matchedTable = match[1];
    if (matchedTable) {
      tablesToAlter.add(matchedTable);
    }
  }

  if (tablesToAlter.size === 0) return;

  const roleInfo = await sql<{ current_user: string; is_superuser: boolean }[]>`
    SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) as is_superuser;
  `;
  const currentUser = roleInfo[0]?.current_user;
  const isSuperuser = Boolean(roleInfo[0]?.is_superuser);

  if (isSuperuser || !currentUser) return;

  for (const table of tablesToAlter) {
    const tableInfo = await sql<{ tableowner: string }[]>`
      SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = ${table};
    `;
    if (tableInfo.length > 0 && tableInfo[0]?.tableowner) {
      const owner = tableInfo[0].tableowner;
      if (currentUser !== owner) {
        const roleMember = await sql<{ is_member: boolean }[]>`
          SELECT pg_has_role(${currentUser}, ${owner}, 'MEMBER') as is_member;
        `;
        if (!roleMember[0]?.is_member) {
          throw new Error(
            `ABORT: Connecting role '${currentUser}' is not the owner of table '${table}' (owner is '${owner}').\n` +
            `Cannot apply migration '${file}' because ALTER TABLE on '${table}' requires table owner privileges.\n` +
            `Ensure DATABASE_URL_MIGRATIONS is configured with owner credentials.`
          );
        }
      }
    }
  }
}

export async function migrate(options: MigrateOptions = {}) {
  // Migration runner connects with owner / admin credentials via DATABASE_URL_MIGRATIONS per D45.
  // No literal fallback (REQ-M-SEC-017): a connection string carries credentials, and a
  // default here meant the migrator could run against a database nobody had named.
  const dbUrl =
    options.dbUrl ||
    process.env.DATABASE_URL_MIGRATIONS ||
    process.env.DATABASE_URL_TEST_OWNER ||
    process.env.DATABASE_URL_OWNER ||
    process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "No database URL for migrations: pass dbUrl or set DATABASE_URL_MIGRATIONS (owner), DATABASE_URL_TEST_OWNER, DATABASE_URL_OWNER, or DATABASE_URL.",
    );
  }

  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;

  const isCli = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
  let projectRef = options.projectRef;
  if (!projectRef && !isCli && extractProjectRef(dbUrl) === "local") {
    projectRef = "local";
  }

  const sql = postgres(dbUrl, { max: 1 });

  try {
    const preflight = await preflightGuard(sql, dbUrl, projectRef, migrationsDir);

    if (!preflight.hasSchemaMigrations) {
      await sql`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `;
    }

    const appliedSet = new Set(preflight.appliedVersions);

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let newCount = 0;
    for (const file of files) {
      if (!appliedSet.has(file)) {
        const filePath = resolve(migrationsDir, file);
        const content = readFileSync(filePath, "utf8");

        // Pre-check table ownership before attempting DDL (Rule 1b)
        await verifyTableOwnershipForMigration(sql, file, content);

        console.log(`Applying migration: ${file}...`);
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(content);
            await tx`
              INSERT INTO schema_migrations (version) VALUES (${file});
            `;
          });
          appliedSet.add(file);
          newCount++;
        } catch (err: unknown) {
          console.error(`\nFAILED to apply migration '${file}':`);
          console.error(err instanceof Error ? err.message : String(err));
          throw new Error(`Migration execution halted at '${file}'. Database migration aborted.`, { cause: err });
        }
      }
    }

    if (newCount === 0) {
      console.log("Database schema is up to date. No new migrations needed.");
    } else {
      console.log(`Successfully applied ${newCount} migration(s).`);
    }
  } finally {
    await sql.end();
  }
}

function parseCliArgs(): { projectRef?: string | undefined; migrationsDir?: string | undefined } {
  const args = process.argv.slice(2);
  let projectRef: string | undefined;
  let migrationsDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--project-ref" && i + 1 < args.length) {
      projectRef = args[i + 1];
      i++;
    } else if (arg.startsWith("--project-ref=")) {
      projectRef = arg.slice("--project-ref=".length);
    } else if (arg === "--migrations-dir" && i + 1 < args.length) {
      migrationsDir = args[i + 1];
      i++;
    } else if (arg.startsWith("--migrations-dir=")) {
      migrationsDir = arg.slice("--migrations-dir=".length);
    }
  }

  return { projectRef, migrationsDir };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cliArgs = parseCliArgs();
  migrate({ projectRef: cliArgs.projectRef, migrationsDir: cliArgs.migrationsDir })
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n" + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    });
}
