import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const OrganizationSchema = z.object({
  id: UuidSchema.describe("Organization ID (also tenant_id)"),
  tenant_id: UuidSchema.describe("Tenant ID (matches id for root organization)"),
  name: z.string().min(1).max(255).describe("Organization display name"),
  created_at: z.union([IsoDateTimeSchema, z.date()]),
  updated_at: z.union([IsoDateTimeSchema, z.date()]),
  created_by: UuidSchema.nullable().optional(),
});

export const CreateOrganizationRequestSchema = z.object({
  name: z.string().min(1).max(255),
});

export type Organization = z.infer<typeof OrganizationSchema>;
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;
