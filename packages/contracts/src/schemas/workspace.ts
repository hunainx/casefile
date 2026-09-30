import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const WorkspaceSchema = z.object({
  id: UuidSchema.describe("Workspace ID"),
  tenant_id: UuidSchema.describe("Tenant ID"),
  name: z.string().min(1).max(255).describe("Workspace name"),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(255),
});

export const WorkspacePolicySchema = z.object({
  workspace_id: UuidSchema.describe("Workspace ID"),
  retention_policy: z.record(z.unknown()).describe("Retention policy config"),
  confidence_weights: z.record(z.number()).describe("Confidence scoring weights"),
  entity_sharing_enabled: z.boolean().describe("Whether cross-investigation entity sharing is enabled"),
  ethical_wall_mode: z.boolean().describe("Whether ethical wall mode is active"),
  separation_of_duties: z.boolean().describe("Whether separation of duties is required"),
  mfa_required: z.boolean().describe("Whether MFA is enforced for all workspace members"),
  model_policy: z.record(z.unknown()).optional().describe("AI provider pinning & model compliance policy"),
});

export const UpdateWorkspacePolicyRequestSchema = z.object({
  retention_policy: z.record(z.unknown()).optional(),
  confidence_weights: z.record(z.number()).optional(),
  entity_sharing_enabled: z.boolean().optional(),
  ethical_wall_mode: z.boolean().optional(),
  separation_of_duties: z.boolean().optional(),
  mfa_required: z.boolean().optional(),
  model_policy: z.record(z.unknown()).optional(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>;
export type UpdateWorkspacePolicyRequest = z.infer<typeof UpdateWorkspacePolicyRequestSchema>;
