import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { getDbUrl, createDbClient, withTenant, type Tx } from "@casefile/db";
import { writeAuditEvent, verifyTenantAuditChain, verifyAuditChain, computeEventHash, type AuditEvent } from "@casefile/audit";
import { handleGetDocumentPage, GetDocumentPageSchema } from "@casefile/mcp";
import { buildApp } from "../src/app.js";
import { nextTotpCode } from "./helpers/totp.js";
import { enrolTotpThroughSetupLink } from "./helpers/setup-link.js";
import { ingestDirectory } from "../../../tools/ingest-cli/src/ingest.js";
import { triageOnly } from "../../../tools/ingest-cli/src/triage.js";

/**
 * FIXES-1 A, DEV-031: sources.metadata, audit_events.before / after / ai_involvement and
 * content_blocks.bbox were written as a JSON *string* inside the jsonb column
 * (`${JSON.stringify(x)}::jsonb` and `JSON.stringify(x)` as a parameter: postgres.js serialises a
 * jsonb parameter itself, so the text was encoded twice). New rows now hold a JSON object. Old rows
 * are never changed, so every reader is shown here with one old-style row (written exactly as the
 * BIGDATA-3 code wrote it) and one new-style row, for every affected column and route.
 *
 * The audit chain (I8, D52) hashes the PARSED value: computeEventHash() runs parseJsonField() on
 * before, after and ai_involvement, so a row whose after is read back as a string and a row whose
 * after is read back as an object hash the same for the same content, and a chain that mixes both
 * verifies.
 */

/**
 * An audit row in the TEXT form every row had before FIXES-1, written through the one writer
 * (guardrails/audit-integrity.spec.ts allows no other INSERT): a value that jsonb cannot hold as
 * an object (it holds U+0000) is stored as its JSON text, exactly as the old writer stored every
 * value. Rows written by the old code itself, mixed with new ones in one chain, are verified in
 * captures/fixes1/mixed-chain-*.txt.
 */
const NUL = String.fromCharCode(0);
async function writeTextFormAuditEvent(tx: Tx, e: { tenantId: string; action: string; objectId: string; after: Record<string, unknown> }): Promise<void> {
  await writeAuditEvent(tx, {
    tenantId: e.tenantId, actorType: "user", actorId: randomUUID(), actorDisplay: "text form", action: e.action,
    objectType: "test", objectId: e.objectId, objectDisplay: "text form", after: { ...e.after, marker: `text form${NUL}` },
    outcome: "success", requestId: randomUUID(),
  });
}

describe("FIXES-1 A — DEV-031: JSON columns hold JSON objects; readers take old and new rows", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let userId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;
  let stepUpToken: string;
  let pdfSourceId: string;
  const OLD = { source: randomUUID(), artifact: randomUUID(), doc: randomUUID(), block: randomUUID(), chunk: randomUUID() };
  const OLD_BBOX = { x1: 10, y1: 20, x2: 300, y2: 40 };
  const OLD_PATH = "D:/fake/old-style/source.txt";
  const OLD_TEXT = "Fake old-style block text on page one.";
  const DIR = join(process.cwd(), ".tmp-test-fixtures", `json_columns_${Date.now()}`);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const q = <T,>(fn: (tx: Tx) => Promise<T>) => withTenant(tenantId, fn, sql);

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `json-columns-${Date.now()}@casefile.test`;
    const password = "JsonColumns123!";
    const reg = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Json Columns", orgName: "Json Columns Fake Org" } })).body);
    tenantId = reg.user.tenantId;
    userId = reg.user.id;
    token = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } })).body).accessToken;
    const ws = JSON.parse((await app.inject({ method: "POST", url: "/v1/workspaces", headers: auth(), payload: { name: "Json Columns WS" } })).body);
    workspaceId = ws.id;
    investigationId = JSON.parse((await app.inject({ method: "POST", url: "/v1/investigations", headers: auth(), payload: { workspace_id: ws.id, name: "Json Columns", objective: "FIXES-1 A" } })).body).id;
    const { secret } = await enrolTotpThroughSetupLink(app, sql, { tenantId, email, password });
    stepUpToken = JSON.parse((await app.inject({ method: "POST", url: "/v1/auth/step-up", headers: auth(), payload: { totpCode: await nextTotpCode(secret) } })).body).accessToken;

    // A new-style row of every kind: a text PDF uploaded through REST (source, blocks with bbox, audit rows).
    const up = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: auth(),
      payload: { filename: "fake_transcript.pdf", mime_type: "application/pdf", content_base64: readFileSync(join(process.cwd(), "test-corpus", "text-transcript.pdf")).toString("base64"), acquisition_record: { origin: "Fake", custodian: "Fake" } },
    });
    expect(up.statusCode, up.body).toBe(201);
    pdfSourceId = JSON.parse(up.body).id;

    // An old-style row of every kind, written the way the BIGDATA-3 code wrote them (JSON text in jsonb).
    await q(async (tx) => {
      await tx`INSERT INTO sources (id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, status, source_class, metadata, created_by)
               VALUES (${OLD.source}, ${tenantId}, ${workspaceId}, ${investigationId}, 'source.txt', 'text/plain', ${Buffer.byteLength(OLD_TEXT)},
                       ${createHash("sha256").update(OLD_TEXT).digest("hex")}, 'gcs://casefile-localtest-sources/old-style',
                       'indexed', 'primary_record', ${JSON.stringify({ source_path: OLD_PATH, note: "old style" })}::jsonb, ${userId})`;
      const acq = randomUUID();
      await tx`INSERT INTO acquisition_records (id, tenant_id, source_id, origin, custodian) VALUES (${acq}, ${tenantId}, ${OLD.source}, 'Fake', 'Fake')`;
      await tx`INSERT INTO source_instances (tenant_id, source_id, acquisition_record_id, investigation_id) VALUES (${tenantId}, ${OLD.source}, ${acq}, ${investigationId})`;
      await tx`INSERT INTO artifacts (id, tenant_id, source_id, kind, storage_uri) VALUES (${OLD.artifact}, ${tenantId}, ${OLD.source}, 'primary', 'gcs://casefile-localtest-sources/old-style')`;
      await tx`INSERT INTO content_documents (id, tenant_id, artifact_id, doc_type, full_text) VALUES (${OLD.doc}, ${tenantId}, ${OLD.artifact}, 'document', ${OLD_TEXT})`;
      await tx`INSERT INTO content_blocks (id, tenant_id, content_document_id, sequence, block_type, page, char_start, char_end, bbox, text)
               VALUES (${OLD.block}, ${tenantId}, ${OLD.doc}, 1, 'paragraph', 1, 0, ${OLD_TEXT.length}, ${JSON.stringify(OLD_BBOX)}::jsonb, ${OLD_TEXT})`;
      await tx`INSERT INTO chunks (id, tenant_id, investigation_id, content_document_id, block_ids, char_start, char_end, text, token_count)
               VALUES (${OLD.chunk}, ${tenantId}, ${investigationId}, ${OLD.doc}, ${[OLD.block]}, 0, ${OLD_TEXT.length}, ${OLD_TEXT}, 9)`;
      await writeTextFormAuditEvent(tx, { tenantId, action: "test.old_style", objectId: OLD.source, after: { note: "old style", n: 1 } });
    });
    const types = await q((tx) => tx<{ m: string; b: string; a: string }[]>`
      SELECT (SELECT jsonb_typeof(metadata) FROM sources WHERE id = ${OLD.source}) AS m,
             (SELECT jsonb_typeof(bbox) FROM content_blocks WHERE id = ${OLD.block}) AS b,
             (SELECT jsonb_typeof(after) FROM audit_events WHERE action = 'test.old_style' AND tenant_id = ${tenantId}) AS a`);
    expect(types[0], "the seeded old-style rows really are JSON strings").toEqual({ m: "string", b: "string", a: "string" });

    // A folder for the CLI: a copy of the old-style source's bytes (triage must read that source's
    // path from its old-style metadata) and one new file (its source gets new-style metadata).
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "copy-of-old.txt"), OLD_TEXT);
    writeFileSync(join(DIR, "cli-note.txt"), "Fake note ingested by the CLI in FIXES-1.");
  }, 120_000);

  afterAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    await app.close();
    await sql.end();
  });

  it("new rows hold JSON objects: REST source metadata, block bbox and audit after; CLI source metadata and audit after", async () => {
    const run = await ingestDirectory({ dir: DIR, investigationId, tenantId, dbUrl: getDbUrl() });
    // The ingest's triage read the old-style source's path out of its string metadata.
    const dec = await q((tx) => tx<{ decision: string; duplicate_of_path: string | null }[]>`
      SELECT decision, duplicate_of_path FROM ingest_decisions WHERE run_id = ${run.runId} AND path = ${join(DIR, "copy-of-old.txt")}`);
    expect(dec).toEqual([{ decision: "skip-duplicate", duplicate_of_path: OLD_PATH }]);
    const r = await q(async (tx) => ({
      rest: await tx<{ m: string }[]>`SELECT jsonb_typeof(metadata) AS m FROM sources WHERE id = ${pdfSourceId}`,
      bbox: await tx<{ b: string; n: number }[]>`
        SELECT jsonb_typeof(b.bbox) AS b, count(*)::int AS n FROM content_blocks b JOIN content_documents cd ON cd.id = b.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id WHERE a.source_id = ${pdfSourceId} AND b.bbox IS NOT NULL GROUP BY 1`,
      restAudit: await tx<{ a: string }[]>`SELECT jsonb_typeof(after) AS a FROM audit_events WHERE object_id = ${pdfSourceId} AND action = 'source.admit'`,
      cli: await tx<{ m: string }[]>`SELECT jsonb_typeof(metadata) AS m FROM sources WHERE investigation_id = ${investigationId} AND filename = 'cli-note.txt'`,
      cliAudit: await tx<{ a: string }[]>`
        SELECT jsonb_typeof(e.after) AS a FROM audit_events e JOIN sources s ON s.id = e.object_id WHERE s.filename = 'cli-note.txt' AND e.action = 'source.admit' AND e.tenant_id = ${tenantId}`,
    }));
    expect(r.rest).toEqual([{ m: "object" }]);
    expect(r.bbox.map((x) => x.b)).toEqual(["object"]);
    expect(r.bbox[0]!.n).toBeGreaterThan(0);
    expect(r.restAudit).toEqual([{ a: "object" }]);
    expect(r.cli).toEqual([{ m: "object" }]);
    expect(r.cliAudit).toEqual([{ a: "object" }]);
  });

  it("GET /sources/:id: a REST-uploaded PDF answers 200 (it answered 500), and an old-style source reads the same way", async () => {
    const pdf = await app.inject({ method: "GET", url: `/v1/investigations/${investigationId}/sources/${pdfSourceId}`, headers: auth() });
    expect(pdf.statusCode, pdf.body.slice(0, 300)).toBe(200);
    const pb = JSON.parse(pdf.body) as { metadata: unknown; blocks: Array<{ bbox: unknown }> };
    expect(typeof pb.metadata).toBe("object");
    expect(pb.blocks.some((b) => b.bbox !== null && typeof b.bbox === "object")).toBe(true);
    const old = await app.inject({ method: "GET", url: `/v1/investigations/${investigationId}/sources/${OLD.source}`, headers: auth() });
    expect(old.statusCode, old.body.slice(0, 300)).toBe(200);
    const ob = JSON.parse(old.body) as { metadata: unknown; blocks: Array<{ bbox: unknown }> };
    expect(ob.metadata).toEqual({ source_path: OLD_PATH, note: "old style" });
    expect(ob.blocks.map((b) => b.bbox)).toEqual([OLD_BBOX]);
  });

  it("GET /sources (the list): old-style and new-style metadata both come back as objects", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/investigations/${investigationId}/sources?limit=100`, headers: auth() });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const items = (JSON.parse(res.body) as { items: Array<{ id: string; metadata: unknown }> }).items;
    expect(items.find((s) => s.id === OLD.source)!.metadata).toEqual({ source_path: OLD_PATH, note: "old style" });
    expect(typeof items.find((s) => s.id === pdfSourceId)!.metadata).toBe("object");
  });

  it("MCP get_document_page: bbox is an object for the old-style block and for the new-style blocks", async () => {
    const ctx = { tenantId, investigationId, userId, roles: ["lead_inv"] };
    const oldPage = await q((tx) => handleGetDocumentPage(tx, ctx, GetDocumentPageSchema.parse({ document_id: OLD.source, page: 1 })));
    expect(oldPage.blocks.map((b) => b.bbox)).toEqual([OLD_BBOX]);
    const newPage = await q((tx) => handleGetDocumentPage(tx, ctx, GetDocumentPageSchema.parse({ document_id: pdfSourceId, page: 1 })));
    expect(newPage.blocks.length).toBeGreaterThan(0);
    for (const b of newPage.blocks) expect(b.bbox === null || typeof b.bbox === "object", JSON.stringify(b.bbox)).toBe(true);
    expect(newPage.blocks.some((b) => b.bbox !== null)).toBe(true);
  });

  it("GET /v1/audit/events: before / after are objects for the old-style row and for new rows", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/audit/events?limit=100", headers: { authorization: `Bearer ${stepUpToken}` } });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const items = (JSON.parse(res.body) as { items: Array<{ action: string; object_id: string; after: unknown }> }).items;
    expect(items.find((e) => e.action === "test.old_style")!.after).toEqual({ note: "old style", n: 1, marker: `text form${NUL}` });
    const admit = items.find((e) => e.action === "source.admit" && e.object_id === pdfSourceId)!;
    expect(admit.after).toMatchObject({ filename: "fake_transcript.pdf" });
  });

  it("the ingest's own readers take both: a second triage names the new-style CLI source and the old-style source as originals", async () => {
    const t = await triageOnly({ dir: DIR, investigationId, tenantId, dbUrl: getDbUrl() });
    const d = await q((tx) => tx<{ decision: string; duplicate_of_path: string | null }[]>`SELECT decision, duplicate_of_path FROM ingest_decisions WHERE run_id = ${t.runId} ORDER BY path`);
    expect(d).toEqual([
      { decision: "skip-duplicate", duplicate_of_path: join(DIR, "cli-note.txt") },
      { decision: "skip-duplicate", duplicate_of_path: OLD_PATH },
    ]);
  });

  it("the audit chain: old-style and new-style rows, mixed, verify; each row hashes the same read as text or as an object; a changed after is caught", async () => {
    const T = randomUUID();
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      await withTenant(T, async (tx) => {
        await tx`INSERT INTO organizations (id, tenant_id, name) VALUES (${T}, ${T}, 'Chain Mix Fake Org')`;
        await writeTextFormAuditEvent(tx, { tenantId: T, action: "chain.old", objectId: T, after: { step: 1, text: "old" } });
        await writeAuditEvent(tx, { tenantId: T, actorType: "user", actorId: randomUUID(), actorDisplay: "new writer", action: "chain.new", objectType: "test", objectId: T, objectDisplay: "new", after: { step: 2, text: "new", nested: { b: [1, 2], a: "x" } }, before: { was: "nothing" }, aiInvolvement: { model: "none" }, outcome: "success", requestId: randomUUID() });
        await writeTextFormAuditEvent(tx, { tenantId: T, action: "chain.old", objectId: T, after: { step: 3, text: "old again" } });
        await writeAuditEvent(tx, { tenantId: T, actorType: "user", actorId: randomUUID(), actorDisplay: "new writer", action: "chain.new", objectType: "test", objectId: T, objectDisplay: "new", after: { step: 4, text: "a NUL \u0000 and a lone \ud800 surrogate" }, outcome: "success", requestId: randomUUID() });
      }, c);
      const rows = await withTenant(T, (tx) => tx<(AuditEvent & { t_after: string; t_before: string | null; t_ai: string | null })[]>`
        SELECT *, jsonb_typeof(after) AS t_after, jsonb_typeof(before) AS t_before, jsonb_typeof(ai_involvement) AS t_ai FROM audit_events WHERE tenant_id = ${T} ORDER BY seq`, c);
      expect(rows.map((r) => [r.action, r.t_after])).toEqual([["chain.old", "string"], ["chain.new", "object"], ["chain.old", "string"], ["chain.new", "string"]]);
      expect([rows[1]!.t_before, rows[1]!.t_ai]).toEqual(["object", "object"]);
      // jsonb cannot hold U+0000 or an unpaired surrogate: such a row keeps the lossless text form.
      expect(rows[3]!.after).toBe(JSON.stringify({ step: 4, text: "a NUL \u0000 and a lone \ud800 surrogate" }));
      expect(rows[0]!.after).toBe(JSON.stringify({ step: 1, text: "old", marker: `text form${NUL}` }));
      expect(await withTenant(T, (tx) => verifyTenantAuditChain(tx, T), c)).toEqual({ valid: true, verifiedCount: 4 });
      for (const r of rows) {
        const asText = { ...r, after: typeof r.after === "string" ? r.after : JSON.stringify(r.after) };
        const asObject = { ...r, after: typeof r.after === "string" ? JSON.parse(r.after) : r.after };
        expect(computeEventHash(asText, r.prev_hash)).toBe(r.hash);
        expect(computeEventHash(asObject, r.prev_hash)).toBe(r.hash);
      }
      const tampered = rows.map((r, i) => (i === 1 ? { ...r, after: { ...(r.after as Record<string, unknown>), step: 99 } } : r));
      expect(verifyAuditChain(tampered)).toMatchObject({ valid: false, break: { type: "mutated_payload", index: 1 } });
    } finally {
      await c.end();
    }
  });
});
