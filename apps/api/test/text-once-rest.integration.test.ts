import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { ensureEmulatorBucket, listBucketObjects } from "@casefile/storage";
import type postgres from "postgres";

/**
 * BIGDATA-2B, what POST /v1/investigations/:id/sources writes (D94, D95): chunks store no text of
 * their own, full_text is NULL when the blocks give it back exactly, and the artifact points at
 * the source object (no second object in the artifacts bucket). every chunk reader still gets
 * each chunk's text.
 */
describe("apps/api — REST upload stores text once and no byte-identical artifact copy (BIGDATA-2B)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let investigationId: string;
  let token: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `text-once-rest-${Date.now()}@casefile.test`;
    const password = "TextOnceRest123!";
    const reg = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Text Once Rest", orgName: "Text Once REST Fake Org" } });
    tenantId = JSON.parse(reg.body).user.tenantId;
    const tok = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } });
    token = JSON.parse(tok.body).accessToken;
    const ws = await app.inject({ method: "POST", url: "/v1/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: "Text once REST WS" } });
    const inv = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: JSON.parse(ws.body).id, name: "Text once REST", objective: "BIGDATA-2B" },
    });
    investigationId = JSON.parse(inv.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  const upload = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: { acquisition_record: { origin: "Fake upload", custodian: "Fake clerk" }, ...payload },
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body) as { id: string; storage_uri: string };
  };

  const checkUpload = async (payload: { filename: string; mime_type: string; raw_text?: string; content_base64?: string }) => {
      const src = await upload(payload);
      const r = await withTenant(tenantId, async (tx) => ({
        artifact: await tx<{ storage_uri: string }[]>`SELECT storage_uri FROM artifacts WHERE source_id = ${src.id} AND kind = 'primary'`,
        doc: await tx<{ full_text: string | null }[]>`SELECT cd.full_text FROM content_documents cd JOIN artifacts a ON a.id = cd.artifact_id WHERE a.source_id = ${src.id}`,
        chunks: await tx<{ n: number; with_text: number }[]>`
          SELECT count(*)::int AS n, count(*) FILTER (WHERE c.text IS NOT NULL)::int AS with_text
          FROM chunks c JOIN content_documents cd ON cd.id = c.content_document_id JOIN artifacts a ON a.id = cd.artifact_id WHERE a.source_id = ${src.id}`,
        blocks: await tx<{ text: string }[]>`
          SELECT b.text FROM content_blocks b JOIN content_documents cd ON cd.id = b.content_document_id JOIN artifacts a ON a.id = cd.artifact_id
          WHERE a.source_id = ${src.id} ORDER BY b.sequence`,
      }), sql);
      expect(r.artifact.map((a) => a.storage_uri)).toEqual([src.storage_uri]);
      expect(r.doc.map((d) => d.full_text)).toEqual([null]);
      expect(r.chunks[0]!.n).toBeGreaterThan(0);
      expect(r.chunks[0]!.with_text).toBe(0);
      // What every chunk reader gets (the COALESCE of docs/PLAN-BIG-DATA.md section 12).
      const read = await withTenant(tenantId, (tx) => tx<{ text: string }[]>`
        SELECT COALESCE(c.text, cb.text) AS text
        FROM chunks c
        LEFT JOIN content_blocks cb ON c.text IS NULL AND cb.id = c.block_ids[1] AND cb.tenant_id = c.tenant_id
        JOIN content_documents cd ON cd.id = c.content_document_id JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${src.id}`, sql);
      expect(read.map((c) => c.text).sort()).toEqual(r.blocks.map((b) => b.text).sort());
      if (payload.mime_type === "text/plain") {
        // GET /sources/:id of a REST-uploaded PDF answers 500 on the 2A code too: its blocks' bbox
        // is stored as a JSON string (DEV-031, captures/bigdata2b/rest-pdf-get-on-2A-code.txt).
        const get = await app.inject({ method: "GET", url: `/v1/investigations/${investigationId}/sources/${src.id}`, headers: { authorization: `Bearer ${token}` } });
        expect(get.statusCode, get.body).toBe(200);
        const body = JSON.parse(get.body) as { chunks: Array<{ text: string }> };
        expect(body.chunks.map((c) => c.text).sort()).toEqual(r.blocks.map((b) => b.text).sort());
      }
  };

  it("a text upload: chunks and full_text store no text, the artifact is the source object, readers get the chunk text", () =>
    checkUpload({ filename: "fake_memo.txt", mime_type: "text/plain", raw_text: "Fake memo text for the REST upload." }));

  it("a text PDF: chunks and full_text store no text, the artifact is the source object, readers get the chunk text", () =>
    checkUpload({ filename: "fake_transcript.pdf", mime_type: "application/pdf", content_base64: readFileSync(join(process.cwd(), "test-corpus", "text-transcript.pdf")).toString("base64") }));

  it("no artifact object is written: not in the artifacts bucket, and not under artifacts/ in the sources bucket", async () => {
    // The route used to write its copy with getObjectStore() (the sources bucket), under
    // <tenant>/<investigation>/artifacts/.
    // Nothing writes to the artifacts bucket any more, so on a wiped stack it may not exist yet.
    await ensureEmulatorBucket(process.env.GCS_BUCKET_ARTIFACTS!);
    expect(await listBucketObjects(process.env.GCS_BUCKET_ARTIFACTS!, `${tenantId}/`)).toEqual([]);
    expect(await listBucketObjects(process.env.GCS_BUCKET_SOURCES!, `${tenantId}/${investigationId}/artifacts/`)).toEqual([]);
  });
});
