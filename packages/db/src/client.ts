import postgres, { type Sql } from "postgres";

let defaultClient: Sql | null = null;

/**
 * Resolves the database URL from the environment. No literal fallback: a connection
 * string carries credentials, and a default here meant code could run against a
 * database nobody had pointed it at. Tests set DATABASE_URL_TEST in the vitest configs
 * (CI overrides it); the API requires DATABASE_URL (see config/required-secrets.ts).
 */
export function getDbUrl(): string {
  const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const name = isTest ? "DATABASE_URL_TEST" : "DATABASE_URL";
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set. Refusing to guess a database connection string.`);
  }
  return value;
}

export function createDbClient(url?: string, options: Record<string, unknown> = {}): Sql {
  const dbUrl = url || getDbUrl();
  return postgres(dbUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ...options,
  });
}

export function getDb(): Sql {
  if (!defaultClient) {
    defaultClient = createDbClient();
  }
  return defaultClient;
}

export async function closeDb(): Promise<void> {
  if (defaultClient) {
    await defaultClient.end();
    defaultClient = null;
  }
}
