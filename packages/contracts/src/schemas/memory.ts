import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

// ── Tier 1: Definition Memory ──────────────────────────────────────────────
export const Tier1DefinitionMemorySchema = z.object({
  objective: z.string(),
  questions: z.array(
    z.object({
      id: UuidSchema,
      question: z.string(),
      sequence: z.number(),
      materiality: z.string(),
      status: z.string(),
    }),
  ),
  scope_subjects: z.array(
    z.object({
      descriptor: z.string(),
      subject_type: z.string(),
      role: z.string(),
    }),
  ),
  classification: z.string(),
});
export type Tier1DefinitionMemory = z.infer<typeof Tier1DefinitionMemorySchema>;

// ── Tier 2: State Memory ───────────────────────────────────────────────────
export const Tier2StateMemorySchema = z.object({
  focal_entities: z.array(
    z.object({
      id: UuidSchema,
      canonical_name: z.string(),
      type: z.string(),
      is_focal: z.boolean(),
      confidence: z.number(),
      mention_count: z.number().default(0),
    }),
  ),
  verified_findings: z.array(
    z.object({
      id: UuidSchema,
      statement: z.string(),
      epistemic_state: z.string(),
      verified_by: z.string().nullable().optional(),
    }),
  ),
  open_contradictions: z.array(
    z.object({
      id: UuidSchema,
      severity: z.string(),
      details: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  ),
  open_gaps: z.array(
    z.object({
      id: UuidSchema,
      question_id: UuidSchema.nullable().optional(),
      description: z.string(),
      status: z.string(),
    }),
  ),
  active_hypotheses: z.array(
    z.object({
      id: UuidSchema,
      title: z.string(),
      assessment: z.string(),
      confidence: z.number(),
    }),
  ),
  corpus_profile: z.object({
    total_sources: z.number(),
    total_chunks: z.number(),
    total_entities: z.number(),
    total_assertions: z.number(),
    coverage_ratio: z.number(),
  }),
});
export type Tier2StateMemory = z.infer<typeof Tier2StateMemorySchema>;

// ── Tier 3: Working Memory ─────────────────────────────────────────────────
export const Tier3WorkingMemorySchema = z.object({
  current_view: z.record(z.string(), z.unknown()).default({}),
  recent_searches: z.array(z.string()).default([]),
  recent_exchanges: z.array(z.record(z.string(), z.unknown())).default([]),
  recent_decisions: z.array(z.record(z.string(), z.unknown())).default([]),
  session_ttl_minutes: z.number().default(60),
});
export type Tier3WorkingMemory = z.infer<typeof Tier3WorkingMemorySchema>;

// ── Tier 4: Retrieved Memory ───────────────────────────────────────────────
export const Tier4RetrievedChunkSchema = z.object({
  chunk_id: UuidSchema,
  source_id: UuidSchema,
  text: z.string(),
  locator: z.string().nullable().optional(),
  relevance_score: z.number(),
  retrieval_mode: z.string(),
});
export type Tier4RetrievedChunk = z.infer<typeof Tier4RetrievedChunkSchema>;

// ── Omission Record (PRD §13.3) ───────────────────────────────────────────
export const OmissionRecordSchema = z.object({
  item_id: z.string(),
  item_type: z.enum(["chunk", "entity", "finding", "contradiction", "question", "search_result"]),
  reason: z.enum(["token_budget", "relevance_threshold", "permission_filter", "deduplication"]),
  detail: z.string(),
});
export type OmissionRecord = z.infer<typeof OmissionRecordSchema>;

// ── Token Budget Breakdown ─────────────────────────────────────────────────
export const TokenBudgetSchema = z.object({
  total_allocated: z.number().default(200000),
  system_instructions: z.number().default(3000),
  tier1_used: z.number(),
  tier2_used: z.number(),
  tier3_used: z.number(),
  tier4_used: z.number(),
  response_reserve: z.number().default(15000),
  total_used: z.number(),
  remaining: z.number(),
});
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;

// ── Context Manifest Schema (PRD §13.3) ────────────────────────────────────
export const ContextManifestSchema = z.object({
  id: UuidSchema,
  investigation_id: UuidSchema,
  operation: z.string(),
  tier1: Tier1DefinitionMemorySchema,
  tier2: Tier2StateMemorySchema,
  tier3: Tier3WorkingMemorySchema,
  tier4: z.array(Tier4RetrievedChunkSchema),
  token_budget: TokenBudgetSchema,
  omitted: z.array(OmissionRecordSchema),
  model_target: z.string().default("claude-3-5-sonnet"),
  assembled_at: IsoDateTimeSchema,
});
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

export const AssembleManifestRequestSchema = z.object({
  operation: z.string().min(1),
  model_target: z.string().default("claude-3-5-sonnet"),
  custom_token_limit: z.number().positive().optional(),
  target_chunk_ids: z.array(UuidSchema).optional(),
  working_context: z.record(z.string(), z.unknown()).optional(),
});
export type AssembleManifestRequest = z.infer<typeof AssembleManifestRequestSchema>;

export const UpdateMemoryStateRequestSchema = z.object({
  focal_entity_ids: z.array(UuidSchema).optional(),
  dismissed_gap_ids: z.array(UuidSchema).optional(),
  corrected_summaries: z.record(z.string(), z.string()).optional(),
});
export type UpdateMemoryStateRequest = z.infer<typeof UpdateMemoryStateRequestSchema>;
