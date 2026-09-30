import { describe, it, expect, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@casefile/db";
import { BAND_LOOKUP } from "../src/near-duplicate-pass.js";
import { newMatter, q } from "./helpers/run-outcomes.js";

/**
 * BIGDATA-4: the near-duplicate pass finds a batch's candidates by band key. It runs as the app role, where
 * row-level security is forced, and there Postgres uses an index only for a condition built from leakproof
 * operators: the array operators (`&&`, `@>`) are not, so a GIN index on an array of keys is never used under
 * RLS and every lookup reads every row of the matter (0.5 to 1.1 s a batch at 25,000 documents, measured; the
 * 10 GB run slowed down as the matter grew). Tested as the app role, inside withTenant, on a matter with
 * 100,000 band rows (analysed, so the planner knows the matter's range is large; 25,000 documents make about
 * 800,000) and one document's 32 keys, with sequential scans switched off: the lookup must have the band key in
 * an index condition (a filter over the matter's range is not enough).
 */
const BASE = join(process.cwd(), ".tmp-test-fixtures", `near-duplicate-lookup_${Date.now()}`);

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

function nodes(n: PlanNode): PlanNode[] {
  return [n, ...(n.Plans ?? []).flatMap(nodes)];
}

describe("tools/ingest-cli — BIGDATA-4 near-duplicate band lookup under row-level security", () => {
  it("looks the band keys up through an index, as the app role", async () => {
    const m = await newMatter("band-lookup", BASE);
    await q(m.tenantId, (tx) => tx`
      INSERT INTO document_lsh_bands (tenant_id, investigation_id, band_key, root_source_id)
      SELECT ${m.tenantId}, ${m.investigationId}, ((g % 32)::bigint << 48) + g, gen_random_uuid() FROM generate_series(1, 100000) AS g`);
    const owner = createDbClient(process.env.DATABASE_URL_TEST_OWNER!, { max: 1 });
    try {
      await owner`ANALYZE document_lsh_bands`;
    } finally {
      await owner.end();
    }
    const keys = Array.from({ length: 32 }, (_, i) => String((BigInt(i) << 48n) + BigInt(i * 3001 + i)));
    const plan = await q(m.tenantId, async (tx) => {
      const who = await tx<{ role: string; bypass: boolean }[]>`SELECT current_user AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
      expect(who[0]).toEqual({ role: "casefile_app", bypass: false });
      await tx`SET LOCAL enable_seqscan = off`;
      const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${BAND_LOOKUP}`, [m.tenantId, m.investigationId, keys]);
      return rows[0]!["QUERY PLAN"][0]!.Plan;
    });
    const scans = nodes(plan).filter((n) => n["Relation Name"]?.startsWith("document_lsh"));
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans) expect(s["Index Cond"] ?? "", `${s["Node Type"]} on ${s["Relation Name"]}`).toMatch(/band/);
  });
});
