import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

// ── Evidence Enums (PRD §19.2) ──────────────────────────────────────────────

export const EvidenceTypeSchema = z.enum([
  "direct",
  "circumstantial",
  "testimonial",
  "documentary",
  "derived",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceWeightSchema = z.enum(["strong", "moderate", "weak"]);
export type EvidenceWeight = z.infer<typeof EvidenceWeightSchema>;

export const EvidenceIntegrityStatusSchema = z.enum([
  "intact",
  "source_withdrawn",
  "span_drift",
  "source_purged",
]);
export type EvidenceIntegrityStatus = z.infer<typeof EvidenceIntegrityStatusSchema>;

export const EvidenceStatusSchema = z.enum([
  "active",
  "superseded",
  "withdrawn",
  "excluded",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceReviewStateSchema = z.enum([
  "unreviewed",
  "reviewed",
  "disputed",
]);
export type EvidenceReviewState = z.infer<typeof EvidenceReviewStateSchema>;

export const EvidenceRoleSchema = z.enum(["supports", "contradicts"]);
export type EvidenceRole = z.infer<typeof EvidenceRoleSchema>;

export const TargetTypeSchema = z.enum([
  "assertion",
  "claim",
  "finding",
  "question",
  "hypothesis",
  "entity",
  "relationship",
]);
export type TargetType = z.infer<typeof TargetTypeSchema>;

// ── Locator & Target Ref Schemas ─────────────────────────────────────────────

export const EvidenceLocatorSchema = z.object({
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  bbox: z
    .object({
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
    })
    .optional(),
});
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

export const TargetRefSchema = z.object({
  target_type: TargetTypeSchema,
  target_id: UuidSchema,
  role: EvidenceRoleSchema.default("supports"),
});
export type TargetRef = z.infer<typeof TargetRefSchema>;

// ── Core Evidence Object (PRD §19.2) ────────────────────────────────────────

export const EvidenceSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  source_id: UuidSchema,
  artifact_id: UuidSchema.nullable().optional(),
  content_block_id: UuidSchema.nullable().optional(),
  locator: EvidenceLocatorSchema,
  cited_text: z.string().min(1),
  span_hash: z.string().length(64),
  context_before: z.string().default(""),
  context_after: z.string().default(""),
  evidence_type: EvidenceTypeSchema.default("documentary"),
  weight: EvidenceWeightSchema.default("moderate"),
  weight_rationale: z.string().nullable().optional(),
  source_assessment_id: UuidSchema.nullable().optional(),
  integrity_status: EvidenceIntegrityStatusSchema.default("intact"),
  status: EvidenceStatusSchema.default("active"),
  exclusion_reason: z.string().nullable().optional(),
  review_state: EvidenceReviewStateSchema.default("unreviewed"),
  version: z.number().int().positive().default(1),
  supersedes_id: UuidSchema.nullable().optional(),
  supports: z.array(TargetRefSchema).default([]),
  contradicts: z.array(TargetRefSchema).default([]),
  admitted_by: UuidSchema,
  admitted_at: z.union([IsoDateTimeSchema, z.date()]),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  deleted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ── Request & Response Schemas ──────────────────────────────────────────────

export const CreateEvidenceRequestSchema = z.object({
  source_id: UuidSchema,
  content_block_id: UuidSchema.optional(),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  quoted_text: z.string().min(1),
  page: z.number().int().positive().optional(),
  bbox: z
    .object({
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
    })
    .optional(),
  evidence_type: EvidenceTypeSchema.default("documentary"),
  weight: EvidenceWeightSchema.default("moderate"),
  weight_rationale: z.string().optional(),
  targets: z.array(TargetRefSchema).default([]),
  allow_synthetic: z.boolean().optional(),
});
export type CreateEvidenceRequest = z.infer<typeof CreateEvidenceRequestSchema>;

export const UpdateEvidenceReviewRequestSchema = z.object({
  review_state: EvidenceReviewStateSchema,
  dispute_rationale: z.string().optional(),
});
export type UpdateEvidenceReviewRequest = z.infer<typeof UpdateEvidenceReviewRequestSchema>;

export const WithdrawEvidenceRequestSchema = z.object({
  exclusion_reason: z.string().min(1),
});
export type WithdrawEvidenceRequest = z.infer<typeof WithdrawEvidenceRequestSchema>;

// ── Provenance Derivation Chain (PRD §56.3 / AC-PRV-04) ──────────────────────

export const ProvenanceDerivationStepSchema = z.object({
  stage: z.string(),
  object_id: z.string(),
  description: z.string(),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.string(),
  actor: z.string().optional(),
});
export type ProvenanceDerivationStep = z.infer<typeof ProvenanceDerivationStepSchema>;

export const EvidenceProvenanceChainSchema = z.object({
  evidence_id: UuidSchema,
  source_id: UuidSchema,
  filename: z.string(),
  sha256: z.string(),
  derivation_chain: z.array(ProvenanceDerivationStepSchema),
  is_complete: z.boolean(),
});
export type EvidenceProvenanceChain = z.infer<typeof EvidenceProvenanceChainSchema>;

// ── Citation Resolution Response (PRD §33 / AC-PRV-02) ──────────────────────

export const CitationResolutionResponseSchema = z.object({
  evidence_id: UuidSchema,
  investigation_id: UuidSchema,
  source: z.object({
    id: UuidSchema,
    filename: z.string(),
    mime_type: z.string(),
    sha256: z.string(),
    storage_uri: z.string(),
    source_class: z.string(),
    status: z.string(),
    custodian: z.string().nullable().optional(),
    origin: z.string().nullable().optional(),
    obtained_at: z.string().nullable().optional(),
  }),
  locator: EvidenceLocatorSchema,
  cited_text: z.string(),
  span_hash: z.string(),
  context_before: z.string(),
  context_after: z.string(),
  integrity_status: EvidenceIntegrityStatusSchema,
  is_broken: z.boolean(),
  weight: EvidenceWeightSchema,
  review_state: EvidenceReviewStateSchema,
  supports: z.array(TargetRefSchema),
  contradicts: z.array(TargetRefSchema),
  rendered_view: z.object({
    display_mode: z.enum(["original_document", "extracted_text"]),
    highlight_bbox: z.record(z.unknown()).nullable().optional(),
    full_text_snippet: z.string(),
  }),
  admitted_by: UuidSchema,
  admitted_at: z.string(),
});
export type CitationResolutionResponse = z.infer<typeof CitationResolutionResponseSchema>;

// ── Span Drift Check Report (PRD §56.3 / AC-PRV-03) ─────────────────────────

export const DriftCheckReportSchema = z.object({
  investigation_id: UuidSchema,
  total_checked: z.number().int().nonnegative(),
  intact_count: z.number().int().nonnegative(),
  drifted_count: z.number().int().nonnegative(),
  drifted_evidence_ids: z.array(UuidSchema),
  broken_findings_count: z.number().int().nonnegative(),
});
export type DriftCheckReport = z.infer<typeof DriftCheckReportSchema>;
