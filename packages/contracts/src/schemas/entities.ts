import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";
import { EpistemicStateSchema } from "./assertions.js";
import { SubjectRoleSchema, type SubjectRole } from "./investigations.js";

// ── Entity Enums (PRD §14.1, §14.2) ──────────────────────────────────────────

export const EntityTypeSchema = z.enum([
  "Person",
  "Organization",
  "Account",
  "Address",
  "Domain",
  "Email",
  "Phone",
  "Username",
  "Document",
  "Event",
  "Transaction",
  "Asset",
  "Vehicle",
  "Device",
  "Location",
  "Website",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export { SubjectRoleSchema, type SubjectRole };

export const EntitySensitivitySchema = z.enum(["standard", "elevated", "restricted"]);
export type EntitySensitivity = z.infer<typeof EntitySensitivitySchema>;

export const EntityStatusSchema = z.enum(["active", "merged_away", "archived", "disputed"]);
export type EntityStatus = z.infer<typeof EntityStatusSchema>;

export const EntityAliasTypeSchema = z.enum([
  "legal_name",
  "trading_name",
  "former_name",
  "nickname",
  "transliteration",
  "ocr_variant",
  "abbreviation",
  "misspelling",
  "pseudonym",
]);
export type EntityAliasType = z.infer<typeof EntityAliasTypeSchema>;

// ── Entity Aliases (PRD §14.3) ───────────────────────────────────────────────

export const EntityAliasSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  entity_id: UuidSchema,
  value: z.string().min(1).max(255),
  alias_type: EntityAliasTypeSchema.default("trading_name"),
  valid_from: z.record(z.unknown()).nullable().optional(),
  valid_to: z.record(z.unknown()).nullable().optional(),
  confidence: z.number().min(0).max(1).default(0.85),
  source_of_alias: z.enum(["extracted", "human", "transliteration_engine", "ocr_correction"]).default("extracted"),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type EntityAlias = z.infer<typeof EntityAliasSchema>;

export const CreateEntityAliasRequestSchema = z.object({
  value: z.string().min(1).max(255),
  alias_type: EntityAliasTypeSchema.default("trading_name"),
  valid_from: z.record(z.unknown()).nullable().optional(),
  valid_to: z.record(z.unknown()).nullable().optional(),
  confidence: z.number().min(0).max(1).default(0.85),
  source_of_alias: z.enum(["extracted", "human", "transliteration_engine", "ocr_correction"]).default("human"),
});
export type CreateEntityAliasRequest = z.infer<typeof CreateEntityAliasRequestSchema>;

// ── Entity Identifiers (PRD §14.2) ───────────────────────────────────────────

export const EntityIdentifierSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  entity_id: UuidSchema,
  scheme: z.string().min(1).max(100),
  value: z.string().min(1).max(255),
  jurisdiction: z.string().max(100).nullable().optional(),
  is_strong: z.boolean().default(false),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type EntityIdentifier = z.infer<typeof EntityIdentifierSchema>;

export const CreateEntityIdentifierRequestSchema = z.object({
  scheme: z.string().min(1).max(100),
  value: z.string().min(1).max(255),
  jurisdiction: z.string().max(100).nullable().optional(),
  is_strong: z.boolean().default(false),
});
export type CreateEntityIdentifierRequest = z.infer<typeof CreateEntityIdentifierRequestSchema>;

// ── Entity Mentions (PRD §14.1, §55 ENT-04) ──────────────────────────────────

export const EntityMentionSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  entity_id: UuidSchema,
  source_id: UuidSchema,
  chunk_id: UuidSchema.nullable().optional(),
  char_start: z.number().int().min(0),
  char_end: z.number().int().min(0),
  extracted_text: z.string(),
  surrounding_context: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).default(0.85),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type EntityMention = z.infer<typeof EntityMentionSchema>;

// ── Entity (PRD §14.1) ───────────────────────────────────────────────────────

export const EntitySchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  scope: z.enum(["investigation", "workspace"]).default("investigation"),
  type: EntityTypeSchema,
  subtype: z.string().max(100).nullable().optional(),
  canonical_name: z.string().min(1).max(255),
  sensitivity: EntitySensitivitySchema.default("standard"),
  subject_role: SubjectRoleSchema.nullable().optional(),
  is_focal: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.85),
  epistemic_state: EpistemicStateSchema.default("Supported"),
  status: EntityStatusSchema.default("active"),
  merged_into_id: UuidSchema.nullable().optional(),
  aliases: z.array(EntityAliasSchema).optional().default([]),
  identifiers: z.array(EntityIdentifierSchema).optional().default([]),
  mention_count: z.number().int().optional().default(0),
  source_count: z.number().int().optional().default(0),
  first_seen: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  last_seen: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
  deleted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

export const CreateEntityRequestSchema = z.object({
  type: EntityTypeSchema,
  subtype: z.string().max(100).nullable().optional(),
  canonical_name: z.string().min(1).max(255),
  sensitivity: EntitySensitivitySchema.default("standard"),
  subject_role: SubjectRoleSchema.nullable().optional(),
  is_focal: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.85),
  epistemic_state: EpistemicStateSchema.default("Supported"),
  aliases: z.array(CreateEntityAliasRequestSchema).optional().default([]),
  identifiers: z.array(CreateEntityIdentifierRequestSchema).optional().default([]),
  source_id: UuidSchema.optional(),
  chunk_id: UuidSchema.optional(),
  extracted_text: z.string().optional(),
  char_start: z.number().int().optional(),
  char_end: z.number().int().optional(),
});
export type CreateEntityRequest = z.infer<typeof CreateEntityRequestSchema>;

export const UpdateEntityRequestSchema = z.object({
  canonical_name: z.string().min(1).max(255).optional(),
  subtype: z.string().max(100).nullable().optional(),
  sensitivity: EntitySensitivitySchema.optional(),
  subject_role: SubjectRoleSchema.nullable().optional(),
  is_focal: z.boolean().optional(),
  status: EntityStatusSchema.optional(),
  rationale: z.string().optional(),
});
export type UpdateEntityRequest = z.infer<typeof UpdateEntityRequestSchema>;

// ── Entity Resolution & Merging (PRD §15 / AC-RES-01..05) ───────────────────

export const MergeBandSchema = z.enum(["deterministic", "high", "medium", "low", "no_match"]);
export type MergeBand = z.infer<typeof MergeBandSchema>;

export const MergeSignalBreakdownSchema = z.object({
  signal: z.string(),
  value: z.string(),
  weight: z.number(),
  contribution: z.number(),
  is_negative: z.boolean().default(false),
  description: z.string().optional(),
});
export type MergeSignalBreakdown = z.infer<typeof MergeSignalBreakdownSchema>;

export const MergeCandidateSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  entity_a: EntitySchema,
  entity_b: EntitySchema,
  match_band: MergeBandSchema,
  score: z.number().min(0).max(1),
  signals: z.array(MergeSignalBreakdownSchema),
  status: z.enum(["pending", "approved", "rejected", "auto_merged", "dismissed"]).default("pending"),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type MergeCandidate = z.infer<typeof MergeCandidateSchema>;

export const MergeEntitiesRequestSchema = z.object({
  source_entity_id: UuidSchema,
  target_entity_id: UuidSchema,
  rationale: z.string().min(1),
  force_override: z.boolean().default(false),
  override_rationale: z.string().optional(),
});
export type MergeEntitiesRequest = z.infer<typeof MergeEntitiesRequestSchema>;

export const UnmergeEntitiesRequestSchema = z.object({
  merge_history_id: UuidSchema,
  assertion_routing: z.enum(["target", "source", "both"]).default("target"),
  rationale: z.string().min(1),
});
export type UnmergeEntitiesRequest = z.infer<typeof UnmergeEntitiesRequestSchema>;

// ── Relationships (PRD §16 / REL-01..12) ────────────────────────────────────

export const RelationshipTypeSchema = z.string().min(1).max(100);

export const RelationshipSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  source_entity_id: UuidSchema,
  target_entity_id: UuidSchema,
  type: RelationshipTypeSchema,
  direction: z.enum(["directed", "bidirectional"]).default("directed"),
  valid_from: z.record(z.unknown()).nullable().optional(),
  valid_to: z.record(z.unknown()).nullable().optional(),
  current_status: z.enum(["active", "ended", "unknown"]).default("active"),
  attributes: z.record(z.unknown()).default({}),
  discovery_channel: z.enum(["stated", "structural", "inferred", "human"]).default("stated"),
  inference_pattern: z.string().max(255).nullable().optional(),
  evidence_ids: z.array(UuidSchema).default([]),
  epistemic_state: EpistemicStateSchema.default("Supported"),
  confidence: z.number().min(0).max(1).default(0.85),
  verified_by: UuidSchema.nullable().optional(),
  verified_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  review_rationale: z.string().nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
  deleted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const CreateRelationshipRequestSchema = z.object({
  source_entity_id: UuidSchema,
  target_entity_id: UuidSchema,
  type: RelationshipTypeSchema,
  direction: z.enum(["directed", "bidirectional"]).default("directed"),
  valid_from: z.record(z.unknown()).nullable().optional(),
  valid_to: z.record(z.unknown()).nullable().optional(),
  current_status: z.enum(["active", "ended", "unknown"]).default("active"),
  attributes: z.record(z.unknown()).default({}),
  discovery_channel: z.enum(["stated", "structural", "inferred", "human"]).default("stated"),
  inference_pattern: z.string().max(255).nullable().optional(),
  evidence_ids: z.array(UuidSchema).min(1, "At least one evidence locator is required"),
  epistemic_state: EpistemicStateSchema.default("Supported"),
  confidence: z.number().min(0).max(1).default(0.85),
});
export type CreateRelationshipRequest = z.infer<typeof CreateRelationshipRequestSchema>;

export const VerifyRelationshipRequestSchema = z.object({
  rationale: z.string().min(1),
});
export type VerifyRelationshipRequest = z.infer<typeof VerifyRelationshipRequestSchema>;

export const RefuteRelationshipRequestSchema = z.object({
  rationale: z.string().min(1),
});
export type RefuteRelationshipRequest = z.infer<typeof RefuteRelationshipRequestSchema>;

// ── Extraction Pipeline (PRD §5.2 Stage 5, Invariant I9) ────────────────────

export const ExtractionItemSchema = z.object({
  kind: z.enum(["entity", "relationship", "claim", "attribute"]),
  entity_type: EntityTypeSchema.optional(),
  canonical_name: z.string().optional(),
  source_entity_name: z.string().optional(),
  target_entity_name: z.string().optional(),
  predicate: z.string().optional(),
  value: z.unknown().optional(),
  quoted_span: z.string().min(1),
  char_start: z.number().int().min(0),
  char_end: z.number().int().min(0),
  confidence: z.number().min(0).max(1).default(0.85),
  identifiers: z.array(CreateEntityIdentifierRequestSchema).optional().default([]),
  aliases: z.array(CreateEntityAliasRequestSchema).optional().default([]),
});
export type ExtractionItem = z.infer<typeof ExtractionItemSchema>;

export const RunExtractionRequestSchema = z.object({
  source_id: UuidSchema,
  chunk_id: UuidSchema.optional(),
  items: z.array(ExtractionItemSchema),
});
export type RunExtractionRequest = z.infer<typeof RunExtractionRequestSchema>;
