import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const InvestigationStageSchema = z.enum([
  "draft",
  "defining",
  "collecting",
  "processing",
  "exploring",
  "connecting",
  "analyzing",
  "challenging",
  "validating",
  "concluding",
  "reporting",
  "reviewing",
  "archived",
  "suspended",
]);
export type InvestigationStage = z.infer<typeof InvestigationStageSchema>;

export const InvestigationSensitivitySchema = z.enum([
  "internal",
  "confidential",
  "restricted",
]);
export type InvestigationSensitivity = z.infer<typeof InvestigationSensitivitySchema>;

export const InvestigationMemberRoleSchema = z.enum([
  "lead_investigator",
  "investigator",
  "reviewer",
  "auditor",
  "viewer",
]);
export type InvestigationMemberRole = z.infer<typeof InvestigationMemberRoleSchema>;

export const ScopeSubjectTypeSchema = z.enum([
  "organization",
  "public_figure",
  "private_individual",
  "asset",
  "event",
  "unknown",
]);
export type ScopeSubjectType = z.infer<typeof ScopeSubjectTypeSchema>;

export const SubjectRoleSchema = z.enum([
  "primary_subject",
  "related_party",
  "key_associate",
  "counterparty",
  "witness",
  "victim",
  "custodian",
  "third_party",
  "other",
]);
export type SubjectRole = z.infer<typeof SubjectRoleSchema>;

export const SubjectDeclarationSchema = z.object({
  entity_ref: UuidSchema.nullable().optional(),
  descriptor: z.string().min(1),
  subject_type: ScopeSubjectTypeSchema,
  role: SubjectRoleSchema,
  legitimacy_basis: z.string().optional(),
});
export type SubjectDeclaration = z.infer<typeof SubjectDeclarationSchema>;

export const TemporalBoundsSchema = z.object({
  from: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  to: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});

export const InvestigationScopeSchema = z.object({
  subjects: z.array(SubjectDeclarationSchema).default([]),
  temporal_bounds: TemporalBoundsSchema.default({}),
  jurisdictions: z.array(z.string()).default([]),
  inclusions: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
  data_categories_permitted: z.array(z.string()).default([]),
});
export type InvestigationScope = z.infer<typeof InvestigationScopeSchema>;

export const InvestigationSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  workspace_id: UuidSchema,
  name: z.string(),
  stage: InvestigationStageSchema,
  sensitivity: InvestigationSensitivitySchema,
  retention_class: z.string(),
  legal_hold: z.boolean(),
  objective: z.string().nullable().optional(),
  legitimacy_declaration: z.record(z.unknown()).nullable().optional(),
  scope: InvestigationScopeSchema,
  suspension_reason: z.string().nullable().optional(),
  reopen_justification: z.string().nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
  deleted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});
export type Investigation = z.infer<typeof InvestigationSchema>;

export const CreateInvestigationRequestSchema = z.object({
  workspace_id: UuidSchema,
  name: z.string().min(1).max(255),
  template_id: UuidSchema.optional(),
  sensitivity: InvestigationSensitivitySchema.default("internal"),
  retention_class: z.string().default("standard"),
  objective: z.string().optional(),
  scope: InvestigationScopeSchema.optional(),
});
export type CreateInvestigationRequest = z.infer<typeof CreateInvestigationRequestSchema>;

export const UpdateInvestigationRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  sensitivity: InvestigationSensitivitySchema.optional(),
  objective: z.string().optional(),
  legal_hold: z.boolean().optional(),
  scope: InvestigationScopeSchema.optional(),
  legitimacy_declaration: z.record(z.unknown()).optional(),
});
export type UpdateInvestigationRequest = z.infer<typeof UpdateInvestigationRequestSchema>;

export const TransitionStageRequestSchema = z.object({
  stage: InvestigationStageSchema,
  suspension_reason: z.string().optional(),
  reopen_justification: z.string().optional(),
});
export type TransitionStageRequest = z.infer<typeof TransitionStageRequestSchema>;

export const QuestionMaterialitySchema = z.enum(["critical", "important", "supporting"]);
export type QuestionMateriality = z.infer<typeof QuestionMaterialitySchema>;

export const QuestionStatusSchema = z.enum([
  "open",
  "partially_answered",
  "answered",
  "unanswerable",
]);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const InvestigationQuestionSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  sequence: z.number().int(),
  text: z.string(),
  parent_question_id: UuidSchema.nullable().optional(),
  materiality: QuestionMaterialitySchema,
  status: QuestionStatusSchema,
  unanswerable_rationale: z.string().nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
  deleted_at: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
});
export type InvestigationQuestion = z.infer<typeof InvestigationQuestionSchema>;

export const CreateQuestionRequestSchema = z.object({
  text: z.string().min(1),
  sequence: z.number().int().optional(),
  parent_question_id: UuidSchema.nullable().optional(),
  materiality: QuestionMaterialitySchema.default("important"),
});
export type CreateQuestionRequest = z.infer<typeof CreateQuestionRequestSchema>;

export const UpdateQuestionRequestSchema = z.object({
  text: z.string().min(1).optional(),
  sequence: z.number().int().optional(),
  materiality: QuestionMaterialitySchema.optional(),
  status: QuestionStatusSchema.optional(),
  unanswerable_rationale: z.string().optional(),
});
export type UpdateQuestionRequest = z.infer<typeof UpdateQuestionRequestSchema>;

export const InvestigationMemberSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  user_id: UuidSchema,
  role: InvestigationMemberRoleSchema,
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type InvestigationMember = z.infer<typeof InvestigationMemberSchema>;

export const AddInvestigationMemberRequestSchema = z.object({
  user_id: UuidSchema,
  role: InvestigationMemberRoleSchema,
});
export type AddInvestigationMemberRequest = z.infer<typeof AddInvestigationMemberRequestSchema>;

export const InvestigationHealthSchema = z.object({
  status: z.enum(["healthy", "attention", "at_risk", "blocked"]),
  score: z.number().min(0).max(100),
  components: z.object({
    question_coverage: z.number(),
    evidence_integrity: z.number(),
    contradiction_posture: z.number(),
    gap_posture: z.number(),
    verification_depth: z.number(),
  }),
  issues: z.array(z.string()),
});
export type InvestigationHealth = z.infer<typeof InvestigationHealthSchema>;

export const InvestigationTemplateSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  workspace_id: UuidSchema.nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  questions: z.array(z.any()).default([]),
  scope_defaults: z.record(z.unknown()).default({}),
  expected_source_types: z.array(z.string()).default([]),
  collection_checklist: z.array(z.string()).default([]),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type InvestigationTemplate = z.infer<typeof InvestigationTemplateSchema>;

export const CreateTemplateRequestSchema = z.object({
  workspace_id: UuidSchema.optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  questions: z.array(z.any()).default([]),
  scope_defaults: z.record(z.unknown()).default({}),
  expected_source_types: z.array(z.string()).default([]),
  collection_checklist: z.array(z.string()).default([]),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;

export const NoteTargetTypeSchema = z.enum([
  "investigation",
  "entity",
  "evidence",
  "relationship",
  "hypothesis",
  "finding",
  "event",
]);
export type NoteTargetType = z.infer<typeof NoteTargetTypeSchema>;

export const NoteSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  target_type: NoteTargetTypeSchema,
  target_id: UuidSchema,
  content: z.string(),
  mentions: z.array(z.string()).default([]),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type Note = z.infer<typeof NoteSchema>;

export const CreateNoteRequestSchema = z.object({
  target_type: NoteTargetTypeSchema,
  target_id: UuidSchema,
  content: z.string().min(1),
  mentions: z.array(z.string()).optional(),
});
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;

export const TaskStatusSchema = z.enum(["todo", "in_progress", "completed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  title: z.string(),
  description: z.string().nullable().optional(),
  assignee_id: UuidSchema.nullable().optional(),
  due_date: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  target_type: z.string().nullable().optional(),
  target_id: UuidSchema.nullable().optional(),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskRequestSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  assignee_id: UuidSchema.optional(),
  due_date: z.union([IsoDateTimeSchema, z.date()]).optional(),
  priority: TaskPrioritySchema.default("medium"),
  target_type: z.string().optional(),
  target_id: UuidSchema.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  assignee_id: UuidSchema.nullable().optional(),
  due_date: z.union([IsoDateTimeSchema, z.date()]).nullable().optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const InvestigationBriefSchema = z.object({
  investigation_id: UuidSchema,
  name: z.string(),
  stage: InvestigationStageSchema,
  objective: z.string().nullable().optional(),
  summary: z.string(),
  stats: z.object({
    total_questions: z.number(),
    answered_questions: z.number(),
    critical_questions_open: z.number(),
    member_count: z.number(),
    source_count: z.number(),
    finding_count: z.number(),
  }),
  health: InvestigationHealthSchema,
  generated_at: z.union([IsoDateTimeSchema, z.date()]),
});
export type InvestigationBrief = z.infer<typeof InvestigationBriefSchema>;
