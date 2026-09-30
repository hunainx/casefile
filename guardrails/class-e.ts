/**
 * PRD §26.2 / §60 Class E — PROHIBITED.
 *
 * "These are not permission-gated. They do not exist as callable functions in any
 *  AI code path. A CI architecture test asserts that no tool registry passed to any
 *  model invocation contains a name from this list."
 *
 * This file is the single source of truth for that list. It is DATA, not behavior:
 * nothing here may ever be turned into a function, a stub, a mock, or a commented-out
 * implementation. guardrails/injection.spec.ts greps the whole repository for these
 * names and fails on any occurrence outside this file and its own test.
 *
 * Invariant I6.
 */

export const CLASS_E_TOOL_NAMES = [
  "verify_assertion",
  "refute_assertion",
  "approve_finding",
  "publish_report",
  "create_export",
  "share_object",
  "delete_anything",
  "purge_source",
  "withdraw_source",
  "modify_scope",
  "modify_permissions",
  "merge_entities",
  "send_message",
  "modify_audit",
  "change_workspace_policy",
] as const;

export type ClassETool = (typeof CLASS_E_TOOL_NAMES)[number];

/**
 * Files permitted to contain a Class E name. Exactly two: this declaration, and the
 * guardrail that enforces it. Adding to this list requires explicit user sign-off —
 * it is a change to invariant I6.
 */
export const CLASS_E_ALLOWLIST = [
  "guardrails/class-e.ts",
  "guardrails/injection.spec.ts",
] as const;

/**
 * PRD §26.2 action classes. Class D requires explicit per-action human confirmation;
 * Class B is the AI privilege ceiling on content-processing paths (D14, §29.2).
 */
export const ACTION_CLASSES = ["A", "B", "C", "D"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** The AI can never be granted an action class above this on a content-processing path. */
export const CONTENT_PATH_PRIVILEGE_CEILING: ActionClass = "B";
