import { randomUUID, createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  CreateAssertionRequestSchema,
  ValidateAssertionRequestSchema,
  AssertionSchema,
  DivergenceNoticeSchema,
  ContradictionAlertSchema,
  PaginationQuerySchema,
} from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import { encodeCursor, decodeCursor } from "../pagination.js";

interface DbAssertion {
  id: string;
  tenant_id: string;
  investigation_id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  predicate: string;
  object_type: string;
  object_id: string | null;
  object_literal: unknown;
  valid_from: unknown;
  valid_to: unknown;
  asserter_type: string;
  asserter_id: string;
  epistemic_state: string;
  confidence: string | number;
  confidence_basis: unknown;
  plane: string;
  evidence_ids: string[];
  derivation: unknown;
  review_state: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_rationale: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  discovery_channel: string | null;
  inference_pattern: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  deleted_at: Date | null;
}

function parseJsonField<T = Record<string, unknown>>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  let parsed = val;
  while (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return (typeof parsed === "object" && parsed !== null ? parsed : fallback) as T;
}

function normalizeAssertion(row: DbAssertion) {
  return AssertionSchema.parse({
    ...row,
    confidence: Number(row.confidence),
    object_literal: row.object_literal ? parseJsonField(row.object_literal, null) : null,
    valid_from: row.valid_from ? parseJsonField(row.valid_from, null) : null,
    valid_to: row.valid_to ? parseJsonField(row.valid_to, null) : null,
    confidence_basis: parseJsonField(row.confidence_basis, {}),
    derivation: parseJsonField(row.derivation, {}),
  });
}

function normalizeDivergenceNotice(row: Record<string, unknown>) {
  return DivergenceNoticeSchema.parse({
    ...row,
    details: parseJsonField(row.details, {}),
  });
}

function normalizeContradictionAlert(row: Record<string, unknown>) {
  return ContradictionAlertSchema.parse({
    ...row,
    details: parseJsonField(row.details, {}),
  });
}

export const assertionRoutes: FastifyPluginAsync = async (fastify) => {
  // ── PRD §6.6 / §56.4: POST /v1/investigations/:id/assertions (Write Path) ──
  fastify.post(
    "/v1/investigations/:id/assertions",
    { config: { permission: "assertion.create" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = CreateAssertionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const input = parsed.data;

      // 1. Verify Investigation exists
      const invRows = await req.tx!<{ id: string; workspace_id: string }[]>`
        SELECT id, workspace_id
        FROM investigations
        WHERE id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;
      if (invRows.length === 0 || !invRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Investigation Not Found",
          status: 404,
          detail: `Investigation ${investigationId} was not found.`,
          request_id: req.id,
        });
      }
      const inv = invRows[0];

      // 2. INVARIANT I2 (AC-EPI-01): Epistemic Authority check (Must run before Grounding)
      const isMachineAsserter = input.asserter.type === "model" || input.asserter.type === "deterministic";
      const isHumanOnlyState = input.epistemic_state === "Verified" || input.epistemic_state === "Refuted";
      if (isMachineAsserter && isHumanOnlyState) {
        // Emit PolicyViolationAttempted security event
        await writeAuditEvent(req.tx!, {
          tenantId: req.user!.tenantId,
          workspaceId: inv.workspace_id,
          investigationId,
          actorType: input.asserter.type === "model" ? "ai" : "system",
          actorId: input.asserter.id || req.user!.userId,
          actorDisplay: `Asserter (${input.asserter.type})`,
          action: "policy.violation_attempted",
          objectType: "assertion",
          objectId: randomUUID(),
          objectDisplay: `${input.subject_type} ${input.predicate}`,
          before: null,
          after: {
            reason: "epistemic_authority_violation",
            attempted_state: input.epistemic_state,
            asserter_type: input.asserter.type,
            input,
          },
          outcome: "denied",
          denialReason: "A model or deterministic asserter can never write Verified or Refuted (Invariant I2 / AC-EPI-01)",
          requestId: req.id,
        });

        return reply.status(422).send({
          type: "https://docs.casefile.com/errors/epistemic-authority-violation",
          title: "Epistemic Authority Violation",
          status: 422,
          detail: "A model or deterministic asserter can never write Verified or Refuted (Invariant I2 / AC-EPI-01).",
          request_id: req.id,
        });
      }

      // 3. INVARIANT I1 (AC-EPI-02): Grounding check for machine asserters
      if (isMachineAsserter && (!input.evidence_ids || input.evidence_ids.length === 0)) {
        return reply.status(422).send({
          type: "https://docs.casefile.com/errors/grounding-required",
          title: "Grounding Required",
          status: 422,
          detail: "Machine asserters (model, deterministic) must supply at least one resolvable evidence locator (Invariant I1).",
          request_id: req.id,
        });
      }

      // Check evidence locator resolution if investigation has registered evidence
      if (input.evidence_ids && input.evidence_ids.length > 0) {
        const totalEvidenceInInv = await req.tx!<{ count: string }[]>`
          SELECT COUNT(*)::text AS count
          FROM evidence
          WHERE investigation_id = ${investigationId}
            AND tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL;
        `;
        const hasEvidence = Number(totalEvidenceInInv[0]?.count || 0) > 0;

        if (hasEvidence) {
          const evRows = await req.tx!<{ id: string; span_hash: string; locator: unknown; content_block_id: string | null; block_text: string | null }[]>`
            SELECT e.id, e.span_hash, e.locator, e.content_block_id, b.text AS block_text
            FROM evidence e
            LEFT JOIN content_blocks b ON b.id = e.content_block_id
            WHERE e.id = ANY(${input.evidence_ids})
              AND e.investigation_id = ${investigationId}
              AND e.tenant_id = ${req.user!.tenantId}
              AND e.deleted_at IS NULL;
          `;

          if (evRows.length !== input.evidence_ids.length) {
            return reply.status(422).send({
              type: "https://docs.casefile.com/errors/grounding-required",
              title: "Unresolvable Evidence Locator",
              status: 422,
              detail: "One or more cited evidence IDs do not resolve to valid evidence in this investigation (Invariant I1).",
              request_id: req.id,
            });
          }

          // Verify that span hash still matches underlying content block
          for (const ev of evRows) {
            if (ev.block_text) {
              const rawLoc = typeof ev.locator === "string" ? JSON.parse(ev.locator) : ev.locator;
              const currentText = ev.block_text.slice(rawLoc.char_start, rawLoc.char_end);
              const currentHash = createHash("sha256").update(currentText.trim().replace(/\s+/g, " "), "utf8").digest("hex");
              if (currentHash !== ev.span_hash) {
                return reply.status(422).send({
                  type: "https://docs.casefile.com/errors/grounding-required",
                  title: "Evidence Span Corrupted",
                  status: 422,
                  detail: `Evidence ${ev.id} span text no longer hashes to its registered span_hash (Invariant I1).`,
                  request_id: req.id,
                });
              }
            }
          }
        }
      }

      // 4. INVARIANT I3 (AC-EPI-03): Two-Plane Separation & Divergence Handling
      // Find if a verified record-plane assertion already exists on this subject + predicate
      const existingVerified = await req.tx!<DbAssertion[]>`
        SELECT *
        FROM assertions
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND subject_id = ${input.subject_id}
          AND predicate = ${input.predicate}
          AND (plane = 'record' OR epistemic_state = 'Verified')
          AND deleted_at IS NULL;
      `;

      const assertionId = randomUUID();
      const asserterId = input.asserter.id || req.user!.userId;
      const plane = isHumanOnlyState ? "record" : "machine";
      const confidence = input.confidence !== undefined ? input.confidence : (isMachineAsserter ? 0.85 : 1.0);
      const derivation = input.derivation || { parents: [], transform: "assertion_extractor", transform_version: "1.0.0", executed_at: new Date().toISOString() };

      const rows = await req.tx!<DbAssertion[]>`
        INSERT INTO assertions (
          id, tenant_id, investigation_id, kind, subject_type, subject_id,
          predicate, object_type, object_id, object_literal, valid_from,
          valid_to, asserter_type, asserter_id, epistemic_state,
          confidence, plane, evidence_ids, derivation, review_state,
          reviewed_by, reviewed_at, created_by
        )
        VALUES (
          ${assertionId}, ${req.user!.tenantId}, ${investigationId}, ${input.kind},
          ${input.subject_type}, ${input.subject_id}, ${input.predicate},
          ${input.object_type}, ${input.object_id || null},
          ${input.object_literal ? JSON.stringify(input.object_literal) : null}::jsonb,
          ${input.valid_from ? JSON.stringify(input.valid_from) : null}::jsonb,
          ${input.valid_to ? JSON.stringify(input.valid_to) : null}::jsonb,
          ${input.asserter.type}, ${asserterId}, ${input.epistemic_state},
          ${confidence}, ${plane}, ${input.evidence_ids},
          ${JSON.stringify(derivation)}::jsonb, ${isHumanOnlyState ? "accepted" : "unreviewed"},
          ${isHumanOnlyState ? req.user!.userId : null}, ${isHumanOnlyState ? new Date() : null},
          ${req.user!.userId}
        )
        RETURNING *;
      `;

      // Insert junction evidence links
      if (input.evidence_ids.length > 0) {
        for (const evId of input.evidence_ids) {
          await req.tx!`
            INSERT INTO assertion_evidence (assertion_id, evidence_id, role, tenant_id)
            VALUES (${assertionId}, ${evId}, 'supports', ${req.user!.tenantId})
            ON CONFLICT (assertion_id, evidence_id, role) DO NOTHING;
          `;
        }
      }

      // Check if recomputation divergence occurred (AC-EPI-03)
      let divergenceNotice: Record<string, unknown> | null = null;
      if (isMachineAsserter && existingVerified.length > 0 && existingVerified[0]) {
        const rec = existingVerified[0];
        const isConflict =
          (input.object_id && rec.object_id && input.object_id !== rec.object_id) ||
          (input.object_literal && JSON.stringify(input.object_literal) !== JSON.stringify(rec.object_literal));

        if (isConflict) {
          const divId = randomUUID();
          const divRows = await req.tx!<Record<string, unknown>[]>`
            INSERT INTO divergence_notices (
              id, tenant_id, investigation_id, record_assertion_id,
              machine_assertion_id, divergence_type, details
            )
            VALUES (
              ${divId}, ${req.user!.tenantId}, ${investigationId}, ${rec.id},
              ${assertionId}, 'recomputation_conflict',
              ${JSON.stringify({
                message: "New machine extractor produced conflicting value against human-verified record assertion.",
                verified_assertion: rec,
                new_machine_assertion: rows[0],
              })}::jsonb
            )
            RETURNING *;
          `;
          divergenceNotice = divRows[0] || null;

          // PRD §6.5 / AC-EPI-04: Contradiction against verified alert
          const alertId = randomUUID();
          await req.tx!`
            INSERT INTO contradiction_alerts (
              id, tenant_id, investigation_id, verified_assertion_id,
              conflicting_assertion_id, severity, details
            )
            VALUES (
              ${alertId}, ${req.user!.tenantId}, ${investigationId}, ${rec.id},
              ${assertionId}, 'critical',
              ${JSON.stringify({
                message: "Contradiction detected against Verified assertion.",
              })}::jsonb
            );
          `;
        }
      }

      // Audit assertion creation
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: inv.workspace_id,
        investigationId,
        actorType: input.asserter.type === "human" ? "user" : "system",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "assertion.create",
        objectType: "assertion",
        objectId: assertionId,
        objectDisplay: `${input.subject_type} ${input.predicate}`,
        after: {
          kind: input.kind,
          epistemic_state: input.epistemic_state,
          plane,
          asserter_type: input.asserter.type,
        },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(201);
      return {
        ...normalizeAssertion(rows[0]!),
        divergence_notice: divergenceNotice ? normalizeDivergenceNotice(divergenceNotice) : null,
      };
    },
  );

  // ── PRD §6.5 / §56.4: POST /v1/investigations/:id/assertions/:assertionId/validate ─
  fastify.post(
    "/v1/investigations/:id/assertions/:assertionId/validate",
    { config: { permission: "assertion.validate" } },
    async (req, reply) => {
      const { id: investigationId, assertionId } = req.params as { id: string; assertionId: string };
      const parsed = ValidateAssertionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbAssertion[]>`
        UPDATE assertions
        SET
          asserter_type = 'human',
          asserter_id = ${req.user!.userId},
          epistemic_state = ${parsed.data.epistemic_state},
          plane = 'record',
          review_state = ${parsed.data.epistemic_state === "Verified" ? "accepted" : "rejected"},
          reviewed_by = ${req.user!.userId},
          reviewed_at = NOW(),
          review_rationale = ${parsed.data.rationale},
          confidence = 1.0000,
          updated_at = NOW()
        WHERE id = ${assertionId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Assertion Not Found",
          status: 404,
          detail: `Assertion ${assertionId} was not found.`,
          request_id: req.id,
        });
      }

      const invRows = await req.tx!<{ workspace_id: string }[]>`
        SELECT workspace_id FROM investigations WHERE id = ${investigationId} AND tenant_id = ${req.user!.tenantId};
      `;
      const wsId = invRows[0]?.workspace_id || investigationId;

      // Audit validation
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: wsId,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: parsed.data.epistemic_state === "Verified" ? "assertion.validate" : "assertion.refute",
        objectType: "assertion",
        objectId: assertionId,
        objectDisplay: `${rows[0].subject_type} ${rows[0].predicate}`,
        after: {
          epistemic_state: parsed.data.epistemic_state,
          rationale: parsed.data.rationale,
          plane: "record",
        },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(200);
      return normalizeAssertion(rows[0]);
    },
  );

  // ── POST /v1/investigations/:id/assertions/:assertionId/supersede ────────
  fastify.post(
    "/v1/investigations/:id/assertions/:assertionId/supersede",
    { config: { permission: "assertion.create" } },
    async (req, reply) => {
      const { id: investigationId, assertionId } = req.params as { id: string; assertionId: string };
      const parsed = CreateAssertionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const input = parsed.data;

      // 1. Verify existing assertion exists
      const oldRows = await req.tx!<DbAssertion[]>`
        SELECT *
        FROM assertions
        WHERE id = ${assertionId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;
      if (oldRows.length === 0 || !oldRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Assertion Not Found",
          status: 404,
          detail: `Assertion ${assertionId} was not found.`,
          request_id: req.id,
        });
      }
      const oldAssertion = oldRows[0];

      const invRows = await req.tx!<{ workspace_id: string }[]>`
        SELECT workspace_id FROM investigations WHERE id = ${investigationId} AND tenant_id = ${req.user!.tenantId};
      `;
      const wsId = invRows[0]?.workspace_id || investigationId;

      // 2. Create new replacing assertion
      const newId = randomUUID();
      const asserterId = input.asserter.id || req.user!.userId;
      const isMachineAsserter = input.asserter.type === "model" || input.asserter.type === "deterministic";
      const isHumanOnlyState = input.epistemic_state === "Verified" || input.epistemic_state === "Refuted";
      const plane = isHumanOnlyState ? "record" : "machine";
      const confidence = input.confidence !== undefined ? input.confidence : (isMachineAsserter ? 0.85 : 1.0);
      const derivation = input.derivation || { parents: [oldAssertion.id], transform: "assertion_supersession", transform_version: "1.0.0", executed_at: new Date().toISOString() };

      const newRows = await req.tx!<DbAssertion[]>`
        INSERT INTO assertions (
          id, tenant_id, investigation_id, kind, subject_type, subject_id,
          predicate, object_type, object_id, object_literal, valid_from,
          valid_to, asserter_type, asserter_id, epistemic_state,
          confidence, plane, evidence_ids, derivation, created_by, supersedes
        )
        VALUES (
          ${newId}, ${req.user!.tenantId}, ${investigationId}, ${input.kind},
          ${input.subject_type}, ${input.subject_id}, ${input.predicate},
          ${input.object_type}, ${input.object_id || null},
          ${input.object_literal ? JSON.stringify(input.object_literal) : null}::jsonb,
          ${input.valid_from ? JSON.stringify(input.valid_from) : null}::jsonb,
          ${input.valid_to ? JSON.stringify(input.valid_to) : null}::jsonb,
          ${input.asserter.type}, ${asserterId}, ${input.epistemic_state},
          ${confidence}, ${plane}, ${input.evidence_ids},
          ${JSON.stringify(derivation)}::jsonb, ${req.user!.userId}, ${assertionId}
        )
        RETURNING *;
      `;

      // 3. Mark old assertion as superseded
      await req.tx!`
        UPDATE assertions
        SET
          review_state = 'superseded',
          superseded_by = ${newId},
          updated_at = NOW()
        WHERE id = ${assertionId};
      `;

      // Audit supersession
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: wsId,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "assertion.supersede",
        objectType: "assertion",
        objectId: newId,
        objectDisplay: `${input.subject_type} ${input.predicate}`,
        before: { supersedes: assertionId },
        after: { new_assertion_id: newId },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(201);
      return normalizeAssertion(newRows[0]!);
    },
  );

  // ── GET /v1/investigations/:id/assertions ────────────────────────────────
  fastify.get(
    "/v1/investigations/:id/assertions",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const query = PaginationQuerySchema.parse(req.query);
      const cursor = decodeCursor(query.cursor);

      let rows: (DbAssertion & { created_at_raw?: string })[];
      if (cursor) {
        rows = await req.tx!<(DbAssertion & { created_at_raw?: string })[]>`
          SELECT *, created_at::text AS created_at_raw
          FROM assertions
          WHERE investigation_id = ${investigationId}
            AND tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL
            AND (
              created_at < ${cursor.createdAt}::timestamptz
              OR (created_at = ${cursor.createdAt}::timestamptz AND id < ${cursor.id}::uuid)
            )
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      } else {
        rows = await req.tx!<(DbAssertion & { created_at_raw?: string })[]>`
          SELECT *, created_at::text AS created_at_raw
          FROM assertions
          WHERE investigation_id = ${investigationId}
            AND tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      }

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeCursor({
              id: String(lastItem.id),
              createdAt: lastItem.created_at_raw || new Date(String(lastItem.created_at)).toISOString(),
            })
          : null;

      reply.status(200);
      return {
        items: items.map((r) => normalizeAssertion(r)),
        nextCursor,
      };
    },
  );

  // ── GET /v1/investigations/:id/assertions/:assertionId ───────────────────
  fastify.get(
    "/v1/investigations/:id/assertions/:assertionId",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, assertionId } = req.params as { id: string; assertionId: string };
      const rows = await req.tx!<DbAssertion[]>`
        SELECT *
        FROM assertions
        WHERE id = ${assertionId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Assertion Not Found",
          status: 404,
          detail: `Assertion ${assertionId} was not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return normalizeAssertion(rows[0]);
    },
  );

  // ── GET /v1/investigations/:id/assertions/divergences ────────────────────
  fastify.get(
    "/v1/investigations/:id/assertions/divergences",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM divergence_notices
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => normalizeDivergenceNotice(r)),
      };
    },
  );

  // ── GET /v1/investigations/:id/assertions/contradiction-alerts ───────────
  fastify.get(
    "/v1/investigations/:id/assertions/contradiction-alerts",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM contradiction_alerts
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => normalizeContradictionAlert(r)),
      };
    },
  );
};
