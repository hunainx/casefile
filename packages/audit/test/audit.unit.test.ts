import { describe, it, expect } from "vitest";
import {
  canonicalizeJson,
  computeEventHash,
  verifyAuditChain,
  GENESIS_HASH,
  type AuditEvent,
} from "../src/index.js";

describe("packages/audit — Unit Tests", () => {
  describe("canonicalizeJson", () => {
    it("sorts object keys recursively and stably", () => {
      const obj1 = { z: 1, a: 2, m: { b: 3, a: 4 } };
      const obj2 = { a: 2, m: { a: 4, b: 3 }, z: 1 };
      expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
      expect(canonicalizeJson(obj1)).toBe('{"a":2,"m":{"a":4,"b":3},"z":1}');
    });

    it("handles null, arrays, numbers, and dates", () => {
      const date = new Date("2026-08-31T02:00:00.000Z");
      expect(canonicalizeJson(null)).toBe("null");
      expect(canonicalizeJson([3, 2, 1])).toBe("[3,2,1]");
      expect(canonicalizeJson(date)).toBe('"2026-08-31T02:00:00.000Z"');
    });
  });

  describe("computeEventHash", () => {
    it("produces deterministic 64-char hex SHA-256 hash", () => {
      const event: Partial<AuditEvent> = {
        id: "11111111-1111-1111-1111-111111111111",
        tenant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        timestamp: "2026-08-31T02:00:00.000Z",
        actor_type: "user",
        actor_id: "22222222-2222-2222-2222-222222222222",
        actor_display: "Alice",
        action: "workspace.create",
        object_type: "workspace",
        object_id: "33333333-3333-3333-3333-333333333333",
        object_display: "Matters",
        request_id: "req_1",
        outcome: "success",
      };

      const hash1 = computeEventHash(event, GENESIS_HASH);
      const hash2 = computeEventHash(event, GENESIS_HASH);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });

    it("changes hash when predecessor hash changes", () => {
      const event: Partial<AuditEvent> = {
        id: "11111111-1111-1111-1111-111111111111",
        tenant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        timestamp: "2026-08-31T02:00:00.000Z",
        actor_type: "user",
        actor_id: "22222222-2222-2222-2222-222222222222",
        actor_display: "Alice",
        action: "workspace.create",
        object_type: "workspace",
        object_id: "33333333-3333-3333-3333-333333333333",
        object_display: "Matters",
        request_id: "req_1",
        outcome: "success",
      };

      const hash1 = computeEventHash(event, GENESIS_HASH);
      const hash2 = computeEventHash(event, "a".repeat(64));

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("verifyAuditChain", () => {
    function createMockChain(count: number): AuditEvent[] {
      const chain: AuditEvent[] = [];
      const tenantId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

      for (let i = 0; i < count; i++) {
        const seq = i + 1;
        const prevHash = i === 0 ? GENESIS_HASH : chain[i - 1]!.hash;
        const timestamp = new Date(Date.UTC(2026, 7, 31, 2, i, 0)).toISOString();
        const eventData: Partial<AuditEvent> = {
          id: `00000000-0000-0000-0000-00000000000${i}`,
          tenant_id: tenantId,
          seq,
          workspace_id: null,
          investigation_id: null,
          timestamp,
          actor_type: "user",
          actor_id: "11111111-1111-1111-1111-111111111111",
          actor_display: "Tester",
          on_behalf_of: null,
          session_id: null,
          ip_hash: null,
          action: `action.${i}`,
          object_type: "item",
          object_id: `22222222-2222-2222-2222-22222222222${i}`,
          object_display: `Item ${i}`,
          before: null,
          after: null,
          rationale: null,
          ai_involvement: null,
          request_id: `req_${i}`,
          outcome: "success",
          denial_reason: null,
          prev_hash: prevHash,
        };

        const hash = computeEventHash(eventData, prevHash);
        chain.push({
          ...(eventData as AuditEvent),
          hash,
        });
      }

      return chain;
    }

    it("verifies a valid, uncorrupted audit chain", () => {
      const chain = createMockChain(5);
      const result = verifyAuditChain(chain);

      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(5);
      expect(result.break).toBeUndefined();
    });

    it("detects a mutated event payload in the chain", () => {
      const chain = createMockChain(5);
      // Tamper with payload of event 2 without updating hash
      chain[2]!.action = "tampered.action";

      const result = verifyAuditChain(chain);
      expect(result.valid).toBe(false);
      expect(result.verifiedCount).toBe(2);
      expect(result.break?.type).toBe("mutated_payload");
      expect(result.break?.index).toBe(2);
    });

    it("detects a deleted event as a broken link", () => {
      const chain = createMockChain(5);
      // Delete event 2
      chain.splice(2, 1);

      const result = verifyAuditChain(chain);
      expect(result.valid).toBe(false);
      expect(result.verifiedCount).toBe(2);
      expect(result.break?.type).toBe("broken_link");
      expect(result.break?.index).toBe(2);
    });

    it("detects reordered events in the chain", () => {
      const chain = createMockChain(5);
      // Swap event 2 and 3
      const temp = chain[2]!;
      chain[2] = chain[3]!;
      chain[3] = temp;

      const result = verifyAuditChain(chain);
      expect(result.valid).toBe(false);
      expect(result.break).toBeDefined();
    });

    it("detects tail truncation when the last event is deleted", () => {
      const chain = createMockChain(5);
      const originalLast = chain[4]!;
      // Truncate the tail
      chain.pop();

      // Verify with expected head
      const result = verifyAuditChain(chain, {
        lastSeq: 5,
        lastHash: originalLast.hash,
      });

      expect(result.valid).toBe(false);
      expect(result.break?.type).toBe("truncated_tail");
    });
  });
});
