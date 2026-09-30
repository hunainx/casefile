import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluatePermission,
  createPolicyDenialAuditEvent,
  type AuthContext,
  type Permission,
  type WorkspaceRole,
} from "../src/index.js";
import { MATRIX_FIXTURE } from "./matrix.fixture.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** A deliberately invalid value, widened to string so it can be narrowed to the type under test. */
const invalidValue = (v: string): string => v;

function grepRepo(pattern: string, fixed = true): string[] {
  const args = ["grep", "-n", "--untracked", fixed ? "--fixed-strings" : "-E", "--", pattern];
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n").filter(Boolean);
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
}

function hits(pattern: string, allowlist: readonly string[]): string[] {
  return grepRepo(pattern, true).filter((line) => {
    const file = line.split(":")[0] ?? "";
    const rel = relative(ROOT, resolve(ROOT, file)).split("\\").join("/");
    if (allowlist.some((a) => rel === a || rel.startsWith(a))) return false;
    return !(rel.startsWith("docs/") || rel === ".env.example" ||
             rel === "traceability/requirements.yaml" || rel === "traceability/manual.yaml");
  });
}

describe("packages/policy — Permission Matrix Fixture Suite (§38.3)", () => {
  it.each(MATRIX_FIXTURE)(
    "evaluates permission $permission for role $role => $expectedOutcome",
    ({ permission, role, expectedOutcome }) => {
      const isOrgAdmin = role === "org_admin";
      const ctx: AuthContext = {
        tenantId: "11111111-1111-1111-1111-111111111111",
        userId: "user_test",
        permission,
        orgRole: isOrgAdmin ? "org_admin" : null,
        workspaceRole: isOrgAdmin ? null : role,
        // For own_only test in the matrix fixture, test owner scenario
        targetObjectOwnerId: "user_test",
      };

      const result = evaluatePermission(ctx);
      expect(result.outcome).toBe(expectedOutcome);

      if (expectedOutcome === "allow" || expectedOutcome === "own_only") {
        expect(result.allowed).toBe(true);
      } else {
        expect(result.allowed).toBe(false);
      }
    },
  );
});

describe("packages/policy — Deny-by-default & Edge Cases", () => {
  it("denies unknown permissions unconditionally", () => {
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_test",
      permission: invalidValue("system.superpower") as Permission,
      workspaceRole: "ws_admin",
    };

    const res = evaluatePermission(ctx);
    expect(res.allowed).toBe(false);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toBe("unknown_permission");
  });

  it("denies unknown workspace roles unconditionally", () => {
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_test",
      permission: "workspace.manage",
      workspaceRole: invalidValue("super_admin") as WorkspaceRole,
    };

    const res = evaluatePermission(ctx);
    expect(res.allowed).toBe(false);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toBe("unknown_workspace_role");
  });

  it("denies when no membership or role is provided", () => {
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_test",
      permission: "workspace.manage",
    };

    const res = evaluatePermission(ctx);
    expect(res.allowed).toBe(false);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toBe("missing_membership_or_role");
  });
});

describe("packages/policy — 🔸 Own-Objects-Only & ⚠️ Approval Outcomes", () => {
  it("denies own_only permissions when caller is not the owner", () => {
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_alice",
      permission: "investigation.define",
      workspaceRole: "investigator",
      targetObjectOwnerId: "user_bob", // not owner!
    };

    const res = evaluatePermission(ctx);
    expect(res.allowed).toBe(false);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toBe("own_objects_only");
  });

  it("treats requires_approval as allowed: false", () => {
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_alice",
      permission: "source.purge",
      workspaceRole: "ws_admin",
    };

    const res = evaluatePermission(ctx);
    expect(res.allowed).toBe(false);
    expect(res.outcome).toBe("requires_approval");
    expect(res.reason).toBe("approval_required");
  });
});

describe("packages/policy — Investigation Role Overrides (D48)", () => {
  it("investigation role replaces workspace role within investigation", () => {
    // User is a viewer in workspace, but assigned lead in investigation
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_alice",
      permission: "evidence.create",
      workspaceRole: "viewer", // would be denied
      investigationId: "inv_1",
      investigationRole: "lead", // should allow
    };

    const res = evaluatePermission(ctx);
    expect(res.allowed).toBe(true);
    expect(res.outcome).toBe("allow");
    expect(res.effectiveRole).toBe("lead_inv");
  });

  it("investigation.archive is exclusively allowed for owner, not lead (D48)", () => {
    const leadCtx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_lead",
      permission: "investigation.archive",
      investigationId: "inv_1",
      investigationRole: "lead",
    };
    expect(evaluatePermission(leadCtx).allowed).toBe(false);

    const ownerCtx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_owner",
      permission: "investigation.archive",
      investigationId: "inv_1",
      investigationRole: "owner",
    };
    expect(evaluatePermission(ownerCtx).allowed).toBe(true);
  });

  // The database stores investigation roles as 'lead_investigator' | 'investigator' |
  // 'reviewer' | 'auditor' | 'viewer' (investigation_members CHECK constraint); the ingest
  // bootstrap and investigation creation both grant 'lead_investigator'.
  it("maps the stored investigation roles lead_investigator and auditor (D72)", () => {
    const base = { tenantId: "11111111-1111-1111-1111-111111111111", userId: "user_x", investigationId: "inv_1" };
    const lead = evaluatePermission({ ...base, permission: "source.read", workspaceRole: "viewer", investigationRole: "lead_investigator" });
    expect(lead.allowed).toBe(true);
    expect(lead.effectiveRole).toBe("lead_inv");

    const auditor = evaluatePermission({ ...base, permission: "audit.read", investigationRole: "auditor" });
    expect(auditor.effectiveRole).toBe("auditor");
    expect(auditor.reason).not.toBe("unknown_investigation_role");
  });
});

describe("packages/policy — Ethical Walls Hard Override (REQ-M-RBAC-006)", () => {
  it("ethical wall unconditionally denies access regardless of role", () => {
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_alice",
      permission: "investigation.read",
      workspaceRole: "ws_admin",
      investigationId: "inv_conflict",
      ethicalWalls: [
        {
          userId: "user_alice",
          investigationId: "inv_conflict",
        },
      ],
    };

    const res = evaluatePermission(ctx);
    expect(res.allowed).toBe(false);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toBe("ethical_wall");
  });
});

describe("packages/policy — Denial Audit Helper (REQ-M-AUDIT-006)", () => {
  it("constructs denial audit event with outcome denied and denial reason", () => {
    const ctx: AuthContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user_alice",
      permission: "source.purge",
      workspaceRole: "investigator",
      targetObjectId: "src_123",
      targetObjectType: "source",
      requestId: "req_audit_test",
    };

    const evalResult = evaluatePermission(ctx);
    const auditEvent = createPolicyDenialAuditEvent(ctx, evalResult);

    expect(auditEvent.outcome).toBe("denied");
    expect(auditEvent.actorId).toBe("user_alice");
    expect(auditEvent.action).toBe("auth.deny:source.purge");
    expect(auditEvent.denialReason).toBe(evalResult.reason);
  });
});

describe("packages/policy — Architecture Check", () => {
  const POLICY_ALLOWLIST = [
    "packages/policy/",
  ] as const;

  it("no other module defines its own PERMISSIONS_MATRIX", () => {
    const matches = hits("PERMISSIONS_MATRIX", POLICY_ALLOWLIST);
    expect(matches).toEqual([]);
  });
});
