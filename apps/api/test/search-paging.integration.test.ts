import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { SearchRequestSchema } from "@casefile/contracts";
import { handleSearch, SearchToolSchema } from "@casefile/mcp";
import { executeSearch } from "../src/services/search-engine.js";
import type postgres from "postgres";

/**
 * BIGDATA-2B (D97): paging through search returns every hit exactly once.
 *
 * Both searches ordered by created_at alone, and every chunk one file writes shares its
 * transaction's created_at (DEV-032). When Postgres runs the query with parallel workers (it did on
 * the 100 MB corpus once the text-once join was added, and would on a large matter without it), the
 * order of those ties changes from one call to the next, so offset paging repeated some hits and
 * skipped others (captures/bigdata2b: 4,934 hits paged, 4,694 distinct). A unique tie-breaker (the
 * chunk id) fixes the order of ties within one database; which order that is stays arbitrary, and a
 * meaningful order is for the search-at-scale track.
 *
 * The test puts 3,000 chunks of about 2 KB in one transaction (one created_at), so the scan spans
 * hundreds of pages, forces parallel plans, and checks that the plan really is parallel.
 */
describe("apps/api — paging through search returns every hit exactly once (BIGDATA-2B)", () => {
  let sql: postgres.Sql;
  const T = randomUUID(), WS = randomUUID(), INV = randomUUID(), U = randomUUID(), SRC = randomUUID(), ART = randomUUID(), DOC = randomUUID();
  const N = 3000;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    await withTenant(T, async (tx) => {
      await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Paging Fake Org')`;
      await tx`INSERT INTO workspaces (id, tenant_id, name) VALUES (${WS}, ${T}, 'Paging WS')`;
      await tx`INSERT INTO users (id, tenant_id, email, name) VALUES (${U}, ${T}, 'paging@test.local', 'Paging')`;
      await tx`INSERT INTO investigations (id, tenant_id, workspace_id, name, stage, created_by) VALUES (${INV}, ${T}, ${WS}, 'Paging', 'collecting', ${U})`;
      await tx`INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, status, source_class, created_by)
               VALUES (${SRC}, ${T}, ${WS}, ${INV}, 'paging.txt', 'text/plain', 1, ${"b".repeat(64)}, 'gcs://casefile-localtest-sources/paging', 'indexed', 'primary_record', ${U})`;
      await tx`INSERT INTO artifacts (id, tenant_id, source_id, kind, storage_uri) VALUES (${ART}, ${T}, ${SRC}, 'primary', 'gcs://casefile-localtest-sources/paging')`;
      await tx`INSERT INTO content_documents (id, tenant_id, artifact_id, doc_type) VALUES (${DOC}, ${T}, ${ART}, 'document')`;
      const rows = Array.from({ length: N }, (_, i) => ({
        id: randomUUID(), tenant_id: T, investigation_id: INV, content_document_id: DOC, block_ids: [] as string[],
        text: `Fake paging line ${i} about the Quellmoor escrow. ${"Filler words for a longer row. ".repeat(60)}`, token_count: 10,
      }));
      for (let i = 0; i < N; i += 500) await tx`INSERT INTO chunks ${tx(rows.slice(i, i + 500), "id", "tenant_id", "investigation_id", "content_document_id", "block_ids", "text", "token_count")}`;
    }, sql);
    // Fresh statistics, so the planner sees the rows and can choose a parallel plan (owner only).
    const owner = createDbClient(process.env.DATABASE_URL_TEST_OWNER!, { max: 1 });
    await owner`ANALYZE chunks, content_blocks, content_documents, artifacts, sources`;
    await owner.end();
  }, 60_000);

  afterAll(async () => {
    await sql.end();
  });

  /** Runs `fn` in a transaction that forces parallel plans whenever Postgres can use one. */
  const parallel = <R,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<R>) =>
    withTenant(T, async (tx) => {
      await tx`SET LOCAL parallel_setup_cost = 0`;
      await tx`SET LOCAL parallel_tuple_cost = 0`;
      await tx`SET LOCAL min_parallel_table_scan_size = 0`;
      await tx`SET LOCAL max_parallel_workers_per_gather = 4`;
      return fn(tx);
    }, sql);

  it("both searches order ties by a unique key (the SQL they send)", async () => {
    // Recorded from the driver itself, so this sees the statements as Postgres receives them.
    const sent: string[] = [];
    const rec = createDbClient(getDbUrl(), { max: 1, debug: (_c: number, q: string) => sent.push(q.replace(/\s+/g, " ")) });
    try {
      await withTenant(T, (tx) => handleSearch(tx, { tenantId: T, investigationId: INV, userId: U, roles: ["lead_inv"] }, SearchToolSchema.parse({ query: "Quellmoor", limit: 1 })), rec);
      await withTenant(T, (tx) => executeSearch(tx, T, INV, U, SearchRequestSchema.parse({ query: "Quellmoor", mode: "keyword", limit: 1 })), rec);
    } finally {
      await rec.end();
    }
    const searches = sent.filter((q) => /FROM chunks c/.test(q) && /ORDER BY/.test(q));
    expect(searches.length).toBe(2);
    for (const q of searches) expect(q, q.slice(-200)).toMatch(/ORDER BY c\.created_at DESC, c\.id\b/);
  });

  // Passes before and after the tie-breaker at this size (3,000 ties): it guards the behaviour,
  // the test above tells the two apart. The 100 MB capture is where the old order failed.
  // BIGDATA-3: index and bitmap scans are off for this plan check only. Whether the planner picks a
  // parallel plan depends on what the other test files left in the shared test database: in
  // BIGDATA-3's first verify run there were 38,033 chunks of 32 tenants, it multiplied the tenant and
  // investigation selectivities as if independent, estimated 599 of these 3,000 rows and chose an
  // index scan (captures/bigdata3/red-green/09-*). Turning index scans off for the whole paging tests
  // made them time out (red-green/10-attempt1-*), so this check shows that the query CAN run with
  // parallel workers on this data; the SQL-order test above is the one that tells old and new apart.
  it("the query can run with parallel workers here", async () => {
    const plan = await parallel(async (tx) => {
      await tx`SET LOCAL enable_indexscan = off`;
      await tx`SET LOCAL enable_indexonlyscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      return tx<{ "QUERY PLAN": string }[]>`
        EXPLAIN SELECT c.id FROM chunks c WHERE c.investigation_id = ${INV} AND c.tenant_id = ${T} ORDER BY c.created_at DESC`;
    });
    expect(plan.map((r) => r["QUERY PLAN"]).join(" | ")).toMatch(/Gather/);
  });

  it("MCP search, 100 per page", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < N; offset += 100) {
      const page = await parallel((tx) => handleSearch(tx, { tenantId: T, investigationId: INV, userId: U, roles: ["lead_inv"] }, SearchToolSchema.parse({ query: "Quellmoor", limit: 100, offset })));
      seen.push(...page.items.map((i) => (i as { chunk_id: string }).chunk_id));
    }
    expect(seen.length).toBe(N);
    expect(new Set(seen).size).toBe(N);
  }, 120_000);

  it("REST search engine, 100 per page", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < N; offset += 100) {
      const page = await parallel((tx) => executeSearch(tx, T, INV, U, SearchRequestSchema.parse({ query: "Quellmoor", mode: "keyword", limit: 100, offset, collapse_near_duplicates: false })));
      seen.push(...page.items.map((i) => i.chunk_id));
    }
    expect(seen.length).toBe(N);
    expect(new Set(seen).size).toBe(N);
  }, 120_000);
});
