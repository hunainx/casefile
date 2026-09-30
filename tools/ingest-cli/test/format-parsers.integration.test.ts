import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { getDbUrl, withTenant } from "@casefile/db";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory, isPipelineSidecar } from "../src/ingest.js";
import { getInvestigationStatus } from "../src/status.js";
import {
  parseDocx,
  parseDoc,
  parseSpreadsheet,
  parseHtml,
  parseRtf,
  parseEml,
  parseMsg,
  extractZipArchive,
  ZipBombError,
} from "../../../apps/api/src/services/document-parsers.js";
import { parsePdfStructure } from "../../../apps/api/src/services/pdf-parser.js";
import { loadEnv } from "../src/args.js";

loadEnv();

const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `format_test_${Date.now()}`);
// The bootstrap's .env.<matter> file goes next to the ingested folder, not in it: the walk
// ingests dotfiles like any other file since BIGDATA-2A (D90).
const ENV_DIR = `${TEST_DIR}-env`;

/**
 * Fixtures are synthetic files in the repository's test-corpus directory.
 * test-corpus/SOURCES.md lists how each one was generated and what property it carries.
 */
const CORPUS_DIR = join(process.cwd(), "test-corpus");
const fixture = (name: string) => readFileSync(join(CORPUS_DIR, name));

describe("STEP 32 — Format Parsers, Needs OCR Status, Sidecars, Zip, and Email Ingestion", () => {
  let tenantId: string;
  let userId: string;
  let investigationId: string;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(ENV_DIR, { recursive: true });

    const wsName = `Format Ingest Test Workspace ${Date.now()}`;
    const invName = "Step 32 Format Ingest Investigation";

    const bootRes = await bootstrap({
      name: wsName,
      investigationName: invName,
      email: `format-ingest-${Date.now()}@casefile.test`,
      matter: `format-test-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });

    tenantId = bootRes.tenantId;
    userId = bootRes.userId;
    investigationId = bootRes.investigationId;
  });

  afterAll(async () => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
      rmSync(ENV_DIR, { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  // ── 32a: FALSE GREEN ELIMINATION (needs_ocr vs indexed) ────────────────────

  it(
    "32a: scanned PDF lands 'needs_ocr' while text PDF lands 'indexed' using synthetic fixtures",
    async () => {
      // 1. Scanned PDF: page images only, no text layer
      const scannedBuf = await fixture("scanned-agreement.pdf");
      const scannedParse = await parsePdfStructure(scannedBuf);
      expect(scannedParse.blocks.length).toBe(0);
      expect((scannedParse.fullText || "").trim().length).toBe(0);
      expect(scannedParse.pageCount).toBeGreaterThan(1);

      const localScanned = join(TEST_DIR, "scanned_agreement.pdf");
      writeFileSync(localScanned, scannedBuf);

      // 2. Text-layer PDF: a long transcript
      const textBuf = await fixture("text-transcript.pdf");
      const textParse = await parsePdfStructure(textBuf);
      expect(textParse.blocks.length).toBeGreaterThan(100);
      expect(textParse.fullText.length).toBeGreaterThan(100000);
      expect(textParse.pageCount).toBeGreaterThan(100);

      const localText = join(TEST_DIR, "text_transcript.pdf");
      writeFileSync(localText, textBuf);

      const fileResults: Array<{ filename: string; status: string }> = [];
      await ingestDirectory({
        dir: TEST_DIR,
        investigationId,
        tenantId,
        dbUrl: getDbUrl(),
        userId,
        onFileResult: (r) => {
          fileResults.push({ filename: r.filename, status: r.status });
        },
      });

      const scannedLog = fileResults.find((f) => f.filename === "scanned_agreement.pdf");
      expect(scannedLog).toBeDefined();
      expect(scannedLog?.status).toBe("needs_ocr");

      const textLog = fileResults.find((f) => f.filename === "text_transcript.pdf");
      expect(textLog).toBeDefined();
      expect(textLog?.status).toBe("indexed");

      // Verify status reporting reflects needs_ocr
      const status = await getInvestigationStatus({
        investigationId,
        tenantId,
        dbUrl: getDbUrl(),
      });

      expect(status.sourceCounts.needsOcr).toBeGreaterThanOrEqual(1);
      expect(status.sourceCounts.indexed).toBeGreaterThanOrEqual(1);
    },
    90_000
  );

  // ── 32a': A PDF THAT CANNOT BE PARSED IS 'unprocessable', NEVER 'indexed' ──

  it("32a': a corrupt PDF throws from the parser and lands 'unprocessable' with the failed counter incremented", async () => {
    const corruptDir = join(TEST_DIR, "corrupt_pdf_test");
    mkdirSync(corruptDir, { recursive: true });
    // Starts with the PDF magic bytes so it routes to the PDF parser, but is not a PDF.
    const corruptBytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0x41)]);
    writeFileSync(join(corruptDir, "corrupt.pdf"), corruptBytes);

    await expect(parsePdfStructure(corruptBytes)).rejects.toThrow(/PDF parse failed/);

    const fileResults: Array<{ filename: string; status: string; reason?: string | undefined }> = [];
    const summary = await ingestDirectory({
      dir: corruptDir,
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
      userId,
      onFileResult: (r) => {
        fileResults.push({ filename: r.filename, status: r.status, reason: r.reason });
      },
    });

    expect(summary.totalFiles).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.admitted).toBe(0);
    expect(summary.parsed).toBe(0);
    expect(summary.storedUnparsed).toBe(0);
    const log = fileResults.find((f) => f.filename === "corrupt.pdf");
    expect(log?.status).toBe("unprocessable");
    expect(log?.reason).toMatch(/PDF parse failed/);

    // The source row exists and says 'unprocessable'; no content was indexed from it.
    await withTenant(tenantId, async (tx) => {
      const rows = await tx<{ status: string }[]>`
        SELECT status FROM sources
        WHERE tenant_id = ${tenantId} AND investigation_id = ${investigationId} AND filename = 'corrupt.pdf';
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("unprocessable");
      const docs = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM content_documents cd
        JOIN artifacts a ON a.id = cd.artifact_id
        JOIN sources s ON s.id = a.source_id
        WHERE s.tenant_id = ${tenantId} AND s.filename = 'corrupt.pdf';
      `;
      expect(docs[0]?.count).toBe("0");
    });
  });

  // ── 32b: PIPELINE SIDECAR EXCLUSION ────────────────────────────────────────

  it("32b: excludes pipeline sidecars by default and allows --include-sidecars override", async () => {
    // Test helper function isPipelineSidecar
    expect(isPipelineSidecar("results/native/001.json")).toBe(true);
    expect(isPipelineSidecar("results/ocr/page_0.json")).toBe(true);
    expect(isPipelineSidecar("results/msg/headers.json")).toBe(true);
    expect(isPipelineSidecar("results/email_attachments/att_1.json")).toBe(true);
    expect(isPipelineSidecar("results/extraction_manifest.json")).toBe(true);
    expect(isPipelineSidecar("case_documents/results_summary.docx")).toBe(false);
    expect(isPipelineSidecar("evidence/results/final_report.pdf")).toBe(false);

    // Create a subfolder with sidecars
    const sidecarDir = join(TEST_DIR, "sidecar_test");
    const nativeDir = join(sidecarDir, "results", "native");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, "manifest.json"), JSON.stringify({ extracted: true }), "utf-8");
    writeFileSync(join(sidecarDir, "real_evidence.txt"), "Authentic evidence document text.", "utf-8");

    // Ingest with default exclusions: sidecar skipped
    const defaultSummary = await ingestDirectory({
      dir: sidecarDir,
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
      userId,
      includeSidecars: false,
    });

    expect(defaultSummary.skippedSidecars).toBe(1);
    expect(defaultSummary.admitted).toBe(1);

    // Ingest with includeSidecars: true
    const sidecarDir2 = join(TEST_DIR, "sidecar_test_included");
    const nativeDir2 = join(sidecarDir2, "results", "native");
    mkdirSync(nativeDir2, { recursive: true });
    writeFileSync(join(nativeDir2, "manifest_included.json"), JSON.stringify({ extracted: true, runId: 2 }), "utf-8");

    const includeSummary = await ingestDirectory({
      dir: sidecarDir2,
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
      userId,
      includeSidecars: true,
    });

    expect(includeSummary.skippedSidecars).toBe(0);
    expect(includeSummary.admitted).toBe(1);
  });

  // ── 32c: WORD, EXCEL, RTF, HTML EXTRACTIONS (SYNTHETIC FIXTURES) ───────────

  it("32c: extracts DOCX text from test-corpus/summary.docx", async () => {
    const result = await parseDocx(await fixture("summary.docx"));

    expect(result.docType).toBe("word_document");
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.fullText).toContain("DEPOSITION SUMMARY");
    expect(result.fullText).toContain("Summary of Testimony");
    expect(result.fullText.length).toBeGreaterThan(1000);
    for (const b of result.blocks) {
      expect(b.page).toBeNull(); // DOCX has flowable/dynamic pagination
    }
  });

  it("32c: extracts DOC text from test-corpus/legacy.doc", async () => {
    const result = await parseDoc(await fixture("legacy.doc"));

    expect(result.docType).toBe("word_legacy_document");
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.fullText).toContain("ASSIGNMENT AND SUBSTITUTION");
    expect(result.fullText).toContain("undersigned does hereby");
    // The footer is indexed exactly once: word-extractor's getHeaders() includes the footers
    // unless told not to, and parseDoc appends getFooters() itself.
    expect(result.fullText.split("Doe & Roe LLP - Example Footer Line").length - 1).toBe(1);
  });

  it("32c: extracts XLSX sheets and maps page numbers from test-corpus/workbook.xlsx", async () => {
    const result = await parseSpreadsheet(await fixture("workbook.xlsx"));

    expect(result.docType).toBe("spreadsheet");
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.fullText).toContain("Purchase Price");
    expect(result.fullText).toContain("1031 Expenses");
    expect(result.blocks[0]?.page).toBe(1); // Mapped to sheet index 1
    expect(result.blocks[0]?.block_type).toBe("table");
  });

  it("32c: extracts HTML text without script/style tags from test-corpus/page.html", async () => {
    const result = await parseHtml(await fixture("page.html"));

    expect(result.docType).toBe("html_document");
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.fullText).toContain("Citrix Attachments");
    expect(result.fullText).toContain("Example Wire Instructions.pdf");
    expect(result.fullText).not.toContain("<script");
    expect(result.fullText).not.toContain("<style");
    for (const b of result.blocks) {
      expect(b.page).toBeNull(); // HTML has no static pages
    }
  });

  it("32c: extracts RTF text stripping control words from test-corpus/document.rtf", async () => {
    const result = await parseRtf(await fixture("document.rtf"));

    expect(result.docType).toBe("rtf_document");
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.fullText).not.toContain("{\\rtf1");
    expect(result.fullText).not.toContain("\\par");
    expect(result.fullText).toContain("STIPULATION");
    expect(result.fullText).toContain("referral");
    for (const b of result.blocks) {
      expect(b.page).toBeNull();
    }
  });

  // ── 32d: ZIP EXPANSION AND ZIP BOMB GUARDS ─────────────────────────────────

  it("32d: expands ZIP archive from test-corpus/archive.zip and guards against zip bombs", async () => {
    const zipBuf = await fixture("archive.zip");
    const result = await extractZipArchive(zipBuf);

    expect(result.totalFiles).toBe(2);
    expect(result.entries.map((e) => e.filename)).toEqual(["1.pdf", "1-1.pdf"]);
    expect(result.totalUncompressedBytes).toBeGreaterThan(800000);

    // 1. Guard against uncompressed size bomb
    await expect(
      extractZipArchive(zipBuf, { maxTotalUncompressedBytes: 1000 })
    ).rejects.toThrow(ZipBombError);

    // 2. Guard against nesting depth bomb
    const innerZip = new AdmZip();
    innerZip.addFile("inner.txt", Buffer.from("Inner content"));
    const innerBuf = innerZip.toBuffer();

    const midZip = new AdmZip();
    midZip.addFile("level2.zip", innerBuf);
    const midBuf = midZip.toBuffer();

    const outerZip = new AdmZip();
    outerZip.addFile("level1.zip", midBuf);
    const outerBuf = outerZip.toBuffer();

    // Default maxDepth is 3; with maxDepth: 1, nesting depth 2 trips the guard
    await expect(
      extractZipArchive(outerBuf, { maxDepth: 1 })
    ).rejects.toThrow(ZipBombError);
  });

  // ── 32e: EMAIL EXTRACTION (.eml & .msg) ────────────────────────────────────

  it("32e: extracts RFC822 .eml headers and body from test-corpus/message.eml", async () => {
    const result = await parseEml(await fixture("message.eml"));

    expect(result.docType).toBe("email_message");
    // Structural assertions only: addresses parse, subject present, RFC822 message id.
    expect(result.headers.from).toMatch(/<[^>@\s]+@[^>\s]+>/);
    expect(result.headers.to).toMatch(/<[^>@\s]+@[^>\s]+>/);
    expect(result.headers.to?.split(",").length).toBeGreaterThanOrEqual(2);
    expect(result.headers.subject).toBeTruthy();
    expect(result.headers.subject).not.toBe("(No Subject)");
    expect(result.headers.messageId).toMatch(/^<[^>@\s]+@[^>\s]+>$/);
    expect(result.headers.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);
    expect(result.blocks[0]?.block_type).toBe("email_header");
    expect(result.blocks[1]?.block_type).toBe("paragraph");
  });

  it("32e: extracts Outlook .msg headers, body, and child attachments from test-corpus/message.msg", async () => {
    const result = await parseMsg(await fixture("message.msg"));

    expect(result.docType).toBe("email_message");
    expect(result.headers.from).toMatch(/<[^>@\s]+@[^>\s]+>/);
    // The fixture's one recipient is MAPI_TO; msgreader reports it as recipType "to" (DEV-019).
    expect(result.headers.to).toContain("<jane.doe@acme-holdings.example>");
    expect(result.headers.subject).toBeTruthy();
    expect(result.headers.subject).not.toBe("(No Subject)");
    expect(result.headers.messageId).toMatch(/^<[^>@\s]+@[^>\s]+>$/);
    expect(result.blocks[0]?.block_type).toBe("email_header");
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0]?.filename).toBe("image429c36.PNG");
    expect(result.attachments[0]?.content.length).toBeGreaterThan(0);
  });

  it("32e: ingests .msg email and links child attachment as child source in database", async () => {
    const msgBuf = await fixture("message.msg");

    const emailTestDir = join(TEST_DIR, "email_ingest_test");
    mkdirSync(emailTestDir, { recursive: true });
    writeFileSync(join(emailTestDir, "sample_case_email.msg"), msgBuf);

    const fileResults: Array<{ filename: string; status: string }> = [];
    const summary = await ingestDirectory({
      dir: emailTestDir,
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
      userId,
      onFileResult: (r) => {
        fileResults.push({ filename: r.filename, status: r.status });
      },
    });

    expect(summary.totalFiles).toBe(1);
    expect(summary.admitted).toBe(1);

    // Verify database contains both the email source and its child attachment source linked by metadata.parent_file_id
    await withTenant(tenantId, async (tx) => {
      const emailSources = await tx<{ id: string; filename: string; source_class: string }[]>`
        SELECT id, filename, source_class FROM sources
        WHERE tenant_id = ${tenantId} AND investigation_id = ${investigationId} AND filename = 'sample_case_email.msg';
      `;
      expect(emailSources.length).toBe(1);
      const emailSource = emailSources[0]!;
      expect(emailSource.source_class).toBe("communication");

      const attachmentSources = await tx<{ id: string; filename: string; metadata: Record<string, unknown> | string }[]>`
        SELECT id, filename, metadata FROM sources
        WHERE tenant_id = ${tenantId} AND investigation_id = ${investigationId} AND filename = 'image429c36.PNG';
      `;
      expect(attachmentSources.length).toBe(1);
      const attSource = attachmentSources[0]!;
      const attMetadata = (
        typeof attSource.metadata === "string" ? JSON.parse(attSource.metadata) : attSource.metadata
      ) as Record<string, unknown>;
      expect(attMetadata.parent_email_id).toBe(emailSource.id);
      expect(attMetadata.parent_file_id).toBe(emailSource.id);
      expect(attMetadata.is_email_attachment).toBe(true);
    });
  });
});
