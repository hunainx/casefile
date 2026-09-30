import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";
import { EpistemicStateSchema } from "./assertions.js";

// ── Enums (PRD §21, §26.2, §43) ─────────────────────────────────────────────

export const AICapabilitySchema = z.enum([
  "synthesis",
  "extraction",
  "entity_resolution",
  "gap_analysis",
  "timeline_construction",
  "contradiction_detection",
  "report_drafting",
]);
export type AICapability = z.infer<typeof AICapabilitySchema>;

export const ActionClassSchema = z.enum(["A", "B", "C", "D"]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const AIResultStatusSchema = z.enum(["completed", "failed", "flagged", "rejected"]);
export type AIResultStatus = z.infer<typeof AIResultStatusSchema>;

export const PlaneSchema = z.enum(["machine", "record"]);
export type Plane = z.infer<typeof PlaneSchema>;

// ── Verification & Grounding Schemas (PRD §28.4 / §56.7) ────────────────────

export const SegmentVerificationSchema = z.object({
  statement: z.string(),
  segment_index: z.number().int().nonnegative(),
  citations: z.array(z.string()).default([]),
  is_supported: z.boolean(),
  entailment_score: z.number().min(0).max(1).default(1.0),
  flagged_reason: z.string().optional(),
});
export type SegmentVerification = z.infer<typeof SegmentVerificationSchema>;

export const VerificationReportSchema = z.object({
  total_segments: z.number().int().nonnegative(),
  verified_segments: z.number().int().nonnegative(),
  ungrounded_segments: z.number().int().nonnegative(),
  numeric_checks_passed: z.boolean().default(true),
  entity_checks_passed: z.boolean().default(true),
  has_prompt_injection: z.boolean().default(false),
  segments: z.array(SegmentVerificationSchema).default([]),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const InsufficiencyNoteSchema = z.object({
  not_established: z.array(z.string()).default([]),
  inquiry_gaps: z.array(z.string()).default([]),
  explanation: z.string().optional(),
});
export type InsufficiencyNote = z.infer<typeof InsufficiencyNoteSchema>;

// ── Core AI Capability Result (PRD §21.1) ───────────────────────────────────

export const AICapabilityResultSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  capability: AICapabilitySchema,
  context_manifest_id: UuidSchema.nullable().optional(),
  prompt_template_hash: z.string(),
  model: z.object({
    provider: z.string(),
    model_id: z.string(),
    version: z.string(),
  }),
  output: z.record(z.unknown()),
  citations: z.array(z.string()).default([]),
  epistemic_state: EpistemicStateSchema.default("Possible"),
  confidence: z.number().min(0).max(1).default(0.5),
  insufficiency: InsufficiencyNoteSchema,
  falsifiers: z.array(z.string()).default([]),
  verification: VerificationReportSchema,
  plane: PlaneSchema.default("machine"),
  promoted_by: UuidSchema.nullable().optional(),
  promoted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  cost: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  latency_ms: z.number().int().nonnegative(),
  status: AIResultStatusSchema.default("completed"),
  created_by: UuidSchema,
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type AICapabilityResult = z.infer<typeof AICapabilityResultSchema>;

// ── Tool Execution Schemas (PRD §26.2 & §60) ────────────────────────────────

export const AIToolExecutionSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  ai_result_id: UuidSchema.nullable().optional(),
  tool_name: z.string(),
  action_class: ActionClassSchema,
  input_params: z.record(z.unknown()),
  output_payload: z.record(z.unknown()),
  confirmed_by: UuidSchema.nullable().optional(),
  status: z.enum(["executed", "pending_approval", "rejected", "failed"]).default("executed"),
  execution_ms: z.number().int().nonnegative(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type AIToolExecution = z.infer<typeof AIToolExecutionSchema>;

// ── Request & Response Schemas ──────────────────────────────────────────────

export const InvokeCapabilityRequestSchema = z.object({
  capability: AICapabilitySchema,
  context_manifest_id: UuidSchema.optional(),
  query: z.string().optional(),
  mock_behavior: z
    .enum(["valid", "malformed", "hallucinated_citations", "injection_compliant", "unauthorized_tool_call"])
    .optional(),
  input_text: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});
export type InvokeCapabilityRequest = z.infer<typeof InvokeCapabilityRequestSchema>;

export const PromoteAIResultRequestSchema = z.object({
  rationale: z.string().min(5),
});
export type PromoteAIResultRequest = z.infer<typeof PromoteAIResultRequestSchema>;

export const ToolExecutionRequestSchema = z.object({
  tool_name: z.string().min(1),
  input_params: z.record(z.unknown()).default({}),
  confirmation_token: z.string().optional(),
  allow_class_d: z.boolean().optional(),
});
export type ToolExecutionRequest = z.infer<typeof ToolExecutionRequestSchema>;
