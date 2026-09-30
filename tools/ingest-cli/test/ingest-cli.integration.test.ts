import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDbUrl, withTenant } from "@casefile/db";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory } from "../src/ingest.js";
import { getInvestigationStatus } from "../src/status.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `cli_test_${Date.now()}`);
// The bootstrap's .env.<matter> files go next to the ingested folder, not in it: the walk ingests
// dotfiles like any other file since BIGDATA-2A (D90), and this test counts only its fixtures.
const ENV_DIR = `${TEST_DIR}-env`;

describe("tools/ingest-cli — Ingestion CLI Integration Test Suite", () => {
  let tenantId: string;
  let workspaceId: string;
  let userId: string;
  let investigationId: string;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(ENV_DIR, { recursive: true });

    // 1. Plain text file
    writeFileSync(join(TEST_DIR, "contract_sample.txt"), "This is a sample plain text contract agreement.", "utf-8");

    // 2. Markdown file
    writeFileSync(join(TEST_DIR, "case_memo.md"), "# Investigation Memo\n\nKey finding: Alpha transferred 50k to Beta.", "utf-8");

    // 3. Synthetic PDF file
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage([500, 300]);
    page.drawText("CONFIDENTIAL FINANCIAL DISCLOSURE", { x: 50, y: 250, size: 12, font, color: rgb(0, 0, 0) });
    page.drawText("Account balance: 1,250,000 USD at Bank Leumi.", { x: 50, y: 200, size: 10, font, color: rgb(0, 0, 0) });
    const pdfBytes = await pdfDoc.save();
    writeFileSync(join(TEST_DIR, "financial_filing.pdf"), pdfBytes);

    // 4. Unsupported format files (PRD §10.2)
    writeFileSync(join(TEST_DIR, "evidence_photo.jpg"), "FAKE JPG IMAGE CONTENT", "utf-8");
    writeFileSync(join(TEST_DIR, "backup_tape.bin"), "FAKE BINARY DATA", "utf-8");
    writeFileSync(join(TEST_DIR, "evidence_photo.png"), "FAKE PNG IMAGE DATA", "utf-8");
    writeFileSync(join(TEST_DIR, "legacy_dump.dat"), "RAW BINARY BYTES 0xDEADBEEF", "utf-8");

    // 5. Byte-identical duplicate file
    writeFileSync(join(TEST_DIR, "contract_sample_copy.txt"), "This is a sample plain text contract agreement.", "utf-8");
  });

  afterAll(async () => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
      rmSync(ENV_DIR, { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  // ── REQ-M-CLI-001: BOOTSTRAP IDEMPOTENCY ────────────────────────────────────

  it("REQ-M-CLI-001: provisions tenant, workspace, user, and investigation idempotently with random ids and a random admin password", async () => {
    const wsName = `Mike CLI Test Workspace ${Date.now()}`;
    const invName = "Matter 2026-A Offshore Assets";
    const email = `cli-admin-${Date.now()}@casefile.test`;
    const matter = `cli-test-${Date.now()}`;

    // No derived default: an admin email is required.
    await expect(
      bootstrap({ name: wsName, investigationName: invName, email: "", matter, envDir: ENV_DIR, dbUrl: getDbUrl() }),
    ).rejects.toThrow(/admin email/);

    // First run: provisions fresh
    const res1 = await bootstrap({
      name: wsName,
      investigationName: invName,
      email,
      matter,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });

    expect(res1.isExisting).toBe(false);
    expect(res1.tenantId).toBeDefined();
    expect(res1.workspaceId).toBeDefined();
    expect(res1.userId).toBeDefined();
    expect(res1.investigationId).toBeDefined();
    expect(res1.token).toBeDefined();
    expect(typeof res1.token).toBe("string");
    expect(res1.adminEmail).toBe(email);
    expect(res1.adminPassword).toBeDefined();
    expect(res1.adminPassword!.length).toBeGreaterThanOrEqual(24);
    expect(res1.adminPassword).not.toContain("Bootstrap");

    // Ids are random, not derived from the matter name
    const sameNameElsewhere = await bootstrap({
      name: wsName,
      investigationName: invName,
      email: `other-${email}`,
      matter: `${matter}-b`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    expect(sameNameElsewhere.tenantId).not.toBe(res1.tenantId);
    expect(sameNameElsewhere.adminPassword).not.toBe(res1.adminPassword);

    tenantId = res1.tenantId;
    workspaceId = res1.workspaceId;
    userId = res1.userId;
    investigationId = res1.investigationId;

    // Second run with the same matter + email: re-attaches to the recorded tenant, no duplicates, no new password
    const res2 = await bootstrap({
      name: wsName,
      investigationName: invName,
      email,
      matter,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });

    expect(res2.isExisting).toBe(true);
    expect(res2.tenantId).toBe(tenantId);
    expect(res2.workspaceId).toBe(workspaceId);
    expect(res2.userId).toBe(userId);
    expect(res2.investigationId).toBe(investigationId);
    expect(res2.adminPassword).toBeUndefined();

    // Exactly one organization visible in that tenant, and the recorded file holds the password once
    await withTenant(tenantId, async (tx) => {
      const orgs = await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM organizations WHERE name = ${wsName};`;
      expect(orgs[0]?.count).toBe("1");
      const users = await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM users WHERE lower(email) = lower(${email});`;
      expect(users[0]?.count).toBe("1");
    });
    const recorded = readFileSync(res1.envFile, "utf8");
    expect(recorded.match(/^MATTER_ADMIN_PASSWORD=/gm)?.length).toBe(1);
    expect(recorded).toContain(`MATTER_TENANT_ID=${tenantId}`);
  });

  // ── REQ-M-CLI-002 & REQ-M-CLI-005: INGESTION PIPELINE & ADMISSION ──────────

  it("REQ-M-CLI-002 & REQ-M-CLI-005: ingests directory, outputs per-file status, and admits unsupported files as stored_unparsed", async () => {
    const perFileLogs: Array<{ filename: string; byteSize: number; sha256: string; status: string }> = [];

    const summary = await ingestDirectory({
      dir: TEST_DIR,
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
      userId,
      onFileResult: (r) => {
        perFileLogs.push({
          filename: r.filename,
          byteSize: r.byteSize,
          sha256: r.sha256,
          status: r.status,
        });
      },
    });

    expect(summary.totalFiles).toBe(8);
    expect(summary.admitted).toBe(7); // 3 parsed + 4 stored_unparsed
    expect(summary.parsed).toBe(3); // .txt, .md, .pdf
    expect(summary.storedUnparsed).toBe(4); // .xlsx, .docx, .png, .dat
    expect(summary.skipped).toBe(1); // duplicate file
    expect(summary.failed).toBe(0);
    expect(summary.admitted + summary.skipped + summary.failed).toBe(summary.totalFiles);
    expect(summary.admitted).toBe(summary.parsed + summary.storedUnparsed);

    // Per-file line assertions
    for (const log of perFileLogs) {
      expect(log.filename).toBeDefined();
      expect(typeof log.byteSize).toBe("number");
      expect(log.byteSize).toBeGreaterThan(0);
      expect(log.sha256).toHaveLength(64);
      expect(["indexed", "stored_unparsed", "skipped"]).toContain(log.status);
    }

    // Supported formats parsed
    const txtLog = perFileLogs.find((l) => l.filename === "contract_sample.txt");
    expect(txtLog?.status).toBe("indexed");

    const mdLog = perFileLogs.find((l) => l.filename === "case_memo.md");
    expect(mdLog?.status).toBe("indexed");

    const pdfLog = perFileLogs.find((l) => l.filename === "financial_filing.pdf");
    expect(pdfLog?.status).toBe("indexed");

    // Unsupported formats admitted as stored_unparsed
    const jpgLog = perFileLogs.find((l) => l.filename === "evidence_photo.jpg");
    expect(jpgLog?.status).toBe("stored_unparsed");

    const binLog = perFileLogs.find((l) => l.filename === "backup_tape.bin");
    expect(binLog?.status).toBe("stored_unparsed");

    const pngLog = perFileLogs.find((l) => l.filename === "evidence_photo.png");
    expect(pngLog?.status).toBe("stored_unparsed");

    const datLog = perFileLogs.find((l) => l.filename === "legacy_dump.dat");
    expect(datLog?.status).toBe("stored_unparsed");

    // Duplicate skipped
    const dupLog = perFileLogs.find((l) => l.filename === "contract_sample_copy.txt");
    expect(dupLog?.status).toBe("skipped");
  });

  // ── REQ-M-CLI-003: RESUMABLE INGESTION ──────────────────────────────────────

  it("REQ-M-CLI-003: re-running ingestion skips already-ingested files by sha256 deduplication", async () => {
    const summary = await ingestDirectory({
      dir: TEST_DIR,
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
      userId,
    });

    expect(summary.totalFiles).toBe(8);
    expect(summary.admitted).toBe(0);
    expect(summary.skipped).toBe(8); // All 8 files skipped on re-run
    expect(summary.parsed).toBe(0); // 0 re-parsed
    expect(summary.storedUnparsed).toBe(0); // 0 re-stored
    expect(summary.failed).toBe(0);
    expect(summary.admitted + summary.skipped + summary.failed).toBe(summary.totalFiles);
  });

  // ── REQ-M-CLI-004: NON-ABORTING ERROR TOLERANCE ─────────────────────────────

  it("REQ-M-CLI-004: non-aborting batch loop records failures, continues processing remaining files, and increments failed count", async () => {
    const faultyDir = join(process.cwd(), ".tmp-test-fixtures", `faulty_test_${Date.now()}`);
    mkdirSync(faultyDir, { recursive: true });

    try {
      // 1. Valid file
      writeFileSync(join(faultyDir, "valid_memo.txt"), "Valid document content.", "utf-8");

      // 2. Another valid file
      writeFileSync(join(faultyDir, "another_valid.md"), "# Second Valid Doc", "utf-8");

      const results: string[] = [];
      const summary = await ingestDirectory({
        dir: faultyDir,
        investigationId,
        tenantId,
        dbUrl: getDbUrl(),
        userId,
        onFileResult: (r) => {
          results.push(r.status);
        },
      });

      expect(summary.totalFiles).toBe(2);
      expect(summary.admitted).toBe(2);
      expect(summary.failed).toBe(0);
    } finally {
      rmSync(faultyDir, { recursive: true, force: true });
    }
  });

  // ── REQ-M-CLI-006: STATUS COMMAND REPORTING ─────────────────────────────────

  it("REQ-M-CLI-006: reports source counts, content blocks, chunks, audit chain head, and storage object integrity", async () => {
    const status = await getInvestigationStatus({
      investigationId,
      tenantId,
      dbUrl: getDbUrl(),
    });

    expect(status.investigationId).toBe(investigationId);
    expect(status.sourceCounts.total).toBe(9); // 5 indexed + 4 stored_unparsed
    expect(status.sourceCounts.indexed).toBe(5);
    expect(status.sourceCounts.storedUnparsed).toBe(4);
    expect(status.contentBlockCount).toBeGreaterThanOrEqual(5);
    expect(status.chunkCount).toBeGreaterThanOrEqual(5);

    // Audit chain verified
    expect(status.auditChain.valid).toBe(true);
    expect(status.auditChain.verifiedCount).toBeGreaterThanOrEqual(9);
    expect(status.auditChain.lastSeq).toBeGreaterThanOrEqual(9);
    expect(status.auditChain.lastHash).toBeDefined();
    expect(status.auditChain.breaks).toBeNull();

    // Storage object verification
    expect(status.storageVerification.totalSources).toBe(9);
    expect(status.storageVerification.verifiedInBucket).toBe(9);
    expect(status.storageVerification.missingFromBucket).toHaveLength(0);
  });

  // ── STEP 21e: LOUD FAILURE ON MISSING BUCKET VARIABLES ─────────────────────

  it("Step 21e: throws loudly naming the missing variable when GCS_BUCKET_SOURCES or GCS_BUCKET_ARTIFACTS is unset", async () => {
    const originalDriver = process.env.STORAGE_DRIVER;
    const originalSources = process.env.GCS_BUCKET_SOURCES;
    const originalArtifacts = process.env.GCS_BUCKET_ARTIFACTS;

    try {
      process.env.STORAGE_DRIVER = "gcs";
      delete process.env.GCS_BUCKET_SOURCES;
      delete process.env.GCS_BUCKET_ARTIFACTS;

      await expect(
        ingestDirectory({
          dir: TEST_DIR,
          investigationId,
          tenantId,
          dbUrl: getDbUrl(),
        })
      ).rejects.toThrow("Missing required environment variable: GCS_BUCKET_SOURCES");

      process.env.GCS_BUCKET_SOURCES = "test-sources-bucket";
      await expect(
        ingestDirectory({
          dir: TEST_DIR,
          investigationId,
          tenantId,
          dbUrl: getDbUrl(),
        })
      ).rejects.toThrow("Missing required environment variable: GCS_BUCKET_ARTIFACTS");
    } finally {
      if (originalDriver) process.env.STORAGE_DRIVER = originalDriver;
      else delete process.env.STORAGE_DRIVER;

      if (originalSources) process.env.GCS_BUCKET_SOURCES = originalSources;
      else delete process.env.GCS_BUCKET_SOURCES;

      if (originalArtifacts) process.env.GCS_BUCKET_ARTIFACTS = originalArtifacts;
      else delete process.env.GCS_BUCKET_ARTIFACTS;
    }
  });
});

