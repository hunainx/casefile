import type { Sql, TransactionSql, JSONValue, Parameter } from "postgres";

/**
 * A value for a jsonb column (FIXES-1, DEV-031).
 *
 * postgres.js serialises a jsonb parameter itself, so passing `JSON.stringify(x)` (with or without
 * `::jsonb`) stored a JSON *string* holding the text: `jsonb_typeof` was `string` and
 * `metadata->>'source_path'` was NULL. This passes the value itself, so it is stored as a JSON
 * object.
 *
 * One exception, found by measuring (captures/fixes1/jsonb-edge-probe.txt): jsonb refuses a string
 * containing U+0000 or an unpaired UTF-16 surrogate, which the old string form stored without
 * complaint. Such a value is still stored the old way (its JSON text), losslessly, instead of
 * failing the write. Every reader of these columns takes both forms, and the audit chain hashes the
 * parsed value either way (packages/audit/src/hasher.ts parseJsonField), so nothing is lost.
 */
export function jsonb(sql: Sql | TransactionSql, value: unknown): Parameter | string {
  return storableInJsonb(value) ? sql.json(value as JSONValue) : JSON.stringify(value);
}

const NUL = String.fromCharCode(0);
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const unstorable = (s: string) => s.includes(NUL) || UNPAIRED_SURROGATE.test(s);

/** False when any key or string in the value holds U+0000 or an unpaired surrogate. */
export function storableInJsonb(value: unknown): boolean {
  if (typeof value === "string") return !unstorable(value);
  if (Array.isArray(value)) return value.every(storableInJsonb);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([k, v]) => !unstorable(k) && storableInJsonb(v));
  }
  return true;
}

/** A jsonb value as read back: the object for new rows, the parsed text for old rows (DEV-031). */
export function readJsonb<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}
