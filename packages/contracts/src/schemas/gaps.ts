import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

// ── Research Gap Type & Priority ─────────────────────────────────────────────
export const GapTypeSchema = z.enum([
  "referenced_but_absent",
  "unanswered_question",
  "single_sourced_critical_claim",
  "unverified_relationship",
  "timeline_discontinuity",
  "missing_document_type",
  "missing_counterparty",
  "unresolved_identity",
  "untested_hypothesis",
  "unadjudicated_contradiction",
  "unexamined_material",
  "coverage_gap",
]);
export type GapType = z.infer<typeof GapTypeSchema>;

export const GapPrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export type GapPriority = z.infer<typeof GapPrioritySchema>;

export const GapStatusSchema = z.enum([
  "open",
  "in_progress",
  "closed",
  "accepted_as_unresolvable",
  "dismissed",
]);
export type GapStatus = z.infer<typeof GapStatusSchema>;

export const GapSuggestedActionSchema = z.object({
  action_type: z.enum([
    "run_search",
    "collect_source",
    "verify_relationship",
    "resolve_entity",
    "adjudicate_contradiction",
    "interview_target",
    "request_connector_data",
    "accept_limitation",
  ]),
  label: z.string(),
  description: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type GapSuggestedAction = z.infer<typeof GapSuggestedActionSchema>;

// ── Research Gap Schema (PRD §25.3) ──────────────────────────────────────────
export const ResearchGapSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  gap_type: GapTypeSchema,
  title: z.string(),
  description: z.string(),
  target_ref: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .nullable()
    .optional(),
  blocks_questions: z.array(UuidSchema).default([]),
  blocks_hypotheses: z.array(UuidSchema).default([]),
  priority: GapPrioritySchema,
  priority_basis: z.string(),
  suggested_actions: z.array(GapSuggestedActionSchema).default([]),
  status: GapStatusSchema,
  resolution_rationale: z.string().nullable().optional(),
  closure_evidence_ids: z.array(UuidSchema).default([]),
  task_ids: z.array(UuidSchema).default([]),
  created_by: UuidSchema.nullable().optional(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type ResearchGap = z.infer<typeof ResearchGapSchema>;

// ── Close Gap Request ────────────────────────────────────────────────────────
export const CloseGapRequestSchema = z.object({
  rationale: z.string().min(1, "Closure rationale is mandatory"),
  evidence_ids: z.array(UuidSchema).optional().default([]),
});
export type CloseGapRequest = z.infer<typeof CloseGapRequestSchema>;

// ── Accept Gap as Unresolvable Request (PRD §25.5 / AC-GAP-03) ───────────────
export const AcceptGapAsUnresolvableRequestSchema = z.object({
  rationale: z.string().min(1, "Rationale explaining why gap is unresolvable is mandatory"),
});
export type AcceptGapAsUnresolvableRequest = z.infer<typeof AcceptGapAsUnresolvableRequestSchema>;
