import type { Tx } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import type { AuthContext, EvaluationResult } from "./types.js";
import { evaluatePermission } from "./evaluator.js";
import { createPolicyDenialAuditEvent } from "./audit.js";
import { PermissionDeniedError } from "./errors.js";

/**
 * evaluateAndAudit() — Evaluates authorization and writes an audit event on denial
 * within the caller's transaction (PRD §38.3, REQ-M-AUDIT-006).
 */
export async function evaluateAndAudit(
  tx: Tx,
  ctx: AuthContext,
): Promise<EvaluationResult> {
  const result = evaluatePermission(ctx);

  if (!result.allowed) {
    const denialEvent = createPolicyDenialAuditEvent(ctx, result);
    await writeAuditEvent(tx, denialEvent);
  }

  return result;
}

/**
 * enforcePermission() — Evaluates authorization, audits denials, and throws
 * a uniform PermissionDeniedError if denied without leaking target object existence.
 */
export async function enforcePermission(
  tx: Tx,
  ctx: AuthContext,
): Promise<EvaluationResult> {
  const result = await evaluateAndAudit(tx, ctx);

  if (!result.allowed) {
    throw new PermissionDeniedError(result.reason);
  }

  return result;
}
