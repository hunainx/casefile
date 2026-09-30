import { createHash } from "node:crypto";
import type { AuditEvent } from "./types.js";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Deterministic JSON canonicalization (sorted keys recursively).
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "number" || typeof obj === "boolean") return JSON.stringify(obj);
  if (typeof obj === "string") return JSON.stringify(obj);
  if (obj instanceof Date) return JSON.stringify(obj.toISOString());

  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalizeJson(item)).join(",") + "]";
  }

  if (typeof obj === "object") {
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map((key) => {
      const val = (obj as Record<string, unknown>)[key];
      return JSON.stringify(key) + ":" + canonicalizeJson(val);
    });
    return "{" + pairs.join(",") + "}";
  }

  return JSON.stringify(String(obj));
}

function parseJsonField(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

export type HashableEventFields = Omit<AuditEvent, "hash" | "created_at" | "updated_at" | "created_by">;

/**
 * Computes SHA-256 hash for an audit event chained to its predecessor's hash.
 */
export function computeEventHash(
  event: Partial<AuditEvent>,
  prevHash: string | null = null,
): string {
  const normalizedPrevHash = prevHash || GENESIS_HASH;

  const timestampIso =
    event.timestamp instanceof Date
      ? event.timestamp.toISOString()
      : typeof event.timestamp === "string"
        ? new Date(event.timestamp).toISOString()
        : new Date().toISOString();

  const payload: Record<string, unknown> = {
    id: event.id ?? "",
    tenant_id: event.tenant_id ?? "",
    seq: Number(event.seq ?? 1),
    workspace_id: event.workspace_id ?? null,
    investigation_id: event.investigation_id ?? null,
    timestamp: timestampIso,
    actor_type: event.actor_type ?? "user",
    actor_id: event.actor_id ?? "",
    actor_display: event.actor_display ?? "",
    on_behalf_of: event.on_behalf_of ?? null,
    session_id: event.session_id ?? null,
    ip_hash: event.ip_hash ?? null,
    action: event.action ?? "",
    object_type: event.object_type ?? "",
    object_id: event.object_id ?? "",
    object_display: event.object_display ?? "",
    before: parseJsonField(event.before) ?? null,
    after: parseJsonField(event.after) ?? null,
    rationale: event.rationale ?? null,
    ai_involvement: parseJsonField(event.ai_involvement) ?? null,
    request_id: event.request_id ?? "",
    outcome: event.outcome ?? "success",
    denial_reason: event.denial_reason ?? null,
    prev_hash: normalizedPrevHash,
  };

  const canonical = canonicalizeJson(payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
