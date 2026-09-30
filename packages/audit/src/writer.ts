import { randomUUID } from "node:crypto";
import { jsonb, storableInJsonb, type Tx } from "@casefile/db";
import type { AuditEventInput, AuditEvent, AuditChainHead } from "./types.js";
import { computeEventHash, GENESIS_HASH } from "./hasher.js";
import { generateUlid } from "./ulid.js";

/**
 * BIGDATA-4 (plan answer 10): how long this process waited for the tenant's chain head lock (the
 * SELECT ... FOR UPDATE below, one database round trip included), how many audit rows it chained,
 * and, per transaction, when it first held the lock (a caller that times its own commit gets the
 * time it held the chain). Measurement only: nothing about the row, its hash or the order in which
 * rows are chained depends on it.
 */
export interface AuditChainStats {
  rows: number;
  waitMs: number;
}
export const auditChainStats: AuditChainStats = { rows: 0, waitMs: 0 };
const chainTakenAt = new WeakMap<object, number>();

/** When (performance.now()) the transaction first held the chain head lock, or undefined if it never wrote an audit row. */
export function auditChainTakenAt(tx: object): number | undefined {
  return chainTakenAt.get(tx);
}

/**
 * writeAuditEvent() — the ONLY code in the codebase permitted to insert into audit_events.
 *
 * Must be executed in the SAME database transaction (tx) as the business operation.
 * Allocates a contiguous per-tenant sequence (seq) and updates audit_chain_heads (D52).
 *
 * before / after / ai_involvement are stored as JSON objects since FIXES-1 (DEV-031; rows written
 * before hold the same JSON as text). The hash does not depend on which: computeEventHash() hashes
 * the parsed value, here the object itself, in the verifier whatever comes back from the column.
 */
export async function writeAuditEvent(
  tx: Tx,
  input: AuditEventInput,
): Promise<AuditEvent> {
  const timestamp = input.timestamp instanceof Date ? input.timestamp : new Date();
  const id = input.id || generateUlid(timestamp.getTime());
  const requestId = input.requestId || randomUUID();

  // Lock and fetch current chain head for this tenant within the same transaction
  const lockAsked = performance.now();
  const headRows = await tx<AuditChainHead[]>`
    SELECT last_seq, last_hash
    FROM audit_chain_heads
    WHERE tenant_id = ${input.tenantId}
    FOR UPDATE;
  `;
  const lockHeld = performance.now();
  auditChainStats.rows += 1;
  auditChainStats.waitMs += lockHeld - lockAsked;
  if (!chainTakenAt.has(tx)) chainTakenAt.set(tx, lockHeld);

  const head = headRows[0];
  let lastSeq = 0;
  let prevHash = GENESIS_HASH;

  if (head) {
    lastSeq = Number(head.last_seq);
    prevHash = head.last_hash || GENESIS_HASH;
  } else {
    const maxRows = await tx<{ max_seq: string | number | null; last_hash: string | null }[]>`
      SELECT MAX(seq) AS max_seq, (SELECT hash FROM audit_events WHERE tenant_id = ${input.tenantId} ORDER BY seq DESC LIMIT 1) AS last_hash
      FROM audit_events
      WHERE tenant_id = ${input.tenantId};
    `;
    if (maxRows[0]?.max_seq !== null && maxRows[0]?.max_seq !== undefined) {
      lastSeq = Number(maxRows[0].max_seq);
      prevHash = maxRows[0].last_hash || GENESIS_HASH;
    }
  }

  const seq = lastSeq + 1;

  const eventPayload: Partial<AuditEvent> = {
    id,
    tenant_id: input.tenantId,
    seq,
    workspace_id: input.workspaceId || null,
    investigation_id: input.investigationId || null,
    timestamp,
    actor_type: input.actorType,
    actor_id: input.actorId,
    actor_display: input.actorDisplay,
    on_behalf_of: input.onBehalfOf || null,
    session_id: input.sessionId || null,
    ip_hash: input.ipHash || null,
    action: input.action,
    object_type: input.objectType,
    object_id: input.objectId,
    object_display: input.objectDisplay,
    before: input.before || null,
    after: input.after || null,
    rationale: input.rationale || null,
    ai_involvement: input.aiInvolvement || null,
    request_id: requestId,
    outcome: input.outcome,
    denial_reason: input.denialReason || null,
    prev_hash: prevHash,
  };

  const hash = computeEventHash(eventPayload, prevHash);

  // 1. Insert audit event
  const inserted = await tx<AuditEvent[]>`
    INSERT INTO audit_events (
      id, tenant_id, seq, workspace_id, investigation_id, timestamp,
      actor_type, actor_id, actor_display, on_behalf_of, session_id, ip_hash,
      action, object_type, object_id, object_display,
      before, after, rationale, ai_involvement, request_id, outcome, denial_reason,
      prev_hash, hash
    ) VALUES (
      ${id},
      ${input.tenantId},
      ${seq},
      ${input.workspaceId || null},
      ${input.investigationId || null},
      ${timestamp},
      ${input.actorType},
      ${input.actorId},
      ${input.actorDisplay},
      ${input.onBehalfOf || null},
      ${input.sessionId || null},
      ${input.ipHash || null},
      ${input.action},
      ${input.objectType},
      ${input.objectId},
      ${input.objectDisplay},
      ${input.before ? jsonb(tx, input.before) : null},
      ${input.after ? jsonb(tx, input.after) : null},
      ${input.rationale || null},
      ${input.aiInvolvement ? jsonb(tx, input.aiInvolvement) : null},
      ${requestId},
      ${input.outcome},
      ${input.denialReason || null},
      ${prevHash},
      ${hash}
    )
    RETURNING *;
  `;

  if (!inserted[0]) {
    throw new Error(`Failed to write audit event ${id}`);
  }

  // 2. Advance audit_chain_heads for this tenant in the same transaction
  await tx`
    INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash, updated_at)
    VALUES (${input.tenantId}, ${seq}, ${hash}, NOW())
    ON CONFLICT (tenant_id) DO UPDATE
    SET last_seq = EXCLUDED.last_seq,
        last_hash = EXCLUDED.last_hash,
        updated_at = EXCLUDED.updated_at;
  `;

  return inserted[0];
}

/**
 * writeAuditEvents() — BIGDATA-4 (plan answer 10): the same rows as calling writeAuditEvent() once
 * per event, in the given order, in the same transaction — each row's seq, prev_hash and hash are
 * computed exactly as there, one after the other — written in one step: one lock of the tenant's
 * chain head, one multi-row INSERT, one head update. The chain is hashed and ordered as before; the
 * chain head is held for one step instead of one step per row. Still the ONLY way rows reach
 * audit_events, still in the caller's transaction (I8).
 */
/**
 * A jsonb column's value in a multi-row INSERT, stored exactly as jsonb() stores it for one row: the
 * object itself (postgres.js serialises it with JSON.stringify, as sql.json does), or, when jsonb
 * cannot hold it (U+0000, an unpaired surrogate), its JSON text (FIXES-1, DEV-031).
 */
function jsonValue(v: Record<string, unknown> | null | undefined) {
  if (!v) return null;
  return storableInJsonb(v) ? JSON.parse(JSON.stringify(v)) : JSON.stringify(v);
}

export async function writeAuditEvents(tx: Tx, inputs: readonly AuditEventInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const tenantId = inputs[0]!.tenantId;
  if (inputs.some((i) => i.tenantId !== tenantId)) throw new Error("writeAuditEvents: every event of one call must be of one tenant (one chain)");
  const lockAsked = performance.now();
  const headRows = await tx<AuditChainHead[]>`
    SELECT last_seq, last_hash
    FROM audit_chain_heads
    WHERE tenant_id = ${tenantId}
    FOR UPDATE;
  `;
  const lockHeld = performance.now();
  auditChainStats.rows += inputs.length;
  auditChainStats.waitMs += lockHeld - lockAsked;
  if (!chainTakenAt.has(tx)) chainTakenAt.set(tx, lockHeld);
  let lastSeq = 0;
  let prevHash = GENESIS_HASH;
  const head = headRows[0];
  if (head) {
    lastSeq = Number(head.last_seq);
    prevHash = head.last_hash || GENESIS_HASH;
  } else {
    const maxRows = await tx<{ max_seq: string | number | null; last_hash: string | null }[]>`
      SELECT MAX(seq) AS max_seq, (SELECT hash FROM audit_events WHERE tenant_id = ${tenantId} ORDER BY seq DESC LIMIT 1) AS last_hash
      FROM audit_events
      WHERE tenant_id = ${tenantId};
    `;
    if (maxRows[0]?.max_seq !== null && maxRows[0]?.max_seq !== undefined) {
      lastSeq = Number(maxRows[0].max_seq);
      prevHash = maxRows[0].last_hash || GENESIS_HASH;
    }
  }
  const rows = inputs.map((input) => {
    const timestamp = input.timestamp instanceof Date ? input.timestamp : new Date();
    const id = input.id || generateUlid(timestamp.getTime());
    const requestId = input.requestId || randomUUID();
    const seq = ++lastSeq;
    const eventPayload: Partial<AuditEvent> = {
      id, tenant_id: tenantId, seq, workspace_id: input.workspaceId || null, investigation_id: input.investigationId || null, timestamp,
      actor_type: input.actorType, actor_id: input.actorId, actor_display: input.actorDisplay, on_behalf_of: input.onBehalfOf || null,
      session_id: input.sessionId || null, ip_hash: input.ipHash || null, action: input.action, object_type: input.objectType,
      object_id: input.objectId, object_display: input.objectDisplay, before: input.before || null, after: input.after || null,
      rationale: input.rationale || null, ai_involvement: input.aiInvolvement || null, request_id: requestId, outcome: input.outcome,
      denial_reason: input.denialReason || null, prev_hash: prevHash,
    };
    const hash = computeEventHash(eventPayload, prevHash);
    const row = {
      id, tenant_id: tenantId, seq, workspace_id: input.workspaceId || null, investigation_id: input.investigationId || null, timestamp,
      actor_type: input.actorType, actor_id: input.actorId, actor_display: input.actorDisplay, on_behalf_of: input.onBehalfOf || null,
      session_id: input.sessionId || null, ip_hash: input.ipHash || null, action: input.action, object_type: input.objectType,
      object_id: input.objectId, object_display: input.objectDisplay,
      before: jsonValue(input.before), after: jsonValue(input.after), rationale: input.rationale || null,
      ai_involvement: jsonValue(input.aiInvolvement), request_id: requestId, outcome: input.outcome,
      denial_reason: input.denialReason || null, prev_hash: prevHash, hash,
    };
    prevHash = hash;
    return row;
  });
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const res = await tx`
      INSERT INTO audit_events ${tx(batch, "id", "tenant_id", "seq", "workspace_id", "investigation_id", "timestamp", "actor_type", "actor_id", "actor_display",
        "on_behalf_of", "session_id", "ip_hash", "action", "object_type", "object_id", "object_display", "before", "after", "rationale",
        "ai_involvement", "request_id", "outcome", "denial_reason", "prev_hash", "hash")}
    `;
    written += res.count;
  }
  if (written !== rows.length) throw new Error(`Failed to write ${rows.length} audit events (${written} written)`);
  await tx`
    INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash, updated_at)
    VALUES (${tenantId}, ${lastSeq}, ${prevHash}, NOW())
    ON CONFLICT (tenant_id) DO UPDATE
    SET last_seq = EXCLUDED.last_seq,
        last_hash = EXCLUDED.last_hash,
        updated_at = EXCLUDED.updated_at;
  `;
  return written;
}
