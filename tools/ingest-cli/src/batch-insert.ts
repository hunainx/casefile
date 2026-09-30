import type { Sql, TransactionSql } from "postgres";

/** A client or a transaction: the tagged template and the row helper are all these functions use. */
type Queryable = Sql | TransactionSql;

/**
 * Multi-row INSERTs for the text rows of a document (BIGDATA-2A, D89; docs/PLAN-BIG-DATA.md §1).
 *
 * One INSERT per row cost one database round trip per row: 977,929 content_blocks and as many
 * chunks for 1 GB of the fake corpus, 75% of the ingest time (BIGDATA-1 baseline). These rows now
 * go in as multi-row INSERTs built with the postgres.js row helper `sql(rows, ...columns)` —
 * never `sql.array()`, which is banned (D68, guardrails/no-sql-array.spec.ts). The block_ids
 * array of a chunk is a plain JS array inside the row, typed by the server's description of the
 * statement; packages/db/test/array-params-first-query.integration.test.ts runs both INSERTs as
 * the first query of a new client.
 *
 * A batch holds at most INSERT_BATCH_MAX_ROWS rows or about INSERT_BATCH_MAX_BYTES of row data,
 * whichever comes first. A batch that is not a full 1,000 rows is sent as power-of-two pieces
 * (512, 256, ... 1): every distinct row count is its own prepared statement, which Postgres keeps
 * for the life of the connection, and 100 distinct sizes held 151 MB of plan cache in one
 * backend (measured; the 11 shapes used here hold 5.9 MB).
 */
export const INSERT_BATCH_MAX_ROWS = 1000;
export const INSERT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

/** Splits `rows`, in order, into the batches described above. */
export function insertBatches<T>(rows: readonly T[], bytesOf: (row: T) => number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length === INSERT_BATCH_MAX_ROWS) {
      batches.push(current);
    } else {
      let start = 0;
      for (let size = 512; size >= 1; size >>= 1) {
        if (current.length - start >= size) {
          batches.push(current.slice(start, start + size));
          start += size;
        }
      }
    }
    current = [];
    bytes = 0;
  };
  for (const row of rows) {
    const b = bytesOf(row);
    if (current.length > 0 && (current.length === INSERT_BATCH_MAX_ROWS || bytes + b > INSERT_BATCH_MAX_BYTES)) flush();
    current.push(row);
    bytes += b;
  }
  if (current.length > 0) flush();
  return batches;
}

export interface ContentBlockRow {
  id: string;
  tenant_id: string;
  content_document_id: string;
  sequence: number;
  block_type: string;
  section_path: string | null;
  page: number | null;
  char_start: number;
  char_end: number;
  text: string;
  language: string;
  ocr_confidence: number | null;
  created_by: string;
}

export interface ChunkRow {
  id: string;
  tenant_id: string;
  investigation_id: string;
  content_document_id: string;
  block_ids: string[];
  char_start: number;
  char_end: number;
  /** NULL when the chunk is exactly its one block (text stored once, D94). */
  text: string | null;
  contextual_header: string;
  token_count: number;
  doc_type: string;
  created_by: string;
}

const BLOCK_COLUMNS = [
  "id", "tenant_id", "content_document_id", "sequence", "block_type", "section_path", "page",
  "char_start", "char_end", "text", "language", "ocr_confidence", "created_by",
] as const satisfies readonly (keyof ContentBlockRow)[];

const CHUNK_COLUMNS = [
  "id", "tenant_id", "investigation_id", "content_document_id", "block_ids", "char_start", "char_end",
  "text", "contextual_header", "token_count", "doc_type", "created_by",
] as const satisfies readonly (keyof ChunkRow)[];

/** About how many bytes a row puts on the wire: its text plus a fixed allowance for the rest. */
const ROW_OVERHEAD_BYTES = 256;

/** Inserts content_blocks rows in multi-row batches; returns the number of INSERT statements sent. */
export async function insertContentBlockRows(sql: Queryable, rows: readonly ContentBlockRow[]): Promise<number> {
  const batches = insertBatches(rows, (r) => Buffer.byteLength(r.text) + Buffer.byteLength(r.section_path ?? "") + ROW_OVERHEAD_BYTES);
  for (const batch of batches) {
    await sql`INSERT INTO content_blocks ${sql(batch, ...BLOCK_COLUMNS)}`;
  }
  return batches.length;
}

/** Inserts chunks rows in multi-row batches; returns the number of INSERT statements sent. */
export async function insertChunkRows(sql: Queryable, rows: readonly ChunkRow[]): Promise<number> {
  const batches = insertBatches(rows, (r) => Buffer.byteLength(r.text ?? "") + Buffer.byteLength(r.contextual_header) + ROW_OVERHEAD_BYTES);
  for (const batch of batches) {
    await sql`INSERT INTO chunks ${sql(batch, ...CHUNK_COLUMNS)}`;
  }
  return batches.length;
}
