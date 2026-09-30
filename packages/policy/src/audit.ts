import type { AuditEventInput } from "@casefile/audit";
import type { AuthContext, EvaluationResult } from "./types.js";

/**
 * createPolicyDenialAuditEvent() — constructs the audit event for access denials per REQ-M-AUDIT-006.
 */
export function createPolicyDenialAuditEvent(
  ctx: AuthContext,
  result: EvaluationResult,
): AuditEventInput {
  return {
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId || null,
    investigationId: ctx.investigationId || null,
    actorType: "user",
    actorId: ctx.userId,
    actorDisplay: ctx.userId,
    action: `auth.deny:${String(ctx.permission)}`,
    objectType: ctx.targetObjectType || "permission",
    objectId: ctx.targetObjectId || "00000000-0000-0000-0000-000000000000",
    objectDisplay: ctx.targetObjectId || String(ctx.permission),
    requestId: ctx.requestId || "req_unspecified",
    outcome: "denied",
    denialReason: result.reason || "permission_denied",
  };
}
