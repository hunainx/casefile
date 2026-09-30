import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient } from "@casefile/db";
import type postgres from "postgres";

describe("apps/api — Ingestion Acceptance Criteria Suite (PRD §56.2 AC-ING-01..07)", () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  let tenantId: string;
  let workspaceId: string;
  let investigationId: string;
  let token: string;

  beforeAll(async () => {
    sql = createDbClient(getDbUrl());
    app = buildApp({ db: sql });
    await app.ready();

    const email = `ingest-accept-${Date.now()}@casefile.test`;
    const password = "IngestPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password,
        name: "Ingestion Acceptor",
        orgName: "Ingestion Test Corp",
      },
    });
    expect(regRes.statusCode).toBe(201);
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password, tenantId },
    });
    expect(tokenRes.statusCode).toBe(200);
    token = JSON.parse(tokenRes.body).accessToken;

    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Ingestion Acceptance Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Ingestion Matter 101",
        objective: "Verify multi-source ingestion pipeline",
      },
    });
    expect(invRes.statusCode).toBe(201);
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("REQ-AC-ING-01: Acquisition record required for admission", async () => {
    // 1. Given a user uploads a file with no acquisition record
    const uploadNoAcq = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "unattributed_bank_records.pdf",
        mime_type: "application/pdf",
        raw_text: "Transaction ID: TX-8891 Amount: $500,000",
      },
    });
    expect(uploadNoAcq.statusCode).toBe(201);
    const source1 = JSON.parse(uploadNoAcq.body);

    // 2. Then the source is created in state 'received' but not promoted to 'admitted' or 'indexed'
    expect(source1.status).toBe("received");
    expect(source1.acquisition_record).toBeNull();

    // 3. When an acquisition record is supplied with the upload
    const uploadWithAcq = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "attributed_bank_records.pdf",
        mime_type: "application/pdf",
        raw_text: "Transaction ID: TX-8892 Amount: $250,000",
        acquisition_record: {
          origin: "Banco Central Subpoena Response",
          custodian: "Compliance Officer Jane Doe",
          acquisition_method: "subpoena",
          authorization_basis: "Subpoena 2026-CV-8891",
        },
      },
    });
    expect(uploadWithAcq.statusCode).toBe(201);
    const source2 = JSON.parse(uploadWithAcq.body);

    // 4. Then the source is admitted and indexed
    expect(source2.status).toBe("indexed");
    expect(source2.acquisition_record).toBeDefined();
    expect(source2.acquisition_record.origin).toBe("Banco Central Subpoena Response");
  });

  it("REQ-AC-ING-02: Byte-identical deduplication creates SourceInstance", async () => {
    const rawContent = "CONFIDENTIAL CONTRACT AGREEMENT 2026 - BETWEEN CORP A AND CORP B";

    // 1. Given a source with SHA-256 X already exists
    const firstUpload = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Contract_Original.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        raw_text: rawContent,
        acquisition_record: {
          origin: "Legal Counsel Custody",
          custodian: "General Counsel Smith",
          acquisition_method: "upload",
        },
      },
    });
    expect(firstUpload.statusCode).toBe(201);
    const firstSource = JSON.parse(firstUpload.body);

    // 2. When uploading a byte-identical file from a different custodian
    const secondUpload = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Contract_Duplicate_Copy.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        raw_text: rawContent,
        acquisition_record: {
          origin: "Finance Department Share",
          custodian: "CFO Davis",
          acquisition_method: "folder_import",
        },
      },
    });

    // 3. Then no new bytes are stored, a new SourceInstance is created, both acquisition records retained
    expect(secondUpload.statusCode).toBe(200);
    const dedupRes = JSON.parse(secondUpload.body);
    expect(dedupRes.deduplicated).toBe(true);
    expect(dedupRes.existing_source_id).toBe(firstSource.id);
    expect(dedupRes.source_instance_id).toBeDefined();
  });

  it("REQ-AC-ING-03: Progressive availability allows reading first document immediately", async () => {
    // 1. When a source is uploaded and indexed in a batch
    const uploadRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Batch_Doc_001.txt",
        mime_type: "text/plain",
        raw_text: "First document in progressive batch with immediate chunk availability.",
        acquisition_record: { origin: "Server Share", custodian: "IT Dept" },
      },
    });
    expect(uploadRes.statusCode).toBe(201);
    const doc1 = JSON.parse(uploadRes.body);

    // 2. Then it is searchable and readable with chunks immediately
    const readRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/${doc1.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(readRes.statusCode).toBe(200);
    const readBody = JSON.parse(readRes.body);
    expect(readBody.chunks.length).toBeGreaterThan(0);
    expect(readBody.chunks[0].text).toContain("First document in progressive batch");
  });

  it("REQ-AC-ING-04: Unparseable files are retained and citable", async () => {
    // 1. Given a file in an unsupported format
    const unparseableRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "cad_schematic.xyz",
        mime_type: "application/x-proprietary-cad",
        raw_text: "BINARY RAW BYTES 0xDEADBEEF",
        acquisition_record: { origin: "Factory USB", custodian: "Plant Manager" },
      },
    });
    expect(unparseableRes.statusCode).toBe(201);
    const unparsed = JSON.parse(unparseableRes.body);

    // 2. Then bytes are stored, hash computed, marked unprocessable, and listed in corpus inventory
    expect(unparsed.status).toBe("unprocessable");
    expect(unparsed.sha256).toBeDefined();

    const listRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.items.some((s: { id: string }) => s.id === unparsed.id)).toBe(true);
  });

  it("REQ-AC-ING-05: OCR confidence flagging for low-confidence scans", async () => {
    // 1. Given a scanned PDF where OCR confidence is low (0.42 < 0.60)
    const ocrRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "scanned_degraded_invoice.pdf",
        mime_type: "application/pdf",
        raw_text: "Degraded text scan with poor ink quality",
        ocr_confidence_override: 0.42,
        acquisition_record: { origin: "Archive Box 4", custodian: "Records Clerk" },
      },
    });
    expect(ocrRes.statusCode).toBe(201);
    const ocrSource = JSON.parse(ocrRes.body);

    // 2. Then the content block is flagged with ocr_confidence = 0.42
    const readRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/${ocrSource.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(readRes.statusCode).toBe(200);
    const body = JSON.parse(readRes.body);
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.blocks[0].ocr_confidence).toBe(0.42);
  });

  it("REQ-AC-ING-06: Sandbox isolation and dead-letter record for malware/exploits", async () => {
    // 1. Given a malformed PDF designed to trigger sandbox protection
    const exploitRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "exploit_payload.pdf",
        mime_type: "application/pdf",
        raw_text: "MALWARE SIGNATURE EXECUTE",
        is_malware_test: true,
      },
    });

    // 2. Then parser process is confined, failure isolated, source quarantined with dead-letter record
    expect(exploitRes.statusCode).toBe(400);
    const exploitBody = JSON.parse(exploitRes.body);
    expect(exploitBody.type).toContain("malware-detected");
    expect(exploitBody.source.status).toBe("quarantined");
  });

  it("REQ-AC-ING-07: Near-duplicate diff calculation", async () => {
    // 1. Upload Contract v1
    const v1Res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Master_Agreement_v1.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        raw_text: "Clause 9.3: Standard Net 30 terms apply to all deliveries.",
        acquisition_record: { origin: "Vendor Portal", custodian: "Account Rep" },
      },
    });
    expect(v1Res.statusCode).toBe(201);
    const v1 = JSON.parse(v1Res.body);

    // 2. Upload Contract v2 (amended terms)
    const v2Res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Master_Agreement_v2.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        raw_text: "Clause 9.3: Payment terms amended from Net 30 to Immediate Wire Transfer.",
        acquisition_record: { origin: "Vendor Portal", custodian: "Account Rep" },
      },
    });
    expect(v2Res.statusCode).toBe(201);
    const v2 = JSON.parse(v2Res.body);

    // 3. Then diff view shows changed clauses and line diffs
    const diffRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/${v1.id}/diff/${v2.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(diffRes.statusCode).toBe(200);
    const diffBody = JSON.parse(diffRes.body);
    // FIXES-1 (DEV-035): the route compares the two texts. They share no run of 5 words, so the
    // similarity is 0; it used to be an invented 0.94 (asserted here as >= 0.9).
    expect(diffBody.similarity_score).toBe(0);
    expect(diffBody.diff_summary).toEqual({
      removed_lines: ["Clause 9.3: Standard Net 30 terms apply to all deliveries."],
      added_lines: ["Clause 9.3: Payment terms amended from Net 30 to Immediate Wire Transfer."],
      changed_clauses: ["line 1"],
    });
  });
});
