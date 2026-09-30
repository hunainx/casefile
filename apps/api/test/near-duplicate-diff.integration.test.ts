import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { buildApp } from "../src/app.js";

/**
 * FIXES-1 C, DEV-035. The REST upload wrote a near_duplicate_clusters row, with a fixed similarity
 * of 0.94 and an invented diff ("Clause 9.3 ... Net 30 ..."), whenever an indexed source's filename
 * contained "v1" and the new one's "v2"; the diff route returned the same invented diff when there
 * was no row. Now the upload writes nothing there, and the diff route compares the two documents'
 * own text: the similarity is the exact Jaccard similarity of their 5-word shingles (the measure
 * the ingest's near-duplicate rule estimates, D101) and the diff lists real lines. Rows already in
 * near_duplicate_clusters stay as they are; the route no longer reads them.
 */
describe("FIXES-1 C — DEV-035: no invented near-duplicate pairs; the diff route compares real text", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let investigationId: string;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });

  const words = Array.from({ length: 80 }, (_, i) => `fake${(i * 7919) % 1013}`);
  const BASE = [words.slice(0, 40).join(" "), words.slice(40).join(" ")].join("\n");
  const EDITED = [words.slice(0, 40).join(" "), [...words.slice(40, 79), "changedword"].join(" ")].join("\n");

  const upload = async (filename: string, raw_text: string) => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: auth(),
      payload: { filename, mime_type: "text/plain", raw_text, acquisition_record: { origin: "Fake", custodian: "Fake" } },
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body).id as string;
  };
  const diff = async (a: string, b: string) => {
    const res = await app.inject({ method: "GET", url: `/v1/investigations/${investigationId}/sources/${a}/diff/${b}`, headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as { source_a_id: string; source_b_id: string; similarity_score: number; diff_summary: { added_lines: string[]; removed_lines: string[]; changed_clauses: string[] } };
  };
  const clusters = () => withTenant(tenantId, (tx) => tx<{ id: string; similarity_score: string; diff_summary: unknown }[]>`
    SELECT id, similarity_score, diff_summary FROM near_duplicate_clusters WHERE investigation_id = ${investigationId} ORDER BY id`, sql);

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `near-dup-diff-${Date.now()}@casefile.test`;
    const password = "NearDupDiff123!";
    const reg = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Near Dup Diff", orgName: "Near Dup Diff Fake Org" } })).body);
    tenantId = reg.user.tenantId;
    token = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } })).body).accessToken;
    const ws = JSON.parse((await app.inject({ method: "POST", url: "/v1/workspaces", headers: auth(), payload: { name: "Near Dup Diff WS" } })).body);
    investigationId = JSON.parse((await app.inject({ method: "POST", url: "/v1/investigations", headers: auth(), payload: { workspace_id: ws.id, name: "Near Dup Diff", objective: "FIXES-1 C" } })).body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("uploading a v1 and a v2 writes no near_duplicate_clusters row", async () => {
    await upload("Fake_Contract_v1.txt", "Fake clause one: the fake goods ship on Monday.");
    await upload("Fake_Contract_v2.txt", "Fake clause one: the fake goods ship on Friday instead.");
    expect(await clusters()).toEqual([]);
  });

  it("a near-copy: the similarity is the real one (above 0.9) and the diff names the changed line", async () => {
    const a = await upload("fake base.txt", BASE);
    const b = await upload("fake edited.txt", EDITED);
    const d = await diff(a, b);
    expect(d.similarity_score).toBeGreaterThan(0.9);
    expect(d.similarity_score).toBeLessThan(1);
    expect(d.diff_summary.removed_lines).toEqual([words.slice(40).join(" ")]);
    expect(d.diff_summary.added_lines).toEqual([[...words.slice(40, 79), "changedword"].join(" ")]);
    expect(d.diff_summary.changed_clauses).toEqual(["line 2"]);
    expect(JSON.stringify(d)).not.toMatch(/Net 30|Clause 9\.3/);
  });

  it("identical text gives 1 and no differences; unrelated text gives 0 and lists both sides", async () => {
    // Other bytes than the uploads above (an identical file would be deduplicated), the same words.
    const a = await upload("fake same 1.txt", `${BASE}\n\n`);
    const b = await upload("fake same 2.txt", `${BASE}\n\n\n`);
    expect(await diff(a, b)).toMatchObject({ similarity_score: 1, diff_summary: { added_lines: [], removed_lines: [], changed_clauses: [] } });
    const c = await upload("fake other.txt", "Entirely different fake words about a fake harbour audit in spring.");
    const d = await diff(a, c);
    expect(d.similarity_score).toBe(0);
    expect(d.diff_summary.added_lines).toEqual(["Entirely different fake words about a fake harbour audit in spring."]);
    expect(d.diff_summary.removed_lines).toHaveLength(2);
  });

  it("an old invented row stays in the table, unchanged; the route shows the real comparison instead", async () => {
    const a = await upload("fake old pair a.txt", "Fake alpha text for the old invented pair, first version.");
    const b = await upload("fake old pair b.txt", "Fake beta text, nothing like the other one at all.");
    const invented = { added_lines: ["Clause 9.3: Payment terms amended from Net 30 to Immediate Wire Transfer."], removed_lines: ["Clause 9.3: Standard Net 30 terms apply."], changed_clauses: ["Clause 9.3 (Disbursement & Settlement)"] };
    await withTenant(tenantId, (tx) => tx`
      INSERT INTO near_duplicate_clusters (id, tenant_id, investigation_id, similarity_score, source_a_id, source_b_id, diff_summary)
      VALUES (${randomUUID()}, ${tenantId}, ${investigationId}, 0.94, ${a}, ${b}, ${JSON.stringify(invented)}::jsonb)`, sql);
    const before = await clusters();
    const d = await diff(a, b);
    expect(d.similarity_score).toBe(0);
    expect(JSON.stringify(d)).not.toMatch(/Net 30|Clause 9\.3/);
    expect(await clusters()).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("a source that is not in the investigation answers 404, not an invented diff", async () => {
    const a = await upload("fake lone.txt", "Fake lone text.");
    const res = await app.inject({ method: "GET", url: `/v1/investigations/${investigationId}/sources/${a}/diff/${randomUUID()}`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});
