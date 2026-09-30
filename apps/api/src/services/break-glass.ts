import { randomUUID } from "node:crypto";
import type { Tx } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import { AuthError } from "../auth/service.js";

export interface BreakGlassGrant {
  id: string;
  tenant_id: string;
  staff_user_id: string;
  reason: string;
  requested_by: string;
  approved_by: string | null;
  status: "pending" | "approved" | "rejected" | "revoked" | "expired";
  duration_minutes: number;
  requested_at: Date;
  approved_at: Date | null;
  expires_at: Date | null;
  customer_notified: boolean;
  session_recording_id: string | null;
  created_at: Date;
}

export class BreakGlassService {
  /**
   * Submits a break-glass access request for a specific customer tenant.
   */
  static async requestBreakGlass(
    tx: Tx,
    input: {
      tenantId: string;
      staffUserId: string;
      reason: string;
      requestedBy: string;
      durationMinutes?: number | undefined;
      requestId?: string | undefined;
    },
  ): Promise<BreakGlassGrant> {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new AuthError("Break-glass request must provide a documented reason", "INVALID_BREAK_GLASS_REQUEST", 400);
    }

    const duration = Math.min(Math.max(input.durationMinutes || 60, 5), 480);
    const grantId = randomUUID();

    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;

    const rows = await tx<BreakGlassGrant[]>`
      INSERT INTO break_glass_grants (
        id, tenant_id, staff_user_id, reason, requested_by, duration_minutes, status
      ) VALUES (
        ${grantId}, ${input.tenantId}, ${input.staffUserId}, ${input.reason},
        ${input.requestedBy}, ${duration}, 'pending'
      )
      RETURNING *;
    `;

    return rows[0]!;
  }

  /**
   * Dual-approval of a break-glass access request (PRD §40.7, AC-SEC-05, SEC-06).
   * Enforces dual-custody: approver CANNOT be the same user who requested access.
   */
  static async approveBreakGlass(
    tx: Tx,
    input: {
      grantId: string;
      approvedBy: string;
      tenantId: string;
      requestId?: string;
    },
  ): Promise<BreakGlassGrant> {
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;

    const rows = await tx<BreakGlassGrant[]>`
      SELECT * FROM break_glass_grants
      WHERE id = ${input.grantId} AND tenant_id = ${input.tenantId};
    `;

    if (rows.length === 0) {
      throw new AuthError("Break-glass grant not found", "GRANT_NOT_FOUND", 404);
    }

    const grant = rows[0]!;
    if (grant.status !== "pending") {
      throw new AuthError(`Cannot approve grant in '${grant.status}' state`, "INVALID_GRANT_STATE", 400);
    }

    // Dual approval enforcement
    if (grant.requested_by === input.approvedBy) {
      throw new AuthError(
        "Dual approval required: requestor cannot approve own break-glass request",
        "DUAL_APPROVAL_REQUIRED",
        400,
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + grant.duration_minutes * 60 * 1000);
    const sessionRecordingId = `rec_${randomUUID().replace(/-/g, "")}`;

    const updatedRows = await tx<BreakGlassGrant[]>`
      UPDATE break_glass_grants
      SET status = 'approved',
          approved_by = ${input.approvedBy},
          approved_at = ${now},
          expires_at = ${expiresAt},
          customer_notified = true,
          session_recording_id = ${sessionRecordingId}
      WHERE id = ${input.grantId} AND tenant_id = ${input.tenantId}
      RETURNING *;
    `;

    // Customer-visible audit event recorded into the customer's own tenant audit chain
    await writeAuditEvent(tx, {
      tenantId: grant.tenant_id,
      actorType: "user",
      actorId: grant.staff_user_id,
      actorDisplay: `Casefile Staff (${grant.staff_user_id})`,
      action: "break_glass_access_granted",
      objectType: "break_glass_grant",
      objectId: grant.id,
      objectDisplay: `Break-Glass Grant ${grant.id}`,
      outcome: "success",
      requestId: input.requestId || `req_${randomUUID().replace(/-/g, "")}`,
      rationale: grant.reason,
      after: {
        reason: grant.reason,
        requested_by: grant.requested_by,
        approved_by: input.approvedBy,
        duration_minutes: grant.duration_minutes,
        expires_at: expiresAt.toISOString(),
        customer_notified: true,
        session_recording_id: sessionRecordingId,
      },
    });

    return updatedRows[0]!;
  }

  /**
   * Validates and records an active break-glass data access session in customer audit log (SEC-07).
   */
  static async validateAndRecordAccess(
    tx: Tx,
    input: {
      grantId: string;
      staffUserId: string;
      tenantId: string;
      targetResource?: string;
      targetResourceId?: string;
      requestId?: string;
    },
  ): Promise<{ valid: boolean; grant: BreakGlassGrant }> {
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;

    const rows = await tx<BreakGlassGrant[]>`
      SELECT * FROM break_glass_grants
      WHERE id = ${input.grantId} AND tenant_id = ${input.tenantId};
    `;

    if (rows.length === 0) {
      throw new AuthError("Break-glass grant not found", "GRANT_NOT_FOUND", 404);
    }

    const grant = rows[0]!;
    if (grant.status !== "approved") {
      throw new AuthError(`Break-glass grant is not active (status: ${grant.status})`, "GRANT_NOT_ACTIVE", 403);
    }

    if (!grant.expires_at || new Date(grant.expires_at).getTime() <= Date.now()) {
      await tx`
        UPDATE break_glass_grants
        SET status = 'expired'
        WHERE id = ${grant.id} AND tenant_id = ${input.tenantId};
      `;
      throw new AuthError("Break-glass grant has expired", "GRANT_EXPIRED", 403);
    }

    // Record staff access in customer's audit log (SEC-07)
    const targetId = input.targetResourceId || grant.id;
    await writeAuditEvent(tx, {
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.staffUserId,
      actorDisplay: `Casefile Staff (${input.staffUserId})`,
      action: "staff_data_access",
      objectType: "customer_data",
      objectId: targetId,
      objectDisplay: input.targetResource || "Customer Data",
      outcome: "success",
      requestId: input.requestId || `req_${randomUUID().replace(/-/g, "")}`,
      rationale: grant.reason,
      after: {
        grant_id: grant.id,
        session_recording_id: grant.session_recording_id,
      },
    });

    return { valid: true, grant };
  }

  /**
   * Revokes an active break-glass grant immediately.
   */
  static async revokeBreakGlass(
    tx: Tx,
    input: {
      grantId: string;
      revokedBy: string;
      tenantId: string;
      requestId?: string;
    },
  ): Promise<BreakGlassGrant> {
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;

    const rows = await tx<BreakGlassGrant[]>`
      UPDATE break_glass_grants
      SET status = 'revoked'
      WHERE id = ${input.grantId} AND tenant_id = ${input.tenantId}
      RETURNING *;
    `;

    if (rows.length === 0) {
      throw new AuthError("Break-glass grant not found", "GRANT_NOT_FOUND", 404);
    }

    const grant = rows[0]!;

    await writeAuditEvent(tx, {
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.revokedBy,
      actorDisplay: `Admin (${input.revokedBy})`,
      action: "break_glass_access_revoked",
      objectType: "break_glass_grant",
      objectId: grant.id,
      objectDisplay: `Break-Glass Grant ${grant.id}`,
      outcome: "success",
      requestId: input.requestId || `req_${randomUUID().replace(/-/g, "")}`,
      after: {
        grant_id: grant.id,
        status: "revoked",
      },
    });

    return grant;
  }
}
