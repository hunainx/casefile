/* eslint-disable no-console */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { buildApp } from "../src/app.js";
import { withTenant } from "@casefile/db";
import { verifyTenantAuditChain } from "@casefile/audit";
import {
  getObjectStore,
  GcsObjectStore,
  createSourceStorageKey,
  computeSha256,
  type TenantScopedKey,
} from "@casefile/storage";

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(resolve(process.cwd(), ".env"))) {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  } catch {
    void 0;
  }
}

function getLiveDbUrl(): string | null {
  if (process.env.ENABLE_LIVE_INGEST_TESTS !== "true") {
    return null;
  }
  const url = process.env.DATABASE_URL;
  if (!url || url.includes("CHANGEME") || url.includes("127.0.0.1") || url.includes("localhost")) {
    return null;
  }
  return url;
}

const liveDbUrl = getLiveDbUrl();
const runLiveTests = Boolean(liveDbUrl && process.env.ENABLE_LIVE_INGEST_TESTS === "true");

type AppInstance = ReturnType<typeof buildApp>;

const describeLive = runLiveTests ? describe : describe.skip;

describeLive("apps/api — Live Ingestion & Real GCS Object Storage Roundtrip Test (Supabase + GCS Bucket)", { timeout: 60000 }, () => {
  let db: postgres.Sql;
  let app: AppInstance;
  let tenantId: string;
  let token: string;
  let workspaceId: string;
  let investigationId: string;

  // Plain text document test variables
  let txtSourceId: string;
  let txtSourceSha256: string;
  let txtStorageKey: TenantScopedKey;

  // Synthetic PDF text-layer test variables
  let pdfSourceId: string;
  let pdfSourceSha256: string;
  let pdfStorageKey: TenantScopedKey;
  let syntheticPdfBytes: Uint8Array;

  // Real multi-column + table + rotated fixture test variables (R4)
  let complexPdfSourceId: string;
  let complexPdfSourceSha256: string;
  let complexPdfStorageKey: TenantScopedKey;
  let complexPdfBytes: Uint8Array;

  const rawDocumentText =
    "The transaction occurred on 14 October 2021 in Geneva. " +
    "Alpha Holding S.A. acquired 100% equity in Beta Logistics GmbH. " +
    "The total consideration was 12.5 million Swiss Francs. " +
    "Settlement was confirmed by Banque Cantonale de Geneve.";

  beforeAll(async () => {
    if (!liveDbUrl) return;

    // Strict GCS Driver Assertion: Must be GcsObjectStore
    const store = getObjectStore();
    expect(store, "Live ingestion test requires GcsObjectStore — memory fallback is forbidden").toBeInstanceOf(GcsObjectStore);

    db = postgres(liveDbUrl, { max: 5, connect_timeout: 10 });
    app = buildApp({ db });
    await app.ready();

    // 1. Register User & Tenant
    const email = `live_ingest_${Date.now()}@casefile.test`;
    const password = "LiveIngestPassword123!";
    const orgName = `Live Ingest Org ${Date.now()}`;

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, name: "Live Ingest Officer", orgName },
    });
    if (regRes.statusCode !== 201) {
      console.error("REGISTRATION ERROR:", regRes.body);
    }
    expect(regRes.statusCode).toBe(201);
    const regData = JSON.parse(regRes.body);
    tenantId = regData.user.tenantId;

    // 2. Obtain Token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { email, password, tenantId },
    });
    expect(tokenRes.statusCode).toBe(200);
    token = JSON.parse(tokenRes.body).accessToken;

    // 3. Workspace
    const wsRes = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Live Ingest Workspace" },
    });
    expect(wsRes.statusCode).toBe(201);
    workspaceId = JSON.parse(wsRes.body).id;

    // 4. Investigation
    const invRes = await app.inject({
      method: "POST",
      url: "/v1/investigations",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspace_id: workspaceId,
        name: "Geneva Settlement Acquisition Probe",
        objective: "Live platform provenance and storage integrity validation.",
      },
    });
    if (invRes.statusCode !== 201) {
      console.error("INVESTIGATION ERROR:", invRes.body);
    }
    expect(invRes.statusCode).toBe(201);
    investigationId = JSON.parse(invRes.body).id;

    // 5. Generate a synthetic 2-page text-layer PDF using pdf-lib (Fast regression check)
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const page1 = pdfDoc.addPage([600, 400]);
    page1.drawText("CONFIDENTIAL INVESTIGATION DOSSIER", {
      x: 50,
      y: 350,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
    page1.drawText("On 22 November 2022, Omega Corp executed a transfer of 4.2M EUR to Zurich Holding.", {
      x: 50,
      y: 280,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    });

    const page2 = pdfDoc.addPage([600, 400]);
    page2.drawText("EXHIBIT B: BENEFICIAL OWNERSHIP SCHEDULE", {
      x: 50,
      y: 350,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
    page2.drawText("The ultimate beneficial owner was identified as Viktor Vance via Cyprus intermediary.", {
      x: 50,
      y: 280,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    });

    syntheticPdfBytes = await pdfDoc.save();

    // 6. Generate a complex multi-column + table + rotated page fixture (R4 real-material stress test)
    const complexDoc = await PDFDocument.create();
    const boldFont = await complexDoc.embedFont(StandardFonts.HelveticaBold);
    const regularFont = await complexDoc.embedFont(StandardFonts.Helvetica);

    // Page 1: Multi-column layout + structured financial table
    const compPage1 = complexDoc.addPage([700, 500]);
    // Left column
    compPage1.drawText("COLUMN 1: PROCEEDINGS OVERVIEW", { x: 50, y: 450, size: 12, font: boldFont });
    compPage1.drawText("The judicial commission initiated inquiry into nominee director accounts.", {
      x: 50,
      y: 420,
      size: 10,
      font: regularFont,
    });
    // Right column
    compPage1.drawText("COLUMN 2: ASSET RECOVERY ACTIONS", { x: 380, y: 450, size: 12, font: boldFont });
    compPage1.drawText("Freezing injunctions served on five custodial institutions across Vaduz.", {
      x: 380,
      y: 420,
      size: 10,
      font: regularFont,
    });

    // Table rows below columns
    compPage1.drawText("DISBURSEMENT SCHEDULE TABLE", { x: 50, y: 340, size: 12, font: boldFont });
    compPage1.drawText("2021-08-15 | Valartis Bank | 1,450,000 CHF | Escrow Account A", {
      x: 50,
      y: 310,
      size: 10,
      font: regularFont,
    });
    compPage1.drawText("2021-09-02 | LGT Bank AG   | 2,800,000 CHF | Trust Settlement B", {
      x: 50,
      y: 285,
      size: 10,
      font: regularFont,
    });

    // Page 2: Rotated text layout (90 degrees rotation)
    const compPage2 = complexDoc.addPage([700, 500]);
    compPage2.drawText("ROTATED APPENDIX C: SIGNATURE REPERTORY", {
      x: 400,
      y: 100,
      size: 12,
      font: boldFont,
      rotate: degrees(90),
    });
    compPage2.drawText("Authorized signatory verified as Marc Aurel under power of attorney.", {
      x: 430,
      y: 100,
      size: 10,
      font: regularFont,
      rotate: degrees(90),
    });

    complexPdfBytes = await complexDoc.save();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      if (tenantId) {
        await db`DELETE FROM organizations WHERE id = ${tenantId}`.catch(() => {});
      }
      await db.end();
    }
  }, 60000);

  // ── TEST CASE 1: PLAIN TEXT INGESTION & GCS READBACK ─────────────────────────

  it("ingests a plain .txt document end to end, writes real GCS object bytes, and validates readback and head metadata", async () => {
    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "geneva_settlement_record.txt",
        mime_type: "text/plain",
        source_class: "primary_record",
        raw_text: rawDocumentText,
        acquisition_record: {
          origin: "Geneva Commercial Register",
          custodian: "Cantonal Archives",
          acquisition_method: "upload",
        },
      },
    });

    expect(srcRes.statusCode).toBe(201);
    const srcData = JSON.parse(srcRes.body);
    expect(srcData.status).toBe("indexed");
    txtSourceId = srcData.id;
    txtSourceSha256 = srcData.sha256;

    // ── Verify GCS Readback & Head Metadata ───────────────
    txtStorageKey = createSourceStorageKey(tenantId, investigationId, txtSourceSha256);
    const retrievedBytes = await getObjectStore().get(txtStorageKey);

    expect(retrievedBytes).toBeDefined();
    expect(retrievedBytes.byteLength).toBe(Buffer.byteLength(rawDocumentText, "utf-8"));
    const recomputedSha = computeSha256(retrievedBytes);
    expect(recomputedSha).toBe(txtSourceSha256);

    const textContent = Buffer.from(retrievedBytes).toString("utf-8");
    expect(textContent).toBe(rawDocumentText);

    // Assert real object head in GCS
    const headMeta = await getObjectStore().head(txtStorageKey);
    expect(headMeta.sizeBytes).toBe(Buffer.byteLength(rawDocumentText, "utf-8"));
    expect(headMeta.sha256).toBe(txtSourceSha256);
    expect(headMeta.contentType).toBe("text/plain");
  });

  it("asserts database rows in sources, source_instances, artifacts, content_documents, content_blocks, and chunks for plain text", async () => {
    await withTenant(tenantId, async (tx) => {
      // 1. sources
      const sources = await tx`
        SELECT id, tenant_id, workspace_id, investigation_id, filename, mime_type, byte_size, sha256, storage_uri, status, source_class, created_at
        FROM sources WHERE id = ${txtSourceId};
      `;
      expect(sources.length).toBe(1);
      expect(sources[0]?.status).toBe("indexed");
      expect(sources[0]?.sha256).toBe(txtSourceSha256);
      expect(sources[0]?.storage_uri).toBe(`gcs://${process.env.GCS_BUCKET_SOURCES}/${txtStorageKey}`);

      // 2. source_instances
      const instances = await tx`
        SELECT id, tenant_id, source_id, acquisition_record_id, investigation_id, created_at
        FROM source_instances WHERE source_id = ${txtSourceId};
      `;
      expect(instances.length).toBe(1);
      expect(instances[0]?.investigation_id).toBe(investigationId);

      // 3. artifacts
      const artifacts = await tx`
        SELECT id, tenant_id, source_id, kind, parser, parser_version, status, storage_uri, created_at
        FROM artifacts WHERE source_id = ${txtSourceId};
      `;
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]?.kind).toBe("primary");
      expect(artifacts[0]?.status).toBe("ready");
      const artifactId = artifacts[0]?.id;

      // 4. content_documents
      const contentDocs = await tx`
        SELECT id, tenant_id, artifact_id, normalizer_version, language, doc_type, created_at
        FROM content_documents WHERE artifact_id = ${artifactId};
      `;
      expect(contentDocs.length).toBe(1);
      expect(contentDocs[0]?.language).toBe("en");
      const contentDocId = contentDocs[0]?.id;

      // 5. content_blocks
      const blocks = await tx`
        SELECT id, tenant_id, content_document_id, sequence, block_type, char_start, char_end, text
        FROM content_blocks WHERE content_document_id = ${contentDocId}
        ORDER BY sequence ASC;
      `;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks[0]?.text).toContain("Geneva");

      // 6. chunks
      const chunks = await tx`
        SELECT id, tenant_id, investigation_id, content_document_id, block_ids, char_start, char_end, token_count, text
        FROM chunks WHERE content_document_id = ${contentDocId}
        ORDER BY char_start ASC;
      `;
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0]?.token_count).toBeGreaterThan(0);
      expect(chunks[0]?.text).toBe(rawDocumentText);
      expect(chunks[0]?.block_ids.length).toBeGreaterThanOrEqual(1);
    }, db);
  });

  // ── TEST CASE 2: SYNTHETIC MULTI-PAGE PDF WITH SPAN LOCATORS (REQ-M-FMT-001..003) ──

  it("REQ-M-FMT-001: ingests a real multi-page text-layer PDF end-to-end with GCS write & readback", async () => {
    const pdfBase64 = Buffer.from(syntheticPdfBytes).toString("base64");

    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "omega_corp_dossier.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        content_base64: pdfBase64,
        acquisition_record: {
          origin: "Cantonal Registry Office Zurich",
          custodian: "Compliance Archives",
          acquisition_method: "upload",
        },
      },
    });

    expect(srcRes.statusCode).toBe(201);
    const srcData = JSON.parse(srcRes.body);
    expect(srcData.status).toBe("indexed");
    pdfSourceId = srcData.id;
    pdfSourceSha256 = srcData.sha256;

    // Verify real GCS object write & download
    pdfStorageKey = createSourceStorageKey(tenantId, investigationId, pdfSourceSha256);
    const downloadedBytes = await getObjectStore().get(pdfStorageKey);
    expect(downloadedBytes.byteLength).toBe(syntheticPdfBytes.byteLength);
    expect(computeSha256(downloadedBytes)).toBe(pdfSourceSha256);

    const headMeta = await getObjectStore().head(pdfStorageKey);
    expect(headMeta.sizeBytes).toBe(syntheticPdfBytes.byteLength);
    expect(headMeta.sha256).toBe(pdfSourceSha256);
    expect(headMeta.contentType).toBe("application/pdf");
  });

  it("REQ-M-FMT-001: asserts PDF parser extracts page, block, and span-level locators with exact coordinates", async () => {
    await withTenant(tenantId, async (tx) => {
      const blocks = await tx<{
        id: string;
        sequence: number;
        block_type: string;
        page: number;
        bbox: {
          x0: number;
          y0: number;
          x1: number;
          y1: number;
          page: number;
          spans?: Array<{
            text: string;
            char_start: number;
            char_end: number;
            page: number;
            bbox: { x0: number; y0: number; x1: number; y1: number; page: number };
          }>;
        };
        text: string;
      }[]>`
        SELECT b.id, b.sequence, b.block_type, b.page, b.bbox, b.text
        FROM content_blocks b
        JOIN content_documents cd ON cd.id = b.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${pdfSourceId}
        ORDER BY b.sequence ASC;
      `;

      expect(blocks.length).toBeGreaterThanOrEqual(4);

      // Assert span-level locators exist on all blocks
      for (const block of blocks) {
        const bbox = typeof block.bbox === "string" ? JSON.parse(block.bbox) : block.bbox;
        expect(bbox.spans, `Block sequence ${block.sequence} missing spans array`).toBeDefined();
        expect(bbox.spans.length).toBeGreaterThanOrEqual(1);

        for (const span of bbox.spans) {
          expect(span.text.length).toBeGreaterThan(0);
          expect(span.page).toBe(block.page);
          expect(typeof span.char_start).toBe("number");
          expect(typeof span.char_end).toBe("number");
          expect(span.char_end).toBeGreaterThan(span.char_start);
          expect(typeof span.bbox.x0).toBe("number");
          expect(typeof span.bbox.y0).toBe("number");
          expect(typeof span.bbox.x1).toBe("number");
          expect(typeof span.bbox.y1).toBe("number");
          expect(span.bbox.x1).toBeGreaterThan(span.bbox.x0);
          expect(span.bbox.page).toBe(span.page);
        }
      }
    }, db);
  });

  it("REQ-M-FMT-002: asserts content_blocks carry 1-indexed page number and bounding box (bbox) coordinates", async () => {
    await withTenant(tenantId, async (tx) => {
      // 1. Verify artifact used pdf_structure parser
      const artifacts = await tx`
        SELECT id, parser, status FROM artifacts WHERE source_id = ${pdfSourceId};
      `;
      expect(artifacts.length).toBe(1);
      expect(artifacts[0]?.parser).toBe("pdf_structure");
      expect(artifacts[0]?.status).toBe("ready");
      const artifactId = artifacts[0]?.id;

      // 2. Verify content_document
      const contentDocs = await tx`
        SELECT id, doc_type, full_text FROM content_documents WHERE artifact_id = ${artifactId};
      `;
      expect(contentDocs.length).toBe(1);
      expect(contentDocs[0]?.doc_type).toBe("pdf_document");
      expect(contentDocs[0]?.full_text).toContain("CONFIDENTIAL INVESTIGATION DOSSIER");
      expect(contentDocs[0]?.full_text).toContain("EXHIBIT B: BENEFICIAL OWNERSHIP SCHEDULE");
      const contentDocId = contentDocs[0]?.id;

      // 3. Verify content_blocks structure, pages, and bounding boxes
      const blocks = await tx<{
        id: string;
        sequence: number;
        block_type: string;
        section_path: string;
        page: number;
        char_start: number;
        char_end: number;
        bbox: { x0: number; y0: number; x1: number; y1: number; page: number };
        text: string;
      }[]>`
        SELECT id, sequence, block_type, section_path, page, char_start, char_end, bbox, text
        FROM content_blocks
        WHERE content_document_id = ${contentDocId}
        ORDER BY sequence ASC;
      `;

      expect(blocks.length).toBeGreaterThanOrEqual(4);

      // Verify page distribution across pages 1 and 2
      const page1Blocks = blocks.filter((b) => b.page === 1);
      const page2Blocks = blocks.filter((b) => b.page === 2);
      expect(page1Blocks.length).toBeGreaterThanOrEqual(2);
      expect(page2Blocks.length).toBeGreaterThanOrEqual(2);

      // Verify bounding box (bbox) attributes on every block
      for (const block of blocks) {
        expect(block.page).toBeGreaterThanOrEqual(1);
        expect(block.bbox).toBeDefined();
        const bbox = (typeof block.bbox === "string" ? JSON.parse(block.bbox) : block.bbox) as {
          x0: number;
          y0: number;
          x1: number;
          y1: number;
          page: number;
        };
        expect(typeof bbox.x0).toBe("number");
        expect(typeof bbox.y0).toBe("number");
        expect(typeof bbox.x1).toBe("number");
        expect(typeof bbox.y1).toBe("number");
        expect(bbox.page).toBe(block.page);
        expect(bbox.x1).toBeGreaterThan(bbox.x0);
        expect(block.char_end).toBeGreaterThan(block.char_start);
      }

      // Check specific text content on distinct pages
      expect(page1Blocks.some((b) => b.text.includes("CONFIDENTIAL INVESTIGATION DOSSIER"))).toBe(true);
      expect(page1Blocks.some((b) => b.text.includes("Omega Corp executed a transfer"))).toBe(true);
      expect(page2Blocks.some((b) => b.text.includes("EXHIBIT B: BENEFICIAL OWNERSHIP SCHEDULE"))).toBe(true);
      expect(page2Blocks.some((b) => b.text.includes("Viktor Vance via Cyprus intermediary"))).toBe(true);

      console.log("\n=================== SYNTHETIC PDF BLOCKS WITH LOCATORS ===================");
      console.log(JSON.stringify(blocks, null, 2));
    }, db);
  });

  it("REQ-M-FMT-003: asserts chunks preserve structural boundaries and record block_ids back to content_blocks", async () => {
    await withTenant(tenantId, async (tx) => {
      const chunks = await tx<{
        id: string;
        block_ids: string[];
        char_start: number;
        char_end: number;
        token_count: number;
        text: string;
        contextual_header: string;
      }[]>`
        SELECT c.id, c.block_ids, c.char_start, c.char_end, c.token_count, c.text, c.contextual_header
        FROM chunks c
        JOIN content_documents cd ON cd.id = c.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${pdfSourceId}
        ORDER BY c.char_start ASC;
      `;

      expect(chunks.length).toBeGreaterThanOrEqual(4);

      // Verify each chunk has a valid non-empty block_ids array referencing existing content_blocks
      for (const chunk of chunks) {
        expect(chunk.block_ids).toBeDefined();
        expect(chunk.block_ids.length).toBeGreaterThanOrEqual(1);
        expect(chunk.token_count).toBeGreaterThan(0);
        expect(chunk.contextual_header).toContain("Page");

        // Verify referenced block exists in database
        const blockLookup = await tx`
          SELECT id, text FROM content_blocks WHERE id = ANY(${chunk.block_ids}::uuid[]);
        `;
        expect(blockLookup.length).toBe(chunk.block_ids.length);
      }

      console.log("\n=================== SYNTHETIC PDF CHUNKS WITH BLOCK LOCATORS ===================");
      console.log(JSON.stringify(chunks, null, 2));
    }, db);
  });

  // ── TEST CASE 3: REAL MATERIAL STRESS FIXTURE (MULTI-COLUMN, TABLE, ROTATED PAGE - R4) ──

  it("R4 / REQ-M-FMT-001: exercises multi-column, table, and rotated page extraction on complex PDF fixture", async () => {
    const complexBase64 = Buffer.from(complexPdfBytes).toString("base64");

    const srcRes = await app.inject({
      method: "POST",
      url: `/v1/investigations/${investigationId}/sources`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        filename: "judicial_inquiry_complex_fixture.pdf",
        mime_type: "application/pdf",
        source_class: "primary_record",
        content_base64: complexBase64,
        acquisition_record: {
          origin: "Vaduz Judicial Commission",
          custodian: "Archives Department",
          acquisition_method: "upload",
        },
      },
    });

    expect(srcRes.statusCode).toBe(201);
    const srcData = JSON.parse(srcRes.body);
    complexPdfSourceId = srcData.id;
    complexPdfSourceSha256 = srcData.sha256;

    // Verify GCS readback for complex fixture
    complexPdfStorageKey = createSourceStorageKey(tenantId, investigationId, complexPdfSourceSha256);
    const downloadedComplex = await getObjectStore().get(complexPdfStorageKey);
    expect(downloadedComplex.byteLength).toBe(complexPdfBytes.byteLength);
    expect(computeSha256(downloadedComplex)).toBe(complexPdfSourceSha256);

    await withTenant(tenantId, async (tx) => {
      // 1. Verify layout confidence flagged on complex/rotated material
      const contentDocs = await tx<{ layout_confidence: string; full_text: string }[]>`
        SELECT cd.layout_confidence, cd.full_text
        FROM content_documents cd
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${complexPdfSourceId};
      `;
      expect(contentDocs.length).toBe(1);
      // Layout confidence lowered appropriately when multi-column/rotated structures are detected (PRD §5.2 Stage 3)
      expect(Number(contentDocs[0]?.layout_confidence)).toBeLessThanOrEqual(0.85);

      // 2. Verify column-separated blocks
      const blocks = await tx<{
        id: string;
        sequence: number;
        block_type: string;
        page: number;
        bbox: { x0: number; y0: number; x1: number; y1: number; page: number; spans?: unknown[] };
        text: string;
      }[]>`
        SELECT b.id, b.sequence, b.block_type, b.page, b.bbox, b.text
        FROM content_blocks b
        JOIN content_documents cd ON cd.id = b.content_document_id
        JOIN artifacts a ON a.id = cd.artifact_id
        WHERE a.source_id = ${complexPdfSourceId}
        ORDER BY b.sequence ASC;
      `;

      // Page 1 multi-column extraction
      const page1Blocks = blocks.filter((b) => b.page === 1);
      const col1Block = page1Blocks.find((b) => b.text.includes("COLUMN 1"));
      const col2Block = page1Blocks.find((b) => b.text.includes("COLUMN 2"));
      expect(col1Block, "Column 1 block identified").toBeDefined();
      expect(col2Block, "Column 2 block identified").toBeDefined();

      const col1Bbox = typeof col1Block!.bbox === "string" ? JSON.parse(col1Block!.bbox) : col1Block!.bbox;
      const col2Bbox = typeof col2Block!.bbox === "string" ? JSON.parse(col2Block!.bbox) : col2Block!.bbox;
      expect(col1Bbox.x0).toBeLessThan(200); // Left column X coordinate
      expect(col2Bbox.x0).toBeGreaterThanOrEqual(300); // Right column X coordinate

      // Table row block extraction
      const tableBlock = page1Blocks.find((b) => b.text.includes("Valartis Bank"));
      expect(tableBlock, "Table data row identified").toBeDefined();

      // Page 2 rotated text extraction
      const page2Blocks = blocks.filter((b) => b.page === 2);
      expect(page2Blocks.length).toBeGreaterThanOrEqual(1);
      expect(page2Blocks.some((b) => b.text.includes("ROTATED APPENDIX C"))).toBe(true);

      console.log("\n=================== COMPLEX MATERIAL FIXTURE BLOCKS ===================");
      console.log(JSON.stringify(blocks, null, 2));
    }, db);
  });

  // ── AUDIT CHAIN OVER ALL INGESTIONS ──────────────────────────────────────────

  it("verifies the cryptographic audit chain over what occurred across all ingestions", async () => {
    await withTenant(tenantId, async (tx) => {
      const result = await verifyTenantAuditChain(tx, tenantId);
      expect(result.valid, `Audit chain broken: ${JSON.stringify(result.break)}`).toBe(true);
      expect(result.verifiedCount).toBeGreaterThanOrEqual(5);

      const heads = await tx`SELECT * FROM audit_chain_heads WHERE tenant_id = ${tenantId};`;
      expect(heads.length).toBe(1);
      expect(Number(heads[0]?.last_seq)).toBe(result.verifiedCount);
      console.log(`--- AUDIT CHAIN VERIFICATION RESULT: valid=${result.valid}, verifiedCount=${result.verifiedCount} ---`);
    }, db);
  });
});
