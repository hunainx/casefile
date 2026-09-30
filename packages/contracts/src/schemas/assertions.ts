import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const EpistemicStateSchema = z.enum([
  "Unknown",
  "Possible",
  "Likely",
  "Supported",
  "Verified",
  "Contradicted",
  "Refuted",
]);
export type EpistemicState = z.infer<typeof EpistemicStateSchema>;

export const AssertionKindSchema = z.enum([
  "attribute",
  "relationship",
  "event",
  "claim",
  "membership",
  "identity",
]);
export type AssertionKind = z.infer<typeof AssertionKindSchema>;

export const AsserterTypeSchema = z.enum([
  "source",
  "human",
  "model",
  "deterministic",
]);
export type AsserterType = z.infer<typeof AsserterTypeSchema>;

export const ReviewStateSchema = z.enum([
  "unreviewed",
  "in_review",
  "accepted",
  "rejected",
  "superseded",
]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const AssertionPlaneSchema = z.enum(["machine", "record"]);
export type AssertionPlane = z.infer<typeof AssertionPlaneSchema>;

export const AsserterSchema = z.object({
  type: AsserterTypeSchema,
  id: UuidSchema.optional(),
});
export type Asserter = z.infer<typeof AsserterSchema>;

export const CreateAssertionRequestSchema = z.object({
  kind: AssertionKindSchema,
  subject_type: z.string().min(1),
  subject_id: UuidSchema,
  predicate: z.string().min(1),
  object_type: z.string().min(1),
  object_id: UuidSchema.nullable().optional(),
  object_literal: z.record(z.unknown()).nullable().optional(),
  valid_from: z.record(z.unknown()).nullable().optional(),
  valid_to: z.record(z.unknown()).nullable().optional(),
  asserter: AsserterSchema,
  epistemic_state: EpistemicStateSchema.default("Supported"),
  confidence: z.number().min(0).max(1).optional(),
  evidence_ids: z.array(UuidSchema).default([]),
  derivation: z
    .object({
      parents: z.array(z.string()).default([]),
      transform: z.string().default("extractor"),
      transform_version: z.string().default("1.0.0"),
      executed_at: z.string().optional(),
    })
    .optional(),
  discovery_channel: z.string().optional(),
  inference_pattern: z.string().optional(),
});
export type CreateAssertionRequest = z.infer<typeof CreateAssertionRequestSchema>;

export const ValidateAssertionRequestSchema = z.object({
  epistemic_state: z.enum(["Verified", "Refuted"]),
  rationale: z.string().min(1),
});
export type ValidateAssertionRequest = z.infer<typeof ValidateAssertionRequestSchema>;

export const AssertionSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  kind: AssertionKindSchema,
  subject_type: z.string(),
  subject_id: UuidSchema,
  predicate: z.string(),
  object_type: z.string(),
  object_id: UuidSchema.nullable().optional(),
  object_literal: z.record(z.unknown()).nullable().optional(),
  valid_from: z.record(z.unknown()).nullable().optional(),
  valid_to: z.record(z.unknown()).nullable().optional(),
  asserter_type: AsserterTypeSchema,
  asserter_id: UuidSchema,
  epistemic_state: EpistemicStateSchema,
  confidence: z.number().min(0).max(1),
  confidence_basis: z.record(z.unknown()).default({}),
  plane: AssertionPlaneSchema,
  evidence_ids: z.array(UuidSchema).default([]),
  derivation: z.record(z.unknown()).default({}),
  review_state: ReviewStateSchema,
  reviewed_by: UuidSchema.nullable().optional(),
  reviewed_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  review_rationale: z.string().nullable().optional(),
  supersedes: UuidSchema.nullable().optional(),
  superseded_by: UuidSchema.nullable().optional(),
  discovery_channel: z.string().nullable().optional(),
  inference_pattern: z.string().nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
  deleted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const DivergenceNoticeSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  record_assertion_id: UuidSchema,
  machine_assertion_id: UuidSchema,
  divergence_type: z.string(),
  details: z.record(z.unknown()).default({}),
  status: z.enum(["open", "acknowledged", "resolved", "dismissed"]),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type DivergenceNotice = z.infer<typeof DivergenceNoticeSchema>;

export const ContradictionAlertSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  verified_assertion_id: UuidSchema,
  conflicting_assertion_id: UuidSchema,
  severity: z.enum(["low", "medium", "high", "critical"]),
  details: z.record(z.unknown()).default({}),
  status: z.enum(["active", "adjudicated", "dismissed"]),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type ContradictionAlert = z.infer<typeof ContradictionAlertSchema>;
