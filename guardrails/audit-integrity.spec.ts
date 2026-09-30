/**
 * GUARDRAIL: audit-integrity  —  invariant I8  ·  threat T7  ·  AC-SEC-03/04/06
 *
 * PRD §39 (auditability), §40 (security architecture), §62 T7 (evidence tampering).
 *
 * "Evidence immutable; span hashes; WORM storage with versioning; hash-chained audit
 *  log; no UPDATE/DELETE grants on audit." — T7
 *
 * The audit log is the artifact that makes an investigation defensible after the fact.
 * If it can be edited, nothing else in the product means anything. These tests attack
 * it as an insider would: with legitimate application credentials.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { getDbUrl, createDbClient, withTenant } from "../packages/db/src/index.js";
import {
  writeAuditEvent,
  verifyAuditChain,
  computeEventHash,
  GENESIS_HASH,
  type AuditEvent,
} from "../packages/audit/src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function hits(pattern: string, allowlist: readonly string[], regex = false): string[] {
  return grepRepo(pattern, !regex).filter((line) => {
    const file = line.split(":")[0] ?? "";
    const rel = relative(ROOT, resolve(ROOT, file)).split("\\").join("/");
    if (allowlist.some((a) => rel === a || rel.startsWith(a))) return false;
    return !(rel.startsWith("docs/") || rel === ".env.example" ||
             rel === "traceability/requirements.yaml" || rel === "traceability/manual.yaml");
  });
}

const AUDIT_WRITER_ALLOWLIST = [
  "packages/audit/src/writer.ts",
  "packages/db/migrations/",
  "guardrails/audit-integrity.spec.ts",
  "packages/db/test/",
  "packages/audit/test/",
] as const;

describe("I8 — audit events are insert-only for every application role", () => {
  let appDb: postgres.Sql;

  beforeAll(() => {
    appDb = createDbClient(getDbUrl());
  });

  afterAll(async () => {
    if (appDb) await appDb.end();
  });

  it("the application role has INSERT and SELECT on audit_events and nothing else", async () => {
    const privileges = await appDb<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'casefile_app'
        AND table_name = 'audit_events';
    `;

    const privList = privileges.map((p) => p.privilege_type.toUpperCase());
    expect(privList).toContain("SELECT");
    expect(privList).toContain("INSERT");
    expect(privList).not.toContain("UPDATE");
    expect(privList).not.toContain("DELETE");
    expect(privList).not.toContain("TRUNCATE");
  });

  it("UPDATE on audit_events fails with insufficient privilege, not silently", async () => {
    await expect(
      appDb`UPDATE audit_events SET action = 'tampered' WHERE true`,
    ).rejects.toThrow(/permission denied/i);
  });

  it("DELETE on audit_events fails with insufficient privilege, not silently", async () => {
    await expect(
      appDb`DELETE FROM audit_events WHERE true`,
    ).rejects.toThrow(/permission denied/i);
  });

  it("TRUNCATE on audit_events fails", async () => {
    await expect(
      appDb`TRUNCATE audit_events`,
    ).rejects.toThrow(/permission denied/i);
  });

  it("no migration in packages/db grants UPDATE or DELETE on audit_events to an application role", () => {
    const allowlist = ["guardrails/audit-integrity.spec.ts"] as const;
    const badGrants = [
      ...hits("GRANT UPDATE ON audit_events TO casefile_app", allowlist),
      ...hits("GRANT DELETE ON audit_events TO casefile_app", allowlist),
      ...hits("GRANT ALL ON audit_events TO casefile_app", allowlist),
    ];
    expect(badGrants).toEqual([]);
  });

  it("writeAuditEvent is the ONLY code permitted to INSERT into audit_events (arch test)", () => {
    const directInserts = hits("INSERT INTO audit_events", AUDIT_WRITER_ALLOWLIST);
    expect(
      directInserts,
      `Direct INSERT into audit_events found outside packages/audit/src/writer.ts:\n${directInserts.join("\n")}`,
    ).toEqual([]);
  });

  it("the application role has SELECT, INSERT, UPDATE on audit_chain_heads and NO DELETE", async () => {
    const privileges = await appDb<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'casefile_app'
        AND table_name = 'audit_chain_heads';
    `;

    const privList = privileges.map((p) => p.privilege_type.toUpperCase());
    expect(privList).toContain("SELECT");
    expect(privList).toContain("INSERT");
    expect(privList).toContain("UPDATE");
    expect(privList).not.toContain("DELETE");
    expect(privList).not.toContain("TRUNCATE");

    await expect(
      appDb`DELETE FROM audit_chain_heads WHERE true`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("I8 — the hash chain verifies", () => {
  function makeChain(count: number): AuditEvent[] {
    const chain: AuditEvent[] = [];
    const tenantId = "88888888-8888-8888-8888-888888888888";

    for (let i = 0; i < count; i++) {
      const seq = i + 1;
      const prevHash = i === 0 ? GENESIS_HASH : chain[i - 1]!.hash;
      const timestamp = new Date(Date.UTC(2026, 7, 31, 2, i, 0)).toISOString();
      const eventData: Partial<AuditEvent> = {
        id: `80000000-0000-0000-0000-00000000000${i}`,
        tenant_id: tenantId,
        seq,
        workspace_id: null,
        investigation_id: null,
        timestamp,
        actor_type: "user",
        actor_id: "11111111-1111-1111-1111-111111111111",
        actor_display: "Tester",
        action: `action.${i}`,
        object_type: "item",
        object_id: `22222222-2222-2222-2222-22222222222${i}`,
        object_display: `Item ${i}`,
        request_id: `req_${i}`,
        outcome: "success",
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

  it("each event's hash covers its payload and its predecessor's hash", () => {
    const chain = makeChain(3);
    const res = verifyAuditChain(chain);
    expect(res.valid).toBe(true);
    expect(res.verifiedCount).toBe(3);
  });

  it("the chain verifier detects a mutated payload", () => {
    const chain = makeChain(4);
    chain[2]!.action = "mutated.action";

    const res = verifyAuditChain(chain);
    expect(res.valid).toBe(false);
    expect(res.break?.type).toBe("mutated_payload");
    expect(res.break?.index).toBe(2);
  });

  it("the chain verifier detects a deleted event as a break, not as a gap it can skip", () => {
    const chain = makeChain(4);
    chain.splice(1, 1); // remove index 1

    const res = verifyAuditChain(chain);
    expect(res.valid).toBe(false);
    expect(res.break?.type).toBe("broken_link");
    expect(res.break?.index).toBe(1);
  });

  it("the chain verifier detects a truncated tail against expected chain head", () => {
    const chain = makeChain(4);
    const last = chain[3]!;
    chain.pop(); // remove tail

    const res = verifyAuditChain(chain, { lastSeq: 4, lastHash: last.hash });
    expect(res.valid).toBe(false);
    expect(res.break?.type).toBe("truncated_tail");
  });

  it("the chain verifier detects a reordered event", () => {
    const chain = makeChain(4);
    const tmp = chain[1]!;
    chain[1] = chain[2]!;
    chain[2] = tmp;

    const res = verifyAuditChain(chain);
    expect(res.valid).toBe(false);
  });

  it.todo("chain verification runs nightly and its failure is a P1");
});

describe("AC-SEC-03/04/06 — what must be audited", () => {
  it.todo("every permission denial is recorded, not only every grant");
  it.todo("every PolicyViolationAttempted from the Assertion Service is recorded");
  it.todo("every export and every download is recorded with actor, scope, and destination");
  it.todo("every break-glass access is recorded and is visible to the customer");

  it("audit writes happen in the same transaction as the change they describe", async () => {
    const appDb = createDbClient(getDbUrl());
    const tenantId = "77777777-7777-7777-7777-777777777777";

    try {
      await withTenant(tenantId, async (tx) => {
        await tx`
          INSERT INTO organizations (id, tenant_id, name)
          VALUES (${tenantId}, ${tenantId}, 'Tx Rollback Org')
          ON CONFLICT (id) DO NOTHING;
        `;
      }, appDb);

      // Attempt transactional mutation + audit that fails
      await expect(
        withTenant(tenantId, async (tx) => {
          await writeAuditEvent(tx, {
            tenantId,
            actorType: "user",
            actorId: "11111111-1111-1111-1111-111111111111",
            actorDisplay: "Alice",
            action: "aborted.operation",
            objectType: "workspace",
            objectId: "33333333-3333-3333-3333-333333333333",
            objectDisplay: "WS",
            requestId: "req_abort",
            outcome: "success",
          });

          throw new Error("Forced business logic failure");
        }, appDb),
      ).rejects.toThrow("Forced business logic failure");

      // Verify audit row was rolled back together with the transaction
      await withTenant(tenantId, async (tx) => {
        const rows = await tx`SELECT * FROM audit_events WHERE action = 'aborted.operation'`;
        expect(rows.length).toBe(0);
      }, appDb);
    } finally {
      await appDb.end();
    }
  });
});

describe("T7 — evidence immutability", () => {
  it.todo("an evidence row cannot be updated after creation");
  it.todo("withdrawing evidence creates a withdrawal record and never deletes the original");
  it.todo("EvidenceWithdrawn triggers a finding integrity check on every dependent finding");
});

describe("§40.8 / D25 — no certification claims", () => {
  it.todo("no string in the UI, docs, or marketing copy asserts a completed certification");
});
