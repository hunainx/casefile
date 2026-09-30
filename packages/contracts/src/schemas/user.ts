import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const UserSchema = z.object({
  id: UuidSchema.describe("User ID"),
  tenant_id: UuidSchema.describe("Tenant ID"),
  email: z.string().email().max(255).describe("User email address"),
  name: z.string().min(1).max(255).describe("User display name"),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});

export const CreateUserRequestSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(255),
});

export type User = z.infer<typeof UserSchema>;
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
