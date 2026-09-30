import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import type postgres from "postgres";

/**
 * BIGDATA-2A finding F6 (D92): POST /v1/investigations/:id/sources records no OCR engine,
 * version or confidence that never ran. Casefile has no OCR step yet (docs/PLAN-BIG-DATA.md §4),
 * so:
 * - no artifact names an OCR engine, unless the caller says the text came from its own OCR
 *   (ocr_confidence_override), and then the engine is "client_supplied" with the caller's figure;
 * - no confidence is invented (it used to be 0.42 for a filename containing "scanned", 0.98
 *   otherwise, and the engine "tesseract-5" / "5.3.0");
 * - a PDF with no text layer is "needs_ocr" with no text rows, not indexed with the made-up text
 *   "PDF Content".
 */
describe("apps/api — REST upload records no OCR that did not run (F6)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let investigationId: string;
  let token: string;

  const upload = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: { acquisition_record: { origin: "Fake scanner", custodian: "Fake clerk" }, ...payload },
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body) as { id: string; status: string; job_id: string };
  };
  const rowsFor = (sourceId: string) =>
    withTenant(tenantId, async (tx) => ({
      artifacts: await tx<{ ocr_engine: string | null; ocr_version: string | null; ocr_confidence: string | null }[]>`
        SELECT ocr_engine, ocr_version, ocr_confidence FROM artifacts WHERE source_id = ${sourceId} AND kind = 'primary'`,
      documents: await tx<{ full_text: string | null }[]>`
        SELECT cd.full_text FROM content_documents cd JOIN artifacts a ON a.id = cd.artifact_id WHERE a.source_id = ${sourceId}`,
      blocks: await tx<{ block_type: string; ocr_confidence: string | null; text: string }[]>`
        SELECT b.block_type, b.ocr_confidence, b.text FROM content_blocks b
        JOIN content_documents cd ON cd.id = b.content_document_id JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${sourceId}`,
      chunks: await tx<{ id: string }[]>`
        SELECT c.id FROM chunks c JOIN content_documents cd ON cd.id = c.content_document_id JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${sourceId}`,
      job: await tx<{ stage: string; error_message: string | null }[]>`
        SELECT stage, error_message FROM source_ingestion_jobs WHERE source_id = ${sourceId}`,
    }), sql);

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();
    const email = `ocr-honesty-${Date.now()}@casefile.test`;
    const password = "OcrHonesty123!";
    const reg = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "OCR Checker", orgName: "OCR Honesty Fake Org" } });
    expect(reg.statusCode).toBe(201);
    tenantId = JSON.parse(reg.body).user.tenantId;
    const tok = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { email, password, tenantId } });
    token = JSON.parse(tok.body).accessToken;
    const ws = await app.inject({ method: "POST", url: "/v1/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: "OCR WS" } });
    const inv = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace_id: JSON.parse(ws.body).id, name: "OCR Honesty", objective: "F6" },
    });
    investigationId = JSON.parse(inv.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("text named 'scanned…' with no OCR figure from the caller: no engine, no version, no confidence, not an OCR page", async () => {
    const src = await upload({ filename: "scanned_meeting_note.txt", mime_type: "text/plain", raw_text: "Fake note typed by hand, never scanned." });
    expect(src.status).toBe("indexed");
    const r = await rowsFor(src.id);
    expect(r.artifacts).toEqual([{ ocr_engine: null, ocr_version: null, ocr_confidence: null }]);
    expect(r.blocks.map((b) => [b.block_type, b.ocr_confidence])).toEqual([["paragraph", null]]);
  });

  it("an ordinary text upload: no OCR engine, version or confidence either (it used to say tesseract-5 5.3.0, 0.98)", async () => {
    const src = await upload({ filename: "fake_contract.txt", mime_type: "text/plain", raw_text: "Fake contract text." });
    const r = await rowsFor(src.id);
    expect(r.artifacts).toEqual([{ ocr_engine: null, ocr_version: null, ocr_confidence: null }]);
    expect(r.blocks.map((b) => b.ocr_confidence)).toEqual([null]);
  });

  it("a PDF with a text layer: no OCR confidence on its artifact", async () => {
    const pdf = readFileSync(join(process.cwd(), "test-corpus", "text-transcript.pdf"));
    const src = await upload({ filename: "fake_transcript.pdf", mime_type: "application/pdf", content_base64: pdf.toString("base64") });
    expect(src.status).toBe("indexed");
    const r = await rowsFor(src.id);
    expect(r.artifacts).toEqual([{ ocr_engine: null, ocr_version: null, ocr_confidence: null }]);
    expect(r.blocks.length).toBeGreaterThan(0);
  });

  it("a scanned PDF (no text layer) says it needs OCR: needs_ocr, no text rows, no made-up text", async () => {
    const pdf = readFileSync(join(process.cwd(), "test-corpus", "scanned-agreement.pdf"));
    const src = await upload({ filename: "scanned_agreement.pdf", mime_type: "application/pdf", content_base64: pdf.toString("base64") });
    expect(src.status).toBe("needs_ocr");
    const r = await rowsFor(src.id);
    expect(r.artifacts).toEqual([{ ocr_engine: null, ocr_version: null, ocr_confidence: null }]);
    expect(r.blocks).toEqual([]);
    expect(r.chunks).toEqual([]);
    expect(r.documents.map((d) => d.full_text)).toEqual([""]);
    expect(r.job).toEqual([{ stage: "queued", error_message: "Needs OCR: the PDF has no text layer, and this version has no OCR step" }]);
  });

  it("OCR text the caller supplies keeps the caller's confidence, marked as client-supplied", async () => {
    const src = await upload({ filename: "scanned_receipt.pdf", mime_type: "application/pdf", raw_text: "Totl Amnt: $45.0O", ocr_confidence_override: 0.45 });
    const r = await rowsFor(src.id);
    expect(r.artifacts).toEqual([{ ocr_engine: "client_supplied", ocr_version: null, ocr_confidence: "0.4500" }]);
    expect(r.blocks.map((b) => [b.block_type, b.ocr_confidence])).toEqual([["ocr_page", "0.4500"]]);
  });
});
