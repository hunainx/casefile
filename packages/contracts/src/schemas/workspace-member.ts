import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const WorkspaceRoleSchema = z.enum([
  "ws_admin",
  "lead_inv",
  "investigator",
  "analyst",
  "reviewer",
  "contributor",
  "viewer",
  "auditor",
]);

export const WorkspaceMemberSchema = z.object({
  id: UuidSchema.describe("Workspace Member ID"),
  tenant_id: UuidSchema.describe("Tenant ID"),
  workspace_id: UuidSchema.describe("Workspace ID"),
  user_id: UuidSchema.describe("User ID"),
  role: WorkspaceRoleSchema.describe("Role in the workspace per §38.2"),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});

export const AddWorkspaceMemberRequestSchema = z.object({
  user_id: UuidSchema,
  role: WorkspaceRoleSchema,
});

export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
export type AddWorkspaceMemberRequest = z.infer<typeof AddWorkspaceMemberRequestSchema>;
