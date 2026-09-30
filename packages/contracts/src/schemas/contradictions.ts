import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

// ── Contradiction Status & Severity ──────────────────────────────────────────
export const ContradictionSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type ContradictionSeverity = z.infer<typeof ContradictionSeveritySchema>;

export const ContradictionStatusSchema = z.enum([
  "open",
  "under_review",
  "resolved",
  "irreconcilable",
  "dismissed",
]);
export type ContradictionStatus = z.infer<typeof ContradictionStatusSchema>;

export const ContradictionResolutionTypeSchema = z.enum([
  "a_correct",
  "b_correct",
  "both_partially",
  "both_wrong",
  "not_actually_conflicting",
  "irreconcilable",
  "false_positive",
]);
export type ContradictionResolutionType = z.infer<typeof ContradictionResolutionTypeSchema>;

// ── Contradiction Resolution Schema (PRD §24.3) ──────────────────────────────
export const ContradictionResolutionSchema = z.object({
  type: ContradictionResolutionTypeSchema,
  rationale: z.string().min(1, "Resolution rationale is mandatory (PRD §24.5 / AC-CON-03)"),
  resolved_by: UuidSchema,
  resolved_at: IsoDateTimeSchema,
});
export type ContradictionResolution = z.infer<typeof ContradictionResolutionSchema>;

// ── Suppression Rule Schema (PRD §24.5) ──────────────────────────────────────
export const SuppressionRuleSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  rule_type: z.enum(["assertion_pair", "entity_pattern", "detector_pattern"]),
  pattern: z.record(z.string(), z.unknown()).default({}),
  assertion_pair: z
    .object({
      assertion_a_id: UuidSchema,
      assertion_b_id: UuidSchema,
    })
    .nullable()
    .optional(),
  rationale: z.string().min(1),
  active: z.boolean().default(true),
  created_by: UuidSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type SuppressionRule = z.infer<typeof SuppressionRuleSchema>;

// ── Contradiction Schema (PRD §24.3) ─────────────────────────────────────────
export const ContradictionSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  detector: z.string(),
  detector_class: z.enum(["deterministic", "semantic", "hybrid"]),
  subtype: z.string(),
  assertion_a_id: UuidSchema,
  assertion_b_id: UuidSchema,
  evidence_a_ids: z.array(UuidSchema).default([]),
  evidence_b_ids: z.array(UuidSchema).default([]),
  description: z.string(),
  severity: ContradictionSeveritySchema,
  severity_basis: z.string(),
  affects_questions: z.array(UuidSchema).default([]),
  affects_findings: z.array(UuidSchema).default([]),
  affects_hypotheses: z.array(UuidSchema).default([]),
  status: ContradictionStatusSchema,
  resolution: ContradictionResolutionSchema.nullable().optional(),
  suppression_rule_id: UuidSchema.nullable().optional(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

// ── Adjudicate Contradiction Request ─────────────────────────────────────────
export const AdjudicateContradictionRequestSchema = z.object({
  resolution_type: ContradictionResolutionTypeSchema,
  rationale: z.string().min(1, "Resolution rationale is mandatory (PRD §24.5 / AC-CON-03)"),
  create_suppression_rule: z.boolean().optional().default(false),
});
export type AdjudicateContradictionRequest = z.infer<typeof AdjudicateContradictionRequestSchema>;
