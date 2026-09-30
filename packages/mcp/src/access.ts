import type { Tx } from "@casefile/db";
import { evaluatePermission, type EthicalWallRecord, type EvaluationResult, type Permission } from "@casefile/policy";

/**
 * Who may use the MCP tools on a matter, and which tools (docs/PLAN-MCP-AUTH.md section 3).
 * One copy for every way in: the OAuth sign-in page and token endpoint (D69, D76), the /mcp auth
 * gate in both of its modes (D73, D77), and the stdio CLI (D77). Moved here from apps/api in
 * Phase 3 so the stdio CLI, which cannot depend on apps/api, runs the same checks.
 */

/** Every one of the 9 MCP tools needs these; a role without all three gets no access at all. */
export const MCP_BASE_PERMISSIONS: readonly Permission[] = ["investigation.read", "source.read", "ai.query"];

export type RefusalReason = "no_totp" | "not_active" | "not_member" | "ethical_wall" | "role";

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  message: string;
}

export const REFUSAL_MESSAGES: Record<Exclude<RefusalReason, "role">, string> = {
  no_totp:
    "Two-step verification is not set up for this account, so it cannot connect to Claude. Ask your Casefile administrator for a one-time setup link.",
  not_active: "This account is not active.",
  not_member: "Your account is not a member of the workspace that holds this matter.",
  ethical_wall: "An ethical wall screens your account from this matter.",
};

/** MATTER_INVESTIGATION_ID does not name an investigation of MATTER_TENANT_ID: a deployment error. */
export class OAuthConfigError extends Error {}

/**
 * What evaluatePermission needs to decide a user's access to the matter's investigation: the
 * same inputs the eligibility check used, so each tool call (D74) is decided on exactly the
 * facts that were current when the request arrived.
 */
export interface McpAccess {
  effectiveRole: string;
  workspaceId: string;
  workspaceRole: string;
  investigationRole: string | null;
  ethicalWalls: EthicalWallRecord[];
}

/**
 * The signed-in (or locally configured) caller of an MCP request.
 * `authMode` says how the caller was established and is recorded on every audit row:
 * "oauth" (an access token, D73), "stdio" (the operator-only CLI, D77), or the local no-login
 * marker (D77; its only definition is apps/api/src/mcp/local-mode.ts). Session and client are
 * null outside OAuth.
 */
export interface McpCaller extends McpAccess {
  tenantId: string;
  investigationId: string;
  userId: string;
  sessionId: string | null;
  clientId: string | null;
  authMode: string;
}

/**
 * May this user use MCP on the matter?
 * - the account is active;
 * - it is a member of the workspace that owns the investigation;
 * - no ethical wall screens it from that investigation or workspace;
 * - its role on the investigation (D48: the investigation role replaces the workspace role)
 *   allows investigation.read, source.read and ai.query — so viewer, auditor and org_admin
 *   are refused (plan section 3).
 * Ethical walls are checked for user subjects; there is no group membership table yet, so
 * group walls cannot be resolved to users (DEV-024); new ones are refused and old ones flagged (D107).
 */
export async function checkMcpEligibility(
  tx: Tx,
  input: { tenantId: string; investigationId: string; userId: string },
): Promise<({ ok: true } & McpAccess) | Refusal> {
  const users = await tx<{ status: string }[]>`
    SELECT status FROM users WHERE id = ${input.userId} AND tenant_id = ${input.tenantId} AND deleted_at IS NULL;
  `;
  if (users[0]?.status !== "active") return { ok: false, reason: "not_active", message: REFUSAL_MESSAGES.not_active };

  const inv = await tx<{ workspace_id: string }[]>`
    SELECT workspace_id FROM investigations
    WHERE id = ${input.investigationId} AND tenant_id = ${input.tenantId} AND deleted_at IS NULL;
  `;
  if (!inv[0]) throw new OAuthConfigError("MATTER_INVESTIGATION_ID does not name an investigation in MATTER_TENANT_ID");
  const workspaceId = inv[0].workspace_id;

  const members = await tx<{ role: string }[]>`
    SELECT role FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND user_id = ${input.userId} AND tenant_id = ${input.tenantId};
  `;
  if (!members[0]) return { ok: false, reason: "not_member", message: REFUSAL_MESSAGES.not_member };

  const invMembers = await tx<{ role: string }[]>`
    SELECT role FROM investigation_members
    WHERE investigation_id = ${input.investigationId} AND user_id = ${input.userId} AND tenant_id = ${input.tenantId};
  `;
  const walls = await tx<{ workspace_id: string; investigation_id: string | null }[]>`
    SELECT workspace_id, investigation_id FROM ethical_walls
    WHERE tenant_id = ${input.tenantId} AND subject_type = 'user' AND subject_id = ${input.userId}
      AND (investigation_id = ${input.investigationId} OR (workspace_id = ${workspaceId} AND investigation_id IS NULL));
  `;

  const workspaceRole = members[0].role;
  const investigationRole = invMembers[0]?.role ?? null;
  const ethicalWalls = walls.map((w) => ({ userId: input.userId, workspaceId: w.workspace_id, investigationId: w.investigation_id }));
  for (const permission of MCP_BASE_PERMISSIONS) {
    const result = evaluatePermission({
      tenantId: input.tenantId,
      userId: input.userId,
      permission,
      workspaceId,
      workspaceRole,
      investigationId: input.investigationId,
      investigationRole,
      ethicalWalls,
    });
    if (result.reason === "ethical_wall") return { ok: false, reason: "ethical_wall", message: REFUSAL_MESSAGES.ethical_wall };
    if (!result.allowed) {
      const role = result.effectiveRole ?? investigationRole ?? workspaceRole;
      return {
        ok: false,
        reason: "role",
        message: `Your role on this matter (${role}) does not allow reading case documents through Claude.`,
      };
    }
  }
  return { ok: true, effectiveRole: investigationRole ?? workspaceRole, workspaceId, workspaceRole, investigationRole, ethicalWalls };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * For the modes that run as a configured user instead of a signed-in one (local no-login and
 * the stdio CLI, D77): why MCP_LOCAL_USER_ID cannot be used, or the user it names. The same
 * eligibility check as sign-in, with messages that name the setting.
 */
export async function checkLocalMcpUser(
  tx: Tx,
  input: { tenantId: string; investigationId: string; userId: string | undefined },
): Promise<{ ok: true; email: string; access: McpAccess } | { ok: false; problem: string }> {
  const id = input.userId?.trim();
  if (!id) return { ok: false, problem: "MCP_LOCAL_USER_ID is not set; it must name an active user of MATTER_TENANT_ID with an MCP-capable role" };
  if (!UUID.test(id)) return { ok: false, problem: `MCP_LOCAL_USER_ID (${id}) is not a user ID (a UUID)` };
  const users = await tx<{ email: string }[]>`
    SELECT email FROM users WHERE id = ${id} AND tenant_id = ${input.tenantId} AND deleted_at IS NULL;
  `;
  if (!users[0]) return { ok: false, problem: `MCP_LOCAL_USER_ID (${id}) is not a user of MATTER_TENANT_ID (${input.tenantId})` };
  const access = await checkMcpEligibility(tx, { tenantId: input.tenantId, investigationId: input.investigationId, userId: id });
  if (!access.ok) {
    const why = access.reason === "not_active" ? "is not active" : `is not eligible for MCP: ${access.message.replace(/\.$/, "")}`;
    return { ok: false, problem: `MCP_LOCAL_USER_ID (${id}, ${users[0].email}) ${why}` };
  }
  return { ok: true, email: users[0].email, access };
}

/**
 * What each MCP tool requires (plan section 3, D74). Claude is an external model reading case
 * material, so every tool needs ai.query as well as read access; the download link, which hands
 * out the original file, also needs export.create.
 *
 * Every permission must evaluate to "allow". "requires_approval" (export.create for
 * investigator and reviewer) and "own_only" are refusals here: MCP has no approval step and no
 * owned object to check.
 */
export const MCP_TOOL_PERMISSIONS = {
  matter_status: ["investigation.read", "ai.query"],
  list_investigations: ["investigation.read", "ai.query"],
  get_investigation: ["investigation.read", "ai.query"],
  list_documents: ["investigation.read", "source.read", "ai.query"],
  get_source: ["investigation.read", "source.read", "ai.query"],
  get_document_page: ["investigation.read", "source.read", "ai.query"],
  get_evidence: ["investigation.read", "source.read", "ai.query"],
  search: ["investigation.read", "source.read", "ai.query"],
  get_download_link: ["investigation.read", "source.read", "ai.query", "export.create"],
} as const satisfies Record<string, readonly Permission[]>;

export type McpToolName = keyof typeof MCP_TOOL_PERMISSIONS;

export function isMcpToolName(name: string): name is McpToolName {
  return Object.prototype.hasOwnProperty.call(MCP_TOOL_PERMISSIONS, name);
}

export type ToolDecision =
  | { allowed: true }
  | { allowed: false; permission: Permission; result: EvaluationResult };

/** Decides one tool for one caller: the first required permission that is not "allow" refuses it. */
export function decideTool(
  tool: McpToolName,
  caller: McpAccess & { tenantId: string; userId: string; investigationId: string },
  requestId?: string,
): ToolDecision {
  for (const permission of MCP_TOOL_PERMISSIONS[tool]) {
    const result = evaluatePermission({
      tenantId: caller.tenantId,
      userId: caller.userId,
      permission,
      workspaceId: caller.workspaceId,
      workspaceRole: caller.workspaceRole,
      investigationId: caller.investigationId,
      investigationRole: caller.investigationRole,
      ethicalWalls: caller.ethicalWalls,
      targetObjectType: "mcp_tool",
      ...(requestId ? { requestId } : {}),
    });
    if (result.outcome !== "allow") return { allowed: false, permission, result };
  }
  return { allowed: true };
}
