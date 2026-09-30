import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const SourceClassSchema = z.enum([
  "primary_record",
  "communication",
  "derived_record",
  "published",
  "structured_data",
  "media",
  "investigator_generated",
]);
export type SourceClass = z.infer<typeof SourceClassSchema>;

export const SourceStatusSchema = z.enum([
  "received",
  "scanning",
  "quarantined",
  "admitted",
  "linked",
  "processing",
  "unprocessable",
  "stored_unparsed",
  // In the database since migration 0021; missing here, so the REST routes answered 500 for any
  // source in it (found in BIGDATA-2A, F6).
  "needs_ocr",
  "indexed",
  "withdrawn",
  "purged",
  "held",
]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const AcquisitionMethodSchema = z.enum([
  "upload",
  "folder_import",
  "connector",
  "subpoena",
  "open_source",
  "manual_entry",
]);
export type AcquisitionMethod = z.infer<typeof AcquisitionMethodSchema>;

export const CreateAcquisitionRecordRequestSchema = z.object({
  origin: z.string().min(1),
  custodian: z.string().min(1),
  acquisition_method: AcquisitionMethodSchema.default("upload"),
  authorization_basis: z.string().optional(),
  obtained_at: z.union([IsoDateTimeSchema, z.date()]).optional(),
});
export type CreateAcquisitionRecordRequest = z.infer<typeof CreateAcquisitionRecordRequestSchema>;

export const AcquisitionRecordSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  source_id: UuidSchema,
  origin: z.string(),
  custodian: z.string(),
  acquisition_method: AcquisitionMethodSchema,
  obtained_at: z.union([IsoDateTimeSchema, z.date()]),
  authorization_basis: z.string().nullable().optional(),
  declared_by: UuidSchema.nullable().optional(),
  connector_id: z.string().nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type AcquisitionRecord = z.infer<typeof AcquisitionRecordSchema>;

export const SourceSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  workspace_id: UuidSchema,
  investigation_id: UuidSchema,
  filename: z.string(),
  mime_type: z.string(),
  byte_size: z.number().int(),
  sha256: z.string(),
  storage_uri: z.string(),
  status: SourceStatusSchema,
  source_class: SourceClassSchema,
  withdrawn_reason: z.string().nullable().optional(),
  withdrawn_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  purged_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  is_encrypted: z.boolean().default(false),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
  deleted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const CreateSourceRequestSchema = z.object({
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  byte_size: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  content_base64: z.string().optional(),
  raw_text: z.string().optional(),
  source_class: SourceClassSchema.default("primary_record"),
  acquisition_record: CreateAcquisitionRecordRequestSchema.optional(),
  is_encrypted: z.boolean().optional(),
  password: z.string().optional(),
  is_malware_test: z.boolean().optional(),
  is_zip_bomb_test: z.boolean().optional(),
  ocr_confidence_override: z.number().min(0).max(1).optional(),
});
export type CreateSourceRequest = z.infer<typeof CreateSourceRequestSchema>;

export const WithdrawSourceRequestSchema = z.object({
  reason: z.string().min(1),
});
export type WithdrawSourceRequest = z.infer<typeof WithdrawSourceRequestSchema>;

export const CorrectOcrTextRequestSchema = z.object({
  block_id: UuidSchema,
  corrected_text: z.string().min(1),
});
export type CorrectOcrTextRequest = z.infer<typeof CorrectOcrTextRequestSchema>;

export const SupplyPasswordRequestSchema = z.object({
  password: z.string().min(1),
});
export type SupplyPasswordRequest = z.infer<typeof SupplyPasswordRequestSchema>;

export const NearDuplicateDiffResponseSchema = z.object({
  source_a_id: UuidSchema,
  source_b_id: UuidSchema,
  similarity_score: z.number(),
  diff_summary: z.object({
    added_lines: z.array(z.string()),
    removed_lines: z.array(z.string()),
    changed_clauses: z.array(z.string()),
  }),
});
export type NearDuplicateDiffResponse = z.infer<typeof NearDuplicateDiffResponseSchema>;

export const IngestionJobStageSchema = z.enum([
  "queued",
  "scanning",
  "parsing",
  "ocr",
  "normalizing",
  "chunking",
  "indexing",
  "completed",
  "failed",
]);
export type IngestionJobStage = z.infer<typeof IngestionJobStageSchema>;

export const IngestionJobSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  source_id: UuidSchema,
  stage: IngestionJobStageSchema,
  progress_percent: z.number().int().min(0).max(100),
  error_message: z.string().nullable().optional(),
  dead_letter_payload: z.record(z.unknown()).nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type IngestionJob = z.infer<typeof IngestionJobSchema>;

export const ContentBlockSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  content_document_id: UuidSchema,
  sequence: z.number().int(),
  block_type: z.enum([
    "paragraph",
    "heading",
    "table",
    "table_cell",
    "email_header",
    "transcript_turn",
    "list_item",
    "ocr_page",
  ]),
  section_path: z.string().nullable().optional(),
  page: z.number().int().nullable().optional(),
  char_start: z.number().int(),
  char_end: z.number().int(),
  bbox: z.record(z.unknown()).nullable().optional(),
  text: z.string(),
  text_uri: z.string().nullable().optional(),
  language: z.string().default("en"),
  ocr_confidence: z.number().nullable().optional(),
  is_ocr_corrected: z.boolean().default(false),
  corrected_text: z.string().nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const ChunkSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  content_document_id: UuidSchema,
  block_ids: z.array(UuidSchema).default([]),
  char_start: z.number().int(),
  char_end: z.number().int(),
  text: z.string(),
  contextual_header: z.string().nullable().optional(),
  token_count: z.number().int(),
  doc_type: z.string().nullable().optional(),
  doc_date: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  entity_ids: z.array(UuidSchema).default([]),
  index_generation: z.number().int().default(1),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type Chunk = z.infer<typeof ChunkSchema>;
