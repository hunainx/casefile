export type ActorType = "user" | "system" | "ai" | "anonymous";
export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEventInput {
  id?: string;
  tenantId: string;
  workspaceId?: string | null;
  investigationId?: string | null;
  timestamp?: Date | string;
  actorType: ActorType;
  actorId: string;
  actorDisplay: string;
  onBehalfOf?: string | null;
  sessionId?: string | null;
  ipHash?: string | null;
  action: string;
  objectType: string;
  objectId: string;
  objectDisplay: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  rationale?: string | null;
  aiInvolvement?: Record<string, unknown> | null;
  requestId: string;
  outcome: AuditOutcome;
  denialReason?: string | null;
}

export interface AuditEvent {
  id: string;
  tenant_id: string;
  seq: number | string;
  workspace_id: string | null;
  investigation_id: string | null;
  timestamp: string | Date;
  actor_type: ActorType;
  actor_id: string;
  actor_display: string;
  on_behalf_of: string | null;
  session_id: string | null;
  ip_hash: string | null;
  action: string;
  object_type: string;
  object_id: string;
  object_display: string;
  // A JSON object; for rows written before FIXES-1, the same JSON as text (DEV-031). The hash is
  // computed over the parsed value, so both verify (hasher.ts).
  before: Record<string, unknown> | string | null;
  after: Record<string, unknown> | string | null;
  rationale: string | null;
  ai_involvement: Record<string, unknown> | string | null;
  request_id: string;
  outcome: AuditOutcome;
  denial_reason: string | null;
  prev_hash: string | null;
  hash: string;
  created_at?: string | Date;
  updated_at?: string | Date;
  created_by?: string | null;
}

export interface AuditChainHead {
  tenant_id?: string;
  last_seq: number | string;
  last_hash: string;
  updated_at?: string | Date;
}

export type AuditBreakType =
  | "genesis_mismatch"
  | "broken_link"
  | "mutated_payload"
  | "reordered_event"
  | "truncated_tail";

export interface AuditBreak {
  type: AuditBreakType;
  index: number;
  eventId: string;
  detail: string;
  expected?: string;
  actual?: string;
}

export interface AuditVerificationResult {
  valid: boolean;
  verifiedCount: number;
  break?: AuditBreak;
}
