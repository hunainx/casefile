import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const SubjectTypeSchema = z.enum(["user", "role", "group"]);

export const EthicalWallSchema = z.object({
  id: UuidSchema.describe("Ethical Wall ID"),
  tenant_id: UuidSchema.describe("Tenant ID"),
  workspace_id: UuidSchema.describe("Workspace ID"),
  subject_type: SubjectTypeSchema.describe("Subject type (user, role, group)"),
  subject_id: UuidSchema.describe("Subject entity ID"),
  investigation_id: UuidSchema.nullable().optional().describe("Blocked investigation ID (if scoped to investigation)"),
  reason: z.string().min(1).describe("Ethical wall rationale / conflict description"),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});

export const CreateEthicalWallRequestSchema = z.object({
  subject_type: SubjectTypeSchema,
  subject_id: UuidSchema,
  investigation_id: UuidSchema.nullable().optional(),
  reason: z.string().min(1),
});

export type SubjectType = z.infer<typeof SubjectTypeSchema>;
export type EthicalWall = z.infer<typeof EthicalWallSchema>;
export type CreateEthicalWallRequest = z.infer<typeof CreateEthicalWallRequestSchema>;
