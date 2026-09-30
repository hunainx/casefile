export type OrgRole =
  | "org_owner"
  | "org_admin"
  | "billing_admin"
  | "security_admin"
  | "member";

export type WorkspaceRole =
  | "ws_admin"
  | "lead_inv"
  | "investigator"
  | "analyst"
  | "reviewer"
  | "contributor"
  | "viewer"
  | "auditor";

export type InvestigationRole =
  | "owner"
  | "lead"
  | "investigator"
  | "reviewer"
  | "contributor"
  | "viewer";

export type MatrixRole = "org_admin" | WorkspaceRole;

export type Permission =
  | "org.manage"
  | "org.billing"
  | "workspace.create"
  | "workspace.manage"
  | "workspace.members"
  | "workspace.policy"
  | "connector.configure"
  | "connector.use"
  | "investigation.create"
  | "investigation.read"
  | "investigation.define"
  | "investigation.scope"
  | "investigation.members"
  | "investigation.archive"
  | "source.admit"
  | "source.withdraw"
  | "source.read"
  | "source.purge"
  | "entity.create"
  | "entity.edit"
  | "entity.merge"
  | "entity.unmerge"
  | "assertion.create"
  | "assertion.validate"
  | "evidence.create"
  | "evidence.withdraw"
  | "finding.create"
  | "finding.validate"
  | "finding.approve"
  | "finding.retract"
  | "hypothesis.manage"
  | "contradiction.adjudicate"
  | "ai.query"
  | "ai.promote"
  | "ai.agent_run"
  | "report.create"
  | "report.approve"
  | "report.publish"
  | "export.create"
  | "audit.read"
  | "audit.export";

export type PolicyOutcome = "allow" | "own_only" | "requires_approval" | "deny";

export interface EthicalWallRecord {
  userId: string;
  workspaceId?: string | null;
  investigationId?: string | null;
}

export interface AuthContext {
  tenantId: string;
  userId: string;
  permission: Permission | string;
  orgRole?: string | null;
  workspaceId?: string | null;
  workspaceRole?: WorkspaceRole | string | null;
  investigationId?: string | null;
  investigationRole?: InvestigationRole | string | null;
  targetObjectId?: string | null;
  targetObjectType?: string | null;
  targetObjectOwnerId?: string | null;
  ethicalWalls?: EthicalWallRecord[];
  requestId?: string;
}

export interface EvaluationResult {
  allowed: boolean;
  outcome: PolicyOutcome;
  reason?: string;
  effectiveRole?: MatrixRole | null;
}
