import { z } from "zod";
import { UuidSchema, UlidSchema, IsoDateTimeSchema } from "./common.js";

export const ActorTypeSchema = z.enum(["user", "system", "ai", "anonymous"]);
export const AuditOutcomeSchema = z.enum(["success", "denied", "failure"]);

export const AuditEventSchema = z.object({
  id: UlidSchema.describe("Audit Event ID (ULID)"),
  tenant_id: UuidSchema.describe("Tenant ID"),
  seq: z.number().int().positive().describe("Contiguous per-tenant sequence number (D52)"),
  workspace_id: UuidSchema.nullable().optional(),
  investigation_id: UuidSchema.nullable().optional(),
  timestamp: z.union([IsoDateTimeSchema, z.date()]),
  actor_type: ActorTypeSchema,
  actor_id: UuidSchema,
  actor_display: z.string(),
  on_behalf_of: UuidSchema.nullable().optional(),
  session_id: UuidSchema.nullable().optional(),
  ip_hash: z.string().nullable().optional(),
  action: z.string(),
  object_type: z.string(),
  object_id: z.string(),
  object_display: z.string(),
  before: z.record(z.unknown()).nullable().optional(),
  after: z.record(z.unknown()).nullable().optional(),
  rationale: z.string().nullable().optional(),
  ai_involvement: z.record(z.unknown()).nullable().optional(),
  request_id: z.string(),
  outcome: AuditOutcomeSchema,
  denial_reason: z.string().nullable().optional(),
  prev_hash: z.string().length(64).describe("Predecessor SHA-256 hash"),
  hash: z.string().length(64).describe("Event SHA-256 hash"),
  created_at: z.union([IsoDateTimeSchema, z.date()]).optional(),
  updated_at: z.union([IsoDateTimeSchema, z.date()]).optional(),
  created_by: UuidSchema.nullable().optional(),
});

export type ActorType = z.infer<typeof ActorTypeSchema>;
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditExportRequestSchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type AuditExportRequest = z.infer<typeof AuditExportRequestSchema>;

export const AuditExportResponseSchema = z.object({
  export_id: UuidSchema,
  format: z.enum(["json", "csv"]),
  record_count: z.number().int().nonnegative(),
  download_url: z.string().url().optional(),
  data: z.union([z.array(z.record(z.unknown())), z.string()]).optional(),
});
export type AuditExportResponse = z.infer<typeof AuditExportResponseSchema>;

