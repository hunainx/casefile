import { describe, it, expect } from "vitest";
import { insertBatches, INSERT_BATCH_MAX_BYTES, INSERT_BATCH_MAX_ROWS } from "../src/batch-insert.js";

/**
 * How the ingest splits a document's text rows into multi-row INSERTs (D89). No database: the
 * INSERTs themselves run as the first query of a new client in
 * packages/db/test/array-params-first-query.integration.test.ts, and the whole ingest is compared
 * row by row with the one-row-per-INSERT code in the BIGDATA-2A capture.
 */
describe("tools/ingest-cli batch-insert: insertBatches", () => {
  const ALLOWED_SIZES = new Set([1000, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
  const sizes = (n: number, bytes = () => 10) => insertBatches(Array.from({ length: n }, (_, i) => i), bytes).map((b) => b.length);

  it("full batches of 1,000 rows; the rest as power-of-two pieces, largest first", () => {
    expect(sizes(0)).toEqual([]);
    expect(sizes(1)).toEqual([1]);
    expect(sizes(1000)).toEqual([1000]);
    expect(sizes(1001)).toEqual([1000, 1]);
    expect(sizes(2537)).toEqual([1000, 1000, 512, 16, 8, 1]);
    expect(sizes(999)).toEqual([512, 256, 128, 64, 32, 4, 2, 1]);
  });

  it("keeps every row, once, in order, and never uses a size outside the 11 shapes", () => {
    for (let n = 0; n <= 3001; n++) {
      const rows = Array.from({ length: n }, (_, i) => i);
      const batches = insertBatches(rows, () => 10);
      expect(batches.flat()).toEqual(rows);
      for (const b of batches) expect(ALLOWED_SIZES.has(b.length), `n=${n}: batch of ${b.length}`).toBe(true);
    }
  });

  it("closes a batch before it passes about 8 MB, and sends a larger single row alone", () => {
    const threeMb = 3 * 1024 * 1024;
    expect(sizes(5, () => threeMb)).toEqual([2, 2, 1]);
    expect(sizes(3, () => INSERT_BATCH_MAX_BYTES + 1)).toEqual([1, 1, 1]);
    // 1,000 rows of 10 KB are 10 MB: the byte limit closes the first batch at 838 rows (8 MB / 10 KB).
    const b = insertBatches(Array.from({ length: INSERT_BATCH_MAX_ROWS }, (_, i) => i), () => 10_000);
    expect(b.flat().length).toBe(INSERT_BATCH_MAX_ROWS);
    expect(b.map((x) => x.length)).toEqual([512, 256, 64, 4, 2, 128, 32, 2]);
  });
});
