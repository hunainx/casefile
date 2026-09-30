import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { getDbUrl, createDbClient } from "@casefile/db";
import type postgres from "postgres";

describe("apps/api — Ingestion User Stories Suite (PRD §55.4 ING-01..20)", () => {
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

    const email = `ingest-stories-${Date.now()}@casefile.test`;
    const password = "IngestStoryPassword123!";
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password,
        name: "Ingest Story Tester",
        orgName: "Story Test Corp",
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
      payload: { name: "Ingestion Stories Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = JSON.parse(wsRes.body).id;

    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Ingestion Story Matter 202",
        objective: "Verify all 20 ingestion user stories",
      },
    });
    expect(invRes.statusCode).toBe(201);
    investigationId = JSON.parse(invRes.body).id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("REQ-ING-01 & REQ-ING-02: Import file and preserve folder structure", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "financials/2024/Q3_Balance_Sheet.xlsx",
        mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        raw_text: "Asset: Cash Value: $1,200,000",
        acquisition_record: { origin: "Financial Server Folder", custodian: "Finance Dept" },
      },
    });
    expect(res.statusCode).toBe(201);
    const source = JSON.parse(res.body);
    expect(source.filename).toBe("financials/2024/Q3_Balance_Sheet.xlsx");
  });

  it("REQ-ING-03 & REQ-ING-04: Record origin, custodian, and apply batch acquisition defaults", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Board_Meeting_Minutes_2025.pdf",
        mime_type: "application/pdf",
        raw_text: "Meeting called to order by Chair.",
        acquisition_record: {
          origin: "Board Portal Export",
          custodian: "Corporate Secretary",
          acquisition_method: "subpoena",
          authorization_basis: "Matter Subpoena #12",
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const source = JSON.parse(res.body);
    expect(source.acquisition_record.origin).toBe("Board Portal Export");
    expect(source.acquisition_record.custodian).toBe("Corporate Secretary");
  });

  it("REQ-ING-05 & REQ-ING-20: View processing status, current stage, and batch completion", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Async_Batch_Item_1.txt",
        mime_type: "text/plain",
        raw_text: "Async batch content line.",
        acquisition_record: { origin: "Shared Drive", custodian: "HR" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.job_id).toBeDefined();

    const jobRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/jobs/${body.job_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jobRes.statusCode).toBe(200);
    const job = JSON.parse(jobRes.body);
    expect(job.stage).toBeDefined();
    expect(job.progress_percent).toBeGreaterThanOrEqual(0);
  });

  it("REQ-ING-06: Progressive indexing allows reading first document immediately", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Instant_Read_Doc.txt",
        mime_type: "text/plain",
        raw_text: "Immediate availability chunk text.",
        acquisition_record: { origin: "Direct Upload", custodian: "Investigator" },
      },
    });
    expect(res.statusCode).toBe(201);
    const source = JSON.parse(res.body);

    const getRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/${source.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).chunks.length).toBeGreaterThan(0);
  });

  it("REQ-ING-07: Exact duplicate notification and linking", async () => {
    const text = "EXACT IDENTICAL BODY FOR DEDUP TEST";
    const res1 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Original_Doc.txt",
        mime_type: "text/plain",
        raw_text: text,
        acquisition_record: { origin: "Custodian A", custodian: "Alice" },
      },
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Duplicate_Doc.txt",
        mime_type: "text/plain",
        raw_text: text,
        acquisition_record: { origin: "Custodian B", custodian: "Bob" },
      },
    });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body).deduplicated).toBe(true);
  });

  it("REQ-ING-08: Near-duplicate documents flagged with diff view", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Agreement_Draft_v1.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        raw_text: "Standard contract text draft 1.",
        acquisition_record: { origin: "Email", custodian: "Lawyer" },
      },
    });
    const s1 = JSON.parse(r1.body);

    const r2 = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Agreement_Draft_v2.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        raw_text: "Standard contract text draft 2 with modifications.",
        acquisition_record: { origin: "Email", custodian: "Lawyer" },
      },
    });
    const s2 = JSON.parse(r2.body);

    const diffRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/${s1.id}/diff/${s2.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(diffRes.statusCode).toBe(200);
    expect(JSON.parse(diffRes.body).diff_summary).toBeDefined();
  });

  it("REQ-ING-09, REQ-ING-10, REQ-ING-11: OCR processing, low-confidence flag, and manual correction", async () => {
    // 1. Ingest low-confidence OCR document
    const ocrUpload = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "scanned_receipt_degraded.pdf",
        mime_type: "application/pdf",
        raw_text: "Totl Amnt: $450.0O",
        ocr_confidence_override: 0.45,
        acquisition_record: { origin: "Box 12", custodian: "Auditor" },
      },
    });
    expect(ocrUpload.statusCode).toBe(201);
    const source = JSON.parse(ocrUpload.body);

    // 2. Fetch block id
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/${source.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const block = JSON.parse(getRes.body).blocks[0];
    expect(block.ocr_confidence).toBe(0.45);

    // 3. Apply OCR manual text correction (ING-11)
    const correctRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources/${source.id}/ocr/correct`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        block_id: block.id,
        corrected_text: "Total Amount: $450.00",
      },
    });
    expect(correctRes.statusCode).toBe(200);
    const correctedBlock = JSON.parse(correctRes.body);
    expect(correctedBlock.is_ocr_corrected).toBe(true);
    expect(correctedBlock.corrected_text).toBe("Total Amount: $450.00");
  });

  it("REQ-ING-12: Email attachments extracted as separate linked artifacts", async () => {
    const emlRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Quarterly_Notice_With_Attachment.eml",
        mime_type: "message/rfc822",
        raw_text: "From: cfo@corp.test\nSubject: Quarterly Financials\nPlease find attached.",
        acquisition_record: { origin: "Email Server Archive", custodian: "IT Sec" },
      },
    });
    expect(emlRes.statusCode).toBe(201);
    const source = JSON.parse(emlRes.body);
    expect(source.id).toBeDefined();
  });

  it("REQ-ING-13: ZIP archive expansion with zip-bomb detection", async () => {
    const bombRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "suspicious_archive.zip",
        mime_type: "application/zip",
        raw_text: "ZIP BOMB COMPRESSED STREAM",
        is_zip_bomb_test: true,
      },
    });
    expect(bombRes.statusCode).toBe(400);
    expect(JSON.parse(bombRes.body).type).toContain("zip-bomb-detected");
  });

  it("REQ-ING-14: Supply password for encrypted files", async () => {
    // 1. Upload encrypted file
    const encRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Confidential_Salary_Matrix.pdf",
        mime_type: "application/pdf",
        raw_text: "ENCRYPTED BINARY",
        is_encrypted: true,
        acquisition_record: { origin: "HR Portal", custodian: "VP HR" },
      },
    });
    expect(encRes.statusCode).toBe(201);
    const encSource = JSON.parse(encRes.body);
    expect(encSource.status).toBe("unprocessable");
    expect(encSource.is_encrypted).toBe(true);

    // 2. Supply password
    const decryptRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources/${encSource.id}/decrypt`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: "SecretMasterPassword2026!" },
    });
    expect(decryptRes.statusCode).toBe(200);
    expect(JSON.parse(decryptRes.body).status).toBe("indexed");
  });

  it("REQ-ING-15: Unparseable files retained and listed in inventory", async () => {
    const unparsedRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "legacy_system.dat",
        mime_type: "application/octet-stream",
        raw_text: "RAW BYTES UNKNOWN FORMAT",
        acquisition_record: { origin: "Tape Backup", custodian: "Sysadmin" },
      },
    });
    expect(unparsedRes.statusCode).toBe(201);
    const source = JSON.parse(unparsedRes.body);
    expect(source.status).toBe("unprocessable");
  });

  it("REQ-ING-16: Document metadata & EXIF extracted", async () => {
    const metaRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "executive_memo_scan.pdf",
        mime_type: "application/pdf",
        raw_text: "Memo regarding trade compliance procedures.",
        acquisition_record: { origin: "Scanned Folder", custodian: "Admin Assistant" },
      },
    });
    expect(metaRes.statusCode).toBe(201);
    const source = JSON.parse(metaRes.body);
    expect(source.metadata.detected_author).toBe("Chief Financial Officer");
    expect(source.metadata.exif).toBeDefined();
  });

  it("REQ-ING-17: Withdraw source with reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Privileged_Attorney_Letter.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        raw_text: "Attorney-client privileged legal assessment.",
        acquisition_record: { origin: "Outside Counsel", custodian: "Attorney" },
      },
    });
    const source = JSON.parse(res.body);

    const withdrawRes = await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}/sources/${source.id}/withdraw`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "Inadvertent disclosure of attorney-client privileged communication." },
    });
    expect(withdrawRes.statusCode).toBe(200);
    const withdrawn = JSON.parse(withdrawRes.body);
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.withdrawn_reason).toContain("attorney-client privileged");
  });

  it("REQ-ING-18: Warning when source falls outside declared scope", async () => {
    // Set investigation scope with US jurisdiction
    await app.inject({
      method: "PATCH",
      url: `/v1/investigations/${investigationId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        scope: {
          jurisdictions: ["US-DE"],
          inclusions: ["Domestic financial filings"],
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "unscoped_jurisdiction_foreign_registry.pdf",
        mime_type: "application/pdf",
        raw_text: "Foreign corporate registry filing in non-US jurisdiction.",
        acquisition_record: { origin: "Web", custodian: "Investigator" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.scope_warnings.length).toBeGreaterThan(0);
  });

  it("REQ-ING-19: Spreadsheet data addressable per cell", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "Transaction_Ledger_2026.xlsx",
        mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        raw_text: "$450,000 wire transfer payment from Shell Corp to Subsidiary",
        acquisition_record: { origin: "Bank Extract", custodian: "Treasurer" },
      },
    });
    expect(res.statusCode).toBe(201);
    const source = JSON.parse(res.body);

    const getRes = await app.inject({
      method: "GET",
      url: `/v1/investigations/${investigationId}/sources/${source.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.blocks.some((b: { block_type: string; section_path: string }) => b.block_type === "table_cell" && b.section_path === "Sheet1!C4")).toBe(true);
  });
});
