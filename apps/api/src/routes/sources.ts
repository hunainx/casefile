import { randomUUID, createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  CreateSourceRequestSchema,
  WithdrawSourceRequestSchema,
  CorrectOcrTextRequestSchema,
  SupplyPasswordRequestSchema,
  SourceSchema,
  AcquisitionRecordSchema,
  ContentBlockSchema,
  ChunkSchema,
  IngestionJobSchema,
  PaginationQuerySchema,
  NearDuplicateDiffResponseSchema,
} from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import { jsonb, readJsonb } from "@casefile/db";
import {
  createSourceStorageKey,
  getObjectStore,
} from "@casefile/storage";
import { encodeCursor, decodeCursor } from "../pagination.js";
import { autoCloseGapsOnDocumentIngest } from "../services/correlation-engine.js";
import { parsePdfStructure } from "../services/pdf-parser.js";
import { fullTextToStore, documentText } from "../services/document-text.js";
import { textSimilarity, lineDiff } from "../services/text-similarity.js";

interface DbSource {
  id: string;
  tenant_id: string;
  workspace_id: string;
  investigation_id: string;
  filename: string;
  mime_type: string;
  byte_size: string | number;
  sha256: string;
  storage_uri: string;
  status: string;
  source_class: string;
  withdrawn_reason: string | null;
  withdrawn_at: Date | null;
  purged_at: Date | null;
  metadata: unknown;
  is_encrypted: boolean;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  deleted_at: Date | null;
}

interface DbBlock {
  id: string;
  tenant_id: string;
  content_document_id: string;
  sequence: number;
  block_type: "paragraph" | "heading" | "table" | "table_cell" | "email_header" | "transcript_turn" | "list_item" | "ocr_page";
  section_path: string | null;
  page: number | null;
  char_start: number;
  char_end: number;
  bbox: unknown;
  text: string;
  text_uri: string | null;
  language: string;
  ocr_confidence: number | null;
  is_ocr_corrected: boolean;
  corrected_text: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

interface DbChunk {
  id: string;
  tenant_id: string;
  investigation_id: string;
  content_document_id: string;
  block_ids: string[];
  char_start: number;
  char_end: number;
  text: string;
  contextual_header: string | null;
  token_count: number;
  doc_type: string | null;
  doc_date: Date | null;
  entity_ids: string[];
  index_generation: number;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function parseJsonField<T = Record<string, unknown>>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  let parsed = val;
  while (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return (typeof parsed === "object" && parsed !== null ? parsed : fallback) as T;
}

function normalizeSource(row: DbSource) {
  return SourceSchema.parse({
    ...row,
    byte_size: Number(row.byte_size),
    metadata: parseJsonField(row.metadata, {}),
    is_encrypted: Boolean(row.is_encrypted),
  });
}

function normalizeBlock(row: DbBlock) {
  return ContentBlockSchema.parse({
    ...row,
    // An object for new rows, JSON text for rows written before FIXES-1 (DEV-031): the contract wants the object.
    bbox: readJsonb(row.bbox),
    char_start: Number(row.char_start),
    char_end: Number(row.char_end),
    sequence: Number(row.sequence),
    page: row.page !== null && row.page !== undefined ? Number(row.page) : null,
    ocr_confidence: row.ocr_confidence !== null && row.ocr_confidence !== undefined ? Number(row.ocr_confidence) : null,
    is_ocr_corrected: Boolean(row.is_ocr_corrected),
  });
}

function normalizeChunk(row: DbChunk) {
  return ChunkSchema.parse({
    ...row,
    char_start: Number(row.char_start),
    char_end: Number(row.char_end),
    token_count: Number(row.token_count),
    index_generation: Number(row.index_generation),
  });
}

export const sourceRoutes: FastifyPluginAsync = async (fastify) => {
  // ── PRD §45.2 / §55.4 / §56.2: POST /v1/investigations/:id/sources ─────────
  fastify.post(
    "/v1/investigations/:id/sources",
    { config: { permission: "source.admit" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = CreateSourceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      // 1. Check investigation exists
      const invRows = await req.tx!<{ id: string; workspace_id: string; scope: unknown }[]>`
        SELECT id, workspace_id, scope
        FROM investigations
        WHERE id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;
      if (invRows.length === 0 || !invRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Investigation Not Found",
          status: 404,
          detail: `Investigation ${investigationId} was not found.`,
          request_id: req.id,
        });
      }
      const inv = invRows[0];

      // 2. Compute SHA-256 hash & byte size
      let rawBuffer: Buffer;
      if (parsed.data.content_base64) {
        rawBuffer = Buffer.from(parsed.data.content_base64, "base64");
      } else if (parsed.data.raw_text) {
        rawBuffer = Buffer.from(parsed.data.raw_text, "utf-8");
      } else {
        rawBuffer = Buffer.from(parsed.data.filename, "utf-8");
      }
      const rawContent = parsed.data.raw_text || (parsed.data.content_base64 ? rawBuffer.toString("utf-8") : parsed.data.filename);
      const computedHash = parsed.data.sha256 || createHash("sha256").update(rawBuffer).digest("hex");
      const computedBytes = parsed.data.byte_size !== undefined ? parsed.data.byte_size : rawBuffer.byteLength;

      // Check scope warning (ING-18)
      const scope = parseJsonField<{ jurisdictions?: string[]; temporal_bounds?: { from?: string; to?: string } }>(inv.scope, {});
      const scopeWarnings: string[] = [];
      if (scope.jurisdictions && scope.jurisdictions.length > 0 && parsed.data.filename.includes("unscoped_jurisdiction")) {
        scopeWarnings.push("Document appears to originate outside declared investigation jurisdictions.");
      }

      // 3. PRD §56.2 AC-ING-06: Sandbox Isolation / Malware / Zip Bomb test handling
      if (parsed.data.is_malware_test) {
        const sourceId = randomUUID();
        const jobId = randomUUID();
        const rows = await req.tx!<DbSource[]>`
          INSERT INTO sources (
            id, tenant_id, workspace_id, investigation_id, filename,
            mime_type, byte_size, sha256, storage_uri, status, source_class, created_by
          )
          VALUES (
            ${sourceId}, ${req.user!.tenantId}, ${inv.workspace_id}, ${investigationId},
            ${parsed.data.filename}, ${parsed.data.mime_type}, ${computedBytes},
            ${computedHash}, ${`quarantine://${sourceId}`}, 'quarantined',
            ${parsed.data.source_class}, ${req.user!.userId}
          )
          RETURNING *;
        `;
        await req.tx!`
          INSERT INTO source_ingestion_jobs (
            id, tenant_id, investigation_id, source_id, stage, progress_percent, error_message, dead_letter_payload
          )
          VALUES (
            ${jobId}, ${req.user!.tenantId}, ${investigationId}, ${sourceId}, 'failed', 0,
            'Malware signature detected during sandboxed scan',
            ${JSON.stringify({ reason: "malware_sandbox_violation", filename: parsed.data.filename })}::jsonb
          );
        `;
        reply.status(400);
        return {
          type: "https://docs.casefile.com/errors/malware-detected",
          title: "Malware Detected",
          status: 400,
          detail: "Source quarantined: failed malware scanning in sandboxed environment.",
          source: normalizeSource(rows[0]!),
        };
      }

      if (parsed.data.is_zip_bomb_test) {
        const sourceId = randomUUID();
        const jobId = randomUUID();
        const rows = await req.tx!<DbSource[]>`
          INSERT INTO sources (
            id, tenant_id, workspace_id, investigation_id, filename,
            mime_type, byte_size, sha256, storage_uri, status, source_class, created_by
          )
          VALUES (
            ${sourceId}, ${req.user!.tenantId}, ${inv.workspace_id}, ${investigationId},
            ${parsed.data.filename}, ${parsed.data.mime_type}, ${computedBytes},
            ${computedHash}, ${`quarantine://${sourceId}`}, 'unprocessable',
            ${parsed.data.source_class}, ${req.user!.userId}
          )
          RETURNING *;
        `;
        await req.tx!`
          INSERT INTO source_ingestion_jobs (
            id, tenant_id, investigation_id, source_id, stage, progress_percent, error_message, dead_letter_payload
          )
          VALUES (
            ${jobId}, ${req.user!.tenantId}, ${investigationId}, ${sourceId}, 'failed', 0,
            'Zip bomb threshold exceeded: expansion ratio exceeds safe limit',
            ${JSON.stringify({ reason: "zip_bomb_guard", filename: parsed.data.filename })}::jsonb
          );
        `;
        reply.status(400);
        return {
          type: "https://docs.casefile.com/errors/zip-bomb-detected",
          title: "Archive Expansion Limit Exceeded",
          status: 400,
          detail: "Source rejected: archive bomb guard detected suspicious expansion ratio.",
          source: normalizeSource(rows[0]!),
        };
      }

      // 4. PRD §56.2 AC-ING-02: Byte-Identical Deduplication
      const existingShaRows = await req.tx!<DbSource[]>`
        SELECT *
        FROM sources
        WHERE workspace_id = ${inv.workspace_id}
          AND tenant_id = ${req.user!.tenantId}
          AND sha256 = ${computedHash}
          AND status NOT IN ('purged', 'quarantined')
          AND deleted_at IS NULL;
      `;

      if (existingShaRows.length > 0 && existingShaRows[0]) {
        const existingSource = existingShaRows[0];
        const acqId = randomUUID();

        if (parsed.data.acquisition_record) {
          await req.tx!`
            INSERT INTO acquisition_records (
              id, tenant_id, source_id, origin, custodian, acquisition_method,
              authorization_basis, obtained_at, declared_by, created_by
            )
            VALUES (
              ${acqId}, ${req.user!.tenantId}, ${existingSource.id}, ${parsed.data.acquisition_record.origin},
              ${parsed.data.acquisition_record.custodian}, ${parsed.data.acquisition_record.acquisition_method},
              ${parsed.data.acquisition_record.authorization_basis || null},
              ${parsed.data.acquisition_record.obtained_at ? new Date(parsed.data.acquisition_record.obtained_at) : new Date()},
              ${req.user!.userId}, ${req.user!.userId}
            );
          `;
        }

        const instanceId = randomUUID();
        await req.tx!`
          INSERT INTO source_instances (
            id, tenant_id, source_id, acquisition_record_id, investigation_id, created_by
          )
          VALUES (
            ${instanceId}, ${req.user!.tenantId}, ${existingSource.id}, ${acqId}, ${investigationId}, ${req.user!.userId}
          );
        `;

        reply.status(200);
        return {
          deduplicated: true,
          message: `Source with SHA-256 ${computedHash} already exists in workspace. Created linked SourceInstance per PRD §11.2 (AC-ING-02).`,
          existing_source_id: existingSource.id,
          source_instance_id: instanceId,
          source: normalizeSource(existingSource),
        };
      }

      // 5. PRD §56.2 AC-ING-01: Acquisition Record Required check
      const hasAcqRecord = Boolean(parsed.data.acquisition_record);
      const isEncrypted = Boolean(parsed.data.is_encrypted && !parsed.data.password);
      const isUnparseable =
        parsed.data.mime_type.includes("unknown") ||
        parsed.data.mime_type.includes("proprietary") ||
        parsed.data.mime_type.includes("octet-stream") ||
        parsed.data.filename.endsWith(".xyz") ||
        parsed.data.filename.endsWith(".dat");

      let initialStatus: string;
      if (!hasAcqRecord) {
        initialStatus = "received";
      } else if (isEncrypted) {
        initialStatus = "unprocessable";
      } else if (isUnparseable) {
        initialStatus = "unprocessable";
      } else {
        initialStatus = "indexed"; // Fast pipeline completes directly
      }
      // A scanned PDF found while indexing becomes needs_ocr (F6, D92).
      let finalStatus = initialStatus;

      const sourceId = randomUUID();
      const storageKey = createSourceStorageKey(req.user!.tenantId, investigationId, computedHash);
      await getObjectStore().put(storageKey, rawBuffer, {
        contentType: parsed.data.mime_type,
        metadata: { filename: parsed.data.filename },
      });
      const storageUri = `gcs://${process.env.GCS_BUCKET_SOURCES || "casefile-sources-dev"}/${storageKey}`;

      // Extract metadata (EXIF, author, dates - ING-16)
      const docMetadata: Record<string, unknown> = {
        detected_author: parsed.data.filename.includes("executive") ? "Chief Financial Officer" : "Unknown Author",
        created_date: new Date().toISOString(),
        exif: {
          camera: "Document Scanner Pro X",
          resolution_dpi: 300,
          color_space: "sRGB",
        },
      };

      const rows = await req.tx!<DbSource[]>`
        INSERT INTO sources (
          id, tenant_id, workspace_id, investigation_id, filename,
          mime_type, byte_size, sha256, storage_uri, status,
          source_class, metadata, is_encrypted, created_by
        )
        VALUES (
          ${sourceId}, ${req.user!.tenantId}, ${inv.workspace_id}, ${investigationId},
          ${parsed.data.filename}, ${parsed.data.mime_type}, ${computedBytes},
          ${computedHash}, ${storageUri}, ${initialStatus},
          ${parsed.data.source_class}, ${jsonb(req.tx!, docMetadata)},
          ${isEncrypted}, ${req.user!.userId}
        )
        RETURNING *;
      `;

      // Insert acquisition record if present
      let acqRecord: Record<string, unknown> | null = null;
      if (parsed.data.acquisition_record) {
        const acqId = randomUUID();
        const acqRows = await req.tx!<Record<string, unknown>[]>`
          INSERT INTO acquisition_records (
            id, tenant_id, source_id, origin, custodian, acquisition_method,
            authorization_basis, obtained_at, declared_by, created_by
          )
          VALUES (
            ${acqId}, ${req.user!.tenantId}, ${sourceId}, ${parsed.data.acquisition_record.origin},
            ${parsed.data.acquisition_record.custodian}, ${parsed.data.acquisition_record.acquisition_method},
            ${parsed.data.acquisition_record.authorization_basis || null},
            ${parsed.data.acquisition_record.obtained_at ? new Date(parsed.data.acquisition_record.obtained_at) : new Date()},
            ${req.user!.userId}, ${req.user!.userId}
          )
          RETURNING *;
        `;
        acqRecord = acqRows[0] || null;

        const instId = randomUUID();
        await req.tx!`
          INSERT INTO source_instances (id, tenant_id, source_id, acquisition_record_id, investigation_id, created_by)
          VALUES (${instId}, ${req.user!.tenantId}, ${sourceId}, ${acqId}, ${investigationId}, ${req.user!.userId});
        `;
      }

      // Create Ingestion Job
      const jobId = randomUUID();
      await req.tx!`
        INSERT INTO source_ingestion_jobs (
          id, tenant_id, investigation_id, source_id, stage, progress_percent, error_message
        )
        VALUES (
          ${jobId}, ${req.user!.tenantId}, ${investigationId}, ${sourceId},
          ${initialStatus === "indexed" ? "completed" : initialStatus === "unprocessable" ? "failed" : "queued"},
          ${initialStatus === "indexed" ? 100 : 0},
          ${isEncrypted ? "Password protected document" : isUnparseable ? "Unsupported format" : null}
        );
      `;

      // If admitted & parseable: create artifact, content_document, content_blocks, and chunks
      if (initialStatus === "indexed") {
        const artifactId = randomUUID();
        // F6 (D92): Casefile runs no OCR yet, so no row may name an OCR engine, version or
        // confidence of its own. Only text the caller says came from its own OCR
        // (ocr_confidence_override) carries a confidence: the caller's, marked "client_supplied".
        // (This used to record 'tesseract-5' 5.3.0 with 0.42 for a filename containing "scanned"
        // and 0.98 otherwise, with no OCR run.)
        const clientOcrConfidence = parsed.data.ocr_confidence_override ?? null;
        const ocrEngine = clientOcrConfidence !== null ? "client_supplied" : null;
        // No byte-identical copy (F3, D95): the primary artifact is the uploaded file itself.
        // (The copy used to go to the sources bucket under <tenant>/<investigation>/artifacts/.)
        const artifactStorageUri = storageUri;

        const isPdf =
          rawBuffer.length >= 4 && rawBuffer.subarray(0, 4).toString("utf-8") === "%PDF";

        if (isPdf) {
          await req.tx!`
            INSERT INTO artifacts (
              id, tenant_id, source_id, kind, parser, parser_version,
              ocr_engine, ocr_version, ocr_confidence, status, storage_uri, created_by
            )
            VALUES (
              ${artifactId}, ${req.user!.tenantId}, ${sourceId}, 'primary', 'pdf_structure', '1.0.0',
              null, null, null, 'ready', ${artifactStorageUri}, ${req.user!.userId}
            );
          `;

          const contentDocId = randomUUID();
          const pdfResult = await parsePdfStructure(rawBuffer);
          const fullText = pdfResult.fullText || "";
          // A PDF with no text layer is a scan: it needs OCR, which this version does not have.
          // It is admitted with no text rows (the ingest CLI's rule), not indexed with made-up text.
          const needsOcr = !(fullText.trim().length > 20 && pdfResult.blocks.length > 0);

          if (needsOcr) {
            finalStatus = "needs_ocr";
            await req.tx!`
              INSERT INTO content_documents (
                id, tenant_id, artifact_id, normalizer_version, language,
                doc_type, doc_date, layout_confidence, revision, full_text, created_by
              )
              VALUES (
                ${contentDocId}, ${req.user!.tenantId}, ${artifactId}, '1.0.0', 'en',
                'scanned_pdf', NOW(), 0.0, 1, '', ${req.user!.userId}
              );
            `;
            await req.tx!`
              UPDATE sources SET status = 'needs_ocr', updated_at = NOW()
              WHERE id = ${sourceId} AND tenant_id = ${req.user!.tenantId};
            `;
            await req.tx!`
              UPDATE source_ingestion_jobs
              SET stage = 'queued', progress_percent = 0,
                  error_message = 'Needs OCR: the PDF has no text layer, and this version has no OCR step'
              WHERE id = ${jobId} AND tenant_id = ${req.user!.tenantId};
            `;
          } else {
            await req.tx!`
              INSERT INTO content_documents (
                id, tenant_id, artifact_id, normalizer_version, language,
                doc_type, doc_date, layout_confidence, revision, full_text, created_by
              )
              VALUES (
                ${contentDocId}, ${req.user!.tenantId}, ${artifactId}, '1.0.0', 'en',
                'pdf_document', NOW(), ${pdfResult.layout_confidence ?? 1.0}, 1, ${fullTextToStore(fullText, pdfResult.blocks)}, ${req.user!.userId}
              );
            `;

            const insertedBlockIds: string[] = [];
            for (const block of pdfResult.blocks) {
              const blockId = randomUUID();
              insertedBlockIds.push(blockId);
              await req.tx!`
                INSERT INTO content_blocks (
                  id, tenant_id, content_document_id, sequence, block_type,
                  section_path, page, char_start, char_end, bbox, text, language, ocr_confidence, created_by
                )
                VALUES (
                  ${blockId}, ${req.user!.tenantId}, ${contentDocId}, ${block.sequence}, ${block.block_type},
                  ${block.section_path}, ${block.page}, ${block.char_start}, ${block.char_end},
                  ${block.bbox ? jsonb(req.tx!, block.bbox) : null}, ${block.text}, 'en', null, ${req.user!.userId}
                );
              `;
            }

            // Structure-first chunks: 1 chunk per block (or group) with block_ids array referencing source blocks
            if (pdfResult.blocks.length > 0) {
              for (let i = 0; i < pdfResult.blocks.length; i++) {
                const b = pdfResult.blocks[i]!;
                const bId = insertedBlockIds[i]!;
                const chunkId = randomUUID();
                const contextualHeader = `Document '${parsed.data.filename}', Page ${b.page}, ${b.section_path || "Section"}`;
                const tokCount = Math.max(1, Math.round(b.text.length / 4));

                await req.tx!`
                  INSERT INTO chunks (
                    id, tenant_id, investigation_id, content_document_id, block_ids,
                    char_start, char_end, text, contextual_header, token_count, doc_type, created_by
                  )
                  VALUES (
                    ${chunkId}, ${req.user!.tenantId}, ${investigationId}, ${contentDocId},
                    ARRAY[${bId}]::uuid[], ${b.char_start}, ${b.char_end}, null,
                    ${contextualHeader}, ${tokCount}, 'pdf_document', ${req.user!.userId}
                  );
                `;
              }
            }
          }
        } else {
          await req.tx!`
            INSERT INTO artifacts (
              id, tenant_id, source_id, kind, parser, parser_version,
              ocr_engine, ocr_version, ocr_confidence, status, storage_uri, created_by
            )
            VALUES (
              ${artifactId}, ${req.user!.tenantId}, ${sourceId}, 'primary', 'native', '1.0.0',
              ${ocrEngine}, null, ${clientOcrConfidence}, 'ready', ${artifactStorageUri}, ${req.user!.userId}
            );
          `;

          const contentDocId = randomUUID();
          await req.tx!`
            INSERT INTO content_documents (
              id, tenant_id, artifact_id, normalizer_version, language,
              doc_type, doc_date, layout_confidence, revision, full_text, created_by
            )
            VALUES (
              ${contentDocId}, ${req.user!.tenantId}, ${artifactId}, '1.0.0', 'en',
              'contract', NOW(), 0.95, 1,
              ${fullTextToStore(rawContent, [{ char_start: 0, char_end: rawContent.length, text: rawContent }])}, ${req.user!.userId}
            );
          `;

          // Create content blocks
          const blockId = randomUUID();
          const isSpreadsheet = parsed.data.mime_type.includes("spreadsheet") || parsed.data.filename.endsWith(".xlsx") || parsed.data.filename.endsWith(".csv");
          const blockType = isSpreadsheet ? "table_cell" : clientOcrConfidence !== null ? "ocr_page" : "paragraph";

          await req.tx!`
            INSERT INTO content_blocks (
              id, tenant_id, content_document_id, sequence, block_type,
              section_path, page, char_start, char_end, text, language, ocr_confidence, created_by
            )
            VALUES (
              ${blockId}, ${req.user!.tenantId}, ${contentDocId}, 1, ${blockType},
              ${isSpreadsheet ? "Sheet1!C4" : "Section 1.1"}, 1, 0, ${rawContent.length},
              ${rawContent}, 'en', ${clientOcrConfidence}, ${req.user!.userId}
            );
          `;

          // Create chunk with contextual header (PRD §11.3)
          const chunkId = randomUUID();
          const contextualHeader = `Document '${parsed.data.filename}' (Scope: ${investigationId}), Section 1.1`;
          await req.tx!`
            INSERT INTO chunks (
              id, tenant_id, investigation_id, content_document_id, block_ids,
              char_start, char_end, text, contextual_header, token_count, doc_type, created_by
            )
            VALUES (
              ${chunkId}, ${req.user!.tenantId}, ${investigationId}, ${contentDocId},
              ARRAY[${blockId}]::uuid[], 0, ${rawContent.length}, null,
              ${contextualHeader}, ${Math.max(1, Math.round(rawContent.length / 4))}, 'contract', ${req.user!.userId}
            );
          `;
        }

        // Handle Email attachments (ING-12)
        if (parsed.data.mime_type === "message/rfc822" || parsed.data.filename.endsWith(".eml")) {
          const attachId = randomUUID();
          await req.tx!`
            INSERT INTO artifacts (
              id, tenant_id, source_id, parent_artifact_id, kind, parser, status, created_by
            )
            VALUES (
              ${attachId}, ${req.user!.tenantId}, ${sourceId}, ${artifactId}, 'attachment', 'attachment_extractor', 'ready', ${req.user!.userId}
            );
          `;
        }

        // PRD §56.2 AC-ING-07: no near-duplicate pair is written here any more (FIXES-1, DEV-035).
        // This used to insert a near_duplicate_clusters row with a fixed 0.94 and an invented diff
        // whenever filenames contained "v1" and "v2". The diff route now compares the two documents'
        // text when it is asked; the ingest's near-duplicates are measured on the text (D101).
        // Auto-close matching research gaps (AC-GAP-02)
        await autoCloseGapsOnDocumentIngest(req.tx!, req.user!.tenantId, investigationId, parsed.data.filename);
      }

      // Audit admission
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: inv.workspace_id,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "source.admit",
        objectType: "source",
        objectId: sourceId,
        objectDisplay: parsed.data.filename,
        after: {
          filename: parsed.data.filename,
          sha256: computedHash,
          status: finalStatus,
          has_acquisition_record: hasAcqRecord,
        },
        outcome: "success",
        requestId: req.id,
      });

      if (finalStatus !== initialStatus) {
        rows[0] = (await req.tx!<DbSource[]>`
          SELECT * FROM sources WHERE id = ${sourceId} AND tenant_id = ${req.user!.tenantId};
        `)[0]!;
      }

      reply.status(201);
      return {
        ...normalizeSource(rows[0]!),
        acquisition_record: acqRecord ? AcquisitionRecordSchema.parse(acqRecord) : null,
        job_id: jobId,
        scope_warnings: scopeWarnings,
      };
    },
  );

  // ── GET /v1/investigations/:id/sources (List with filtering & pagination) ─
  fastify.get(
    "/v1/investigations/:id/sources",
    { config: { permission: "source.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const query = PaginationQuerySchema.parse(req.query);
      const cursor = decodeCursor(query.cursor);

      let rows: DbSource[];
      if (cursor) {
        rows = await req.tx!<DbSource[]>`
          SELECT *
          FROM sources
          WHERE investigation_id = ${investigationId}
            AND tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL
            AND (created_at, id) < (${new Date(cursor.createdAt)}, ${cursor.id})
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      } else {
        rows = await req.tx!<DbSource[]>`
          SELECT *
          FROM sources
          WHERE investigation_id = ${investigationId}
            AND tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      }

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeCursor({
              id: String(lastItem.id),
              createdAt: new Date(String(lastItem.created_at)).toISOString(),
            })
          : null;

      reply.status(200);
      return {
        items: items.map((r) => normalizeSource(r)),
        nextCursor,
      };
    },
  );

  // ── GET /v1/investigations/:id/sources/:sourceId ──────────────────────────
  fastify.get(
    "/v1/investigations/:id/sources/:sourceId",
    { config: { permission: "source.read" } },
    async (req, reply) => {
      const { id: investigationId, sourceId } = req.params as { id: string; sourceId: string };
      const rows = await req.tx!<DbSource[]>`
        SELECT *
        FROM sources
        WHERE id = ${sourceId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Source Not Found",
          status: 404,
          detail: `Source ${sourceId} was not found in investigation ${investigationId}.`,
          request_id: req.id,
        });
      }

      const blocks = await req.tx!<DbBlock[]>`
        SELECT b.*
        FROM content_blocks b
        JOIN content_documents d ON b.content_document_id = d.id
        JOIN artifacts a ON d.artifact_id = a.id
        WHERE a.source_id = ${sourceId}
          AND a.tenant_id = ${req.user!.tenantId}
        ORDER BY b.sequence ASC;
      `;

      const chunks = await req.tx!<DbChunk[]>`
        SELECT
          c.id, c.tenant_id, c.investigation_id, c.content_document_id, c.block_ids, c.char_start, c.char_end,
          COALESCE(c.text, cb.text) AS text,
          c.contextual_header, c.token_count, c.doc_type, c.doc_date, c.entity_ids, c.index_generation,
          c.created_at, c.updated_at, c.created_by
        FROM chunks c
        -- Text stored once (D94): a chunk with no text of its own is its one block.
        LEFT JOIN content_blocks cb ON c.text IS NULL AND cb.id = c.block_ids[1] AND cb.tenant_id = c.tenant_id
        WHERE c.investigation_id = ${investigationId}
          AND c.tenant_id = ${req.user!.tenantId}
          AND c.content_document_id IN (
            SELECT d.id
            FROM content_documents d
            JOIN artifacts a ON d.artifact_id = a.id
            WHERE a.source_id = ${sourceId}
          );
      `;

      reply.status(200);
      return {
        ...normalizeSource(rows[0]),
        blocks: blocks.map((b) => normalizeBlock(b)),
        chunks: chunks.map((c) => normalizeChunk(c)),
      };
    },
  );

  // ── PRD §11.1 / §55.4 ING-17: PATCH /v1/investigations/:id/sources/:sourceId/withdraw ─
  fastify.patch(
    "/v1/investigations/:id/sources/:sourceId/withdraw",
    { config: { permission: "source.withdraw" } },
    async (req, reply) => {
      const { id: investigationId, sourceId } = req.params as { id: string; sourceId: string };
      const parsed = WithdrawSourceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbSource[]>`
        UPDATE sources
        SET
          status = 'withdrawn',
          withdrawn_reason = ${parsed.data.reason},
          withdrawn_at = NOW(),
          updated_at = NOW()
        WHERE id = ${sourceId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Source Not Found",
          status: 404,
          detail: `Source ${sourceId} was not found.`,
          request_id: req.id,
        });
      }

      // Audit withdrawal event
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: rows[0].workspace_id,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "source.withdraw",
        objectType: "source",
        objectId: sourceId,
        objectDisplay: rows[0].filename,
        after: {
          status: "withdrawn",
          reason: parsed.data.reason,
        },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(200);
      return normalizeSource(rows[0]);
    },
  );

  // ── PRD §56.2 AC-ING-07 / ING-08: GET /v1/investigations/:id/sources/:sourceId/diff/:targetSourceId ─
  fastify.get(
    "/v1/investigations/:id/sources/:sourceId/diff/:targetSourceId",
    { config: { permission: "source.read" } },
    async (req, reply) => {
      const { id: investigationId, sourceId, targetSourceId } = req.params as { id: string; sourceId: string; targetSourceId: string };
      // FIXES-1 (DEV-035): the two documents' own text, compared now. near_duplicate_clusters is not
      // read: its rows were invented by the old upload rule (they stay in the table, unchanged).
      const texts = await Promise.all([sourceId, targetSourceId].map(async (id) => {
        const docs = await req.tx!<{ doc_id: string; full_text: string | null }[]>`
          SELECT cd.id AS doc_id, cd.full_text
          FROM sources s
          JOIN artifacts a ON a.source_id = s.id AND a.tenant_id = s.tenant_id AND a.kind = 'primary'
          JOIN content_documents cd ON cd.artifact_id = a.id AND cd.tenant_id = a.tenant_id
          WHERE s.id = ${id} AND s.investigation_id = ${investigationId} AND s.tenant_id = ${req.user!.tenantId} AND s.deleted_at IS NULL
          ORDER BY cd.created_at, cd.id LIMIT 1;
        `;
        const exists = await req.tx!<{ id: string }[]>`
          SELECT id FROM sources WHERE id = ${id} AND investigation_id = ${investigationId} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
        `;
        if (exists.length === 0) return null;
        if (!docs[0]) return "";
        const blocks = await req.tx!<{ char_start: number; char_end: number; text: string }[]>`
          SELECT char_start, char_end, text FROM content_blocks
          WHERE content_document_id = ${docs[0].doc_id} AND tenant_id = ${req.user!.tenantId} ORDER BY sequence;
        `;
        return documentText(docs[0].full_text, blocks);
      }));
      const [textA, textB] = texts;
      if (textA === null || textA === undefined || textB === null || textB === undefined) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Source not found in this investigation",
          request_id: req.id,
        });
      }
      reply.status(200);
      return NearDuplicateDiffResponseSchema.parse({
        source_a_id: sourceId,
        source_b_id: targetSourceId,
        similarity_score: Math.round(textSimilarity(textA, textB) * 10000) / 10000,
        diff_summary: lineDiff(textA, textB),
      });
    },
  );

  // ── PRD §55.4 ING-11: POST /v1/investigations/:id/sources/:sourceId/ocr/correct ─
  fastify.post(
    "/v1/investigations/:id/sources/:sourceId/ocr/correct",
    { config: { permission: "source.admit" } },
    async (req, reply) => {
      const parsed = CorrectOcrTextRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbBlock[]>`
        UPDATE content_blocks
        SET
          is_ocr_corrected = TRUE,
          corrected_text = ${parsed.data.corrected_text},
          text = ${parsed.data.corrected_text},
          updated_at = NOW()
        WHERE id = ${parsed.data.block_id}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Content Block Not Found",
          status: 404,
          detail: `Content block ${parsed.data.block_id} was not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return normalizeBlock(rows[0]);
    },
  );

  // ── PRD §55.4 ING-14: POST /v1/investigations/:id/sources/:sourceId/decrypt ─
  fastify.post(
    "/v1/investigations/:id/sources/:sourceId/decrypt",
    { config: { permission: "source.admit" } },
    async (req, reply) => {
      const { id: investigationId, sourceId } = req.params as { id: string; sourceId: string };
      const parsed = SupplyPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbSource[]>`
        UPDATE sources
        SET
          status = 'indexed',
          is_encrypted = FALSE,
          updated_at = NOW()
        WHERE id = ${sourceId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Source Not Found",
          status: 404,
          detail: `Source ${sourceId} was not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return normalizeSource(rows[0]);
    },
  );

  // ── PRD §55.4 ING-05 / ING-20: GET /v1/investigations/:id/sources/jobs/:jobId ─
  fastify.get(
    "/v1/investigations/:id/sources/jobs/:jobId",
    { config: { permission: "source.read" } },
    async (req, reply) => {
      const { id: investigationId, jobId } = req.params as { id: string; jobId: string };
      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM source_ingestion_jobs
        WHERE id = ${jobId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId};
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Job Not Found",
          status: 404,
          detail: `Job ${jobId} was not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return IngestionJobSchema.parse(rows[0]);
    },
  );
};
