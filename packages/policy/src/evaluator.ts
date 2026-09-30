import type {
  AuthContext,
  EvaluationResult,
  MatrixRole,
  Permission,
} from "./types.js";
import { PERMISSIONS_MATRIX, MATRIX_ROLES } from "./matrix.js";

/**
 * Maps an investigation role to the corresponding matrix role per Decision D48.
 */
export function mapInvestigationRoleToMatrix(role: string): MatrixRole | null {
  switch (role) {
    // 'lead_investigator' and 'auditor' are the values investigation_members actually stores
    // (its CHECK constraint); the bootstrap and investigation creation grant lead_investigator (D72).
    case "owner":
    case "lead":
    case "lead_investigator":
      return "lead_inv";
    case "investigator":
      return "investigator";
    case "reviewer":
      return "reviewer";
    case "contributor":
      return "contributor";
    case "viewer":
      return "viewer";
    case "auditor":
      return "auditor";
    default:
      return null;
  }
}

/**
 * Evaluates authorization for a request against PRD §38, §40, and Decision D48.
 *
 * Centralized authorization engine: Deny-by-default.
 * Resolution order:
 * 1. Ethical walls (unconditional deny)
 * 2. Investigation role (replaces workspace role inside investigation scope per D48)
 * 3. Workspace role
 * 4. Organization role (org_admin)
 */
export function evaluatePermission(ctx: AuthContext): EvaluationResult {
  // 1. Check Ethical Walls (unconditional hard deny per §38.4, REQ-M-RBAC-006)
  if (ctx.ethicalWalls && ctx.ethicalWalls.length > 0) {
    const isWalled = ctx.ethicalWalls.some((wall) => {
      if (wall.userId !== ctx.userId) return false;
      if (ctx.investigationId && wall.investigationId === ctx.investigationId) return true;
      if (ctx.workspaceId && wall.workspaceId === ctx.workspaceId && !wall.investigationId) return true;
      return false;
    });

    if (isWalled) {
      return {
        allowed: false,
        outcome: "deny",
        reason: "ethical_wall",
        effectiveRole: null,
      };
    }
  }

  // 2. Resolve Effective Role
  let effectiveRole: MatrixRole | null = null;

  if (ctx.investigationId && ctx.investigationRole) {
    // Investigation role REPLACES workspace role per D48
    effectiveRole = mapInvestigationRoleToMatrix(ctx.investigationRole);
    if (!effectiveRole) {
      return {
        allowed: false,
        outcome: "deny",
        reason: "unknown_investigation_role",
        effectiveRole: null,
      };
    }

    // D48: exclusive rights on investigation.archive for owner
    if (ctx.permission === "investigation.archive" && ctx.investigationRole !== "owner") {
      return {
        allowed: false,
        outcome: "deny",
        reason: "owner_exclusive_action",
        effectiveRole,
      };
    }
  } else if (ctx.workspaceRole) {
    if (MATRIX_ROLES.includes(ctx.workspaceRole as MatrixRole)) {
      effectiveRole = ctx.workspaceRole as MatrixRole;
    } else {
      return {
        allowed: false,
        outcome: "deny",
        reason: "unknown_workspace_role",
        effectiveRole: null,
      };
    }
  } else if (ctx.orgRole === "org_admin" || ctx.orgRole === "org_owner") {
    effectiveRole = "org_admin";
  }

  // Deny if no role could be established (missing membership)
  if (!effectiveRole) {
    return {
      allowed: false,
      outcome: "deny",
      reason: "missing_membership_or_role",
      effectiveRole: null,
    };
  }

  // 3. Matrix Permission Lookup
  const perm = ctx.permission as Permission;
  const permRow = PERMISSIONS_MATRIX[perm];

  if (!permRow) {
    // Unknown permission -> fail closed
    return {
      allowed: false,
      outcome: "deny",
      reason: "unknown_permission",
      effectiveRole,
    };
  }

  const rawOutcome = permRow[effectiveRole];

  if (!rawOutcome || rawOutcome === "deny") {
    return {
      allowed: false,
      outcome: "deny",
      reason: "role_permission_denied",
      effectiveRole,
    };
  }

  if (rawOutcome === "requires_approval") {
    return {
      allowed: false,
      outcome: "requires_approval",
      reason: "approval_required",
      effectiveRole,
    };
  }

  if (rawOutcome === "own_only") {
    // 🔸 outcome: allows only if caller owns target object
    if (ctx.targetObjectOwnerId && ctx.targetObjectOwnerId === ctx.userId) {
      return {
        allowed: true,
        outcome: "own_only",
        effectiveRole,
      };
    }
    return {
      allowed: false,
      outcome: "deny",
      reason: "own_objects_only",
      effectiveRole,
    };
  }

  if (rawOutcome === "allow") {
    return {
      allowed: true,
      outcome: "allow",
      effectiveRole,
    };
  }

  return {
    allowed: false,
    outcome: "deny",
    reason: "unknown_outcome",
    effectiveRole,
  };
}
