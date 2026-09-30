import type { Sql, TransactionSql } from "postgres";
import type { AuditEvent, AuditVerificationResult, AuditChainHead } from "./types.js";
import { computeEventHash, GENESIS_HASH } from "./hasher.js";

export interface ExpectedHead {
  lastSeq: number | string | bigint;
  lastHash: string;
}

/**
 * verifyAuditChain() — walks a list of audit events in sequence order and checks:
 * 1. Genesis predecessor hash validity
 * 2. Contiguous sequence ordering (seq = 1, 2, 3, ... with no gaps)
 * 3. Hash-link continuity (prev_hash === previous event hash)
 * 4. Payload integrity (recomputed SHA-256 matches event.hash)
 * 5. Tail termination against expected chain head (detects truncated tail)
 */
export function verifyAuditChain(
  events: AuditEvent[],
  expectedHead?: ExpectedHead,
): AuditVerificationResult {
  if (events.length === 0) {
    if (expectedHead && Number(expectedHead.lastSeq) > 0) {
      return {
        valid: false,
        verifiedCount: 0,
        break: {
          type: "truncated_tail",
          index: 0,
          eventId: "",
          detail: `Tail truncated: expected chain ending at seq ${expectedHead.lastSeq}, but zero events found`,
          expected: String(expectedHead.lastSeq),
          actual: "0",
        },
      };
    }
    return { valid: true, verifiedCount: 0 };
  }

  for (let i = 0; i < events.length; i++) {
    const current = events[i]!;
    const expectedSeq = i + 1;

    // 1. Contiguous sequence check
    if (Number(current.seq) !== expectedSeq) {
      return {
        valid: false,
        verifiedCount: i,
        break: {
          type: "broken_link",
          index: i,
          eventId: current.id,
          detail: `Sequence gap at index ${i}: expected seq ${expectedSeq}, got ${current.seq}`,
          expected: String(expectedSeq),
          actual: String(current.seq),
        },
      };
    }

    // 2. Genesis / Linkage check
    if (i === 0) {
      if (current.prev_hash && current.prev_hash !== GENESIS_HASH) {
        return {
          valid: false,
          verifiedCount: 0,
          break: {
            type: "genesis_mismatch",
            index: 0,
            eventId: current.id,
            detail: `First event prev_hash must be genesis hash (${GENESIS_HASH}), got ${current.prev_hash}`,
            expected: GENESIS_HASH,
            actual: current.prev_hash,
          },
        };
      }
    } else {
      const prev = events[i - 1]!;

      if (current.prev_hash !== prev.hash) {
        return {
          valid: false,
          verifiedCount: i,
          break: {
            type: "broken_link",
            index: i,
            eventId: current.id,
            detail: `Chain broken at event ${current.id}: prev_hash (${current.prev_hash}) does not match predecessor hash (${prev.hash})`,
            expected: prev.hash,
            actual: current.prev_hash ?? "",
          },
        };
      }
    }

    // 3. Payload integrity check (recompute hash including seq)
    const expectedHash = computeEventHash(current, current.prev_hash);
    if (expectedHash !== current.hash) {
      return {
        valid: false,
        verifiedCount: i,
        break: {
          type: "mutated_payload",
          index: i,
          eventId: current.id,
          detail: `Event ${current.id} payload mutated: stored hash (${current.hash}) does not match computed hash (${expectedHash})`,
          expected: expectedHash,
          actual: current.hash,
        },
      };
    }
  }

  // 4. Tail termination check against audit_chain_heads
  if (expectedHead) {
    const lastEvent = events[events.length - 1]!;
    const expectedLastSeq = Number(expectedHead.lastSeq);

    if (Number(lastEvent.seq) !== expectedLastSeq || lastEvent.hash !== expectedHead.lastHash) {
      return {
        valid: false,
        verifiedCount: events.length,
        break: {
          type: "truncated_tail",
          index: events.length - 1,
          eventId: lastEvent.id,
          detail: `Tail truncated: expected chain head at seq ${expectedLastSeq} (${expectedHead.lastHash}), but chain ends at seq ${lastEvent.seq} (${lastEvent.hash})`,
          expected: expectedHead.lastHash,
          actual: lastEvent.hash,
        },
      };
    }
  }

  return {
    valid: true,
    verifiedCount: events.length,
  };
}

/**
 * verifyTenantAuditChain() — reads all events and head for a tenant and verifies chain integrity.
 */
export async function verifyTenantAuditChain(
  client: Sql | TransactionSql,
  tenantId: string,
): Promise<AuditVerificationResult> {
  const headRows = await client<AuditChainHead[]>`
    SELECT last_seq, last_hash
    FROM audit_chain_heads
    WHERE tenant_id = ${tenantId};
  `;

  const head = headRows[0];
  const expectedHead: ExpectedHead | undefined = head
    ? { lastSeq: head.last_seq, lastHash: head.last_hash }
    : undefined;

  const events = await client<AuditEvent[]>`
    SELECT *
    FROM audit_events
    WHERE tenant_id = ${tenantId}
    ORDER BY seq ASC;
  `;

  return verifyAuditChain(events, expectedHead);
}
