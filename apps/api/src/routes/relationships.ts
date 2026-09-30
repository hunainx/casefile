import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  CreateRelationshipRequestSchema,
  VerifyRelationshipRequestSchema,
  RefuteRelationshipRequestSchema,
  RelationshipSchema,
  PaginationQuerySchema,
} from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import { encodeCursor, decodeCursor } from "../pagination.js";

interface DbRelationship {
  id: string;
  tenant_id: string;
  investigation_id: string;
  source_entity_id: string;
  target_entity_id: string;
  type: string;
  direction: string;
  valid_from: unknown;
  valid_to: unknown;
  current_status: string;
  attributes: unknown;
  discovery_channel: string;
  inference_pattern: string | null;
  evidence_ids: string[];
  epistemic_state: string;
  confidence: string | number;
  verified_by: string | null;
  verified_at: Date | null;
  review_rationale: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  deleted_at: Date | null;
  created_at_raw?: string;
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

function normalizeRelationship(row: DbRelationship) {
  return RelationshipSchema.parse({
    ...row,
    confidence: Number(row.confidence),
    valid_from: row.valid_from ? parseJsonField(row.valid_from, null) : null,
    valid_to: row.valid_to ? parseJsonField(row.valid_to, null) : null,
    attributes: parseJsonField(row.attributes, {}),
  });
}

export const relationshipRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /v1/investigations/:id/relationships (Create Relationship) ───────
  fastify.post(
    "/v1/investigations/:id/relationships",
    { config: { permission: "entity.create" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = CreateRelationshipRequestSchema.safeParse(req.body);
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
        SELECT id, workspace_id FROM investigations
        WHERE id = ${investigationId} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
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

      // 2. Verify source and target entities exist
      const [srcRows, tgtRows] = await Promise.all([
        req.tx!<DbRelationship[]>`
          SELECT id FROM entities WHERE id = ${input.source_entity_id} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
        `,
        req.tx!<DbRelationship[]>`
          SELECT id FROM entities WHERE id = ${input.target_entity_id} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
        `,
      ]);

      if (srcRows.length === 0 || tgtRows.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: "Source or target entity was not found.",
          request_id: req.id,
        });
      }

      const relId = randomUUID();
      const rows = await req.tx!<DbRelationship[]>`
        INSERT INTO relationships (
          id, tenant_id, investigation_id, source_entity_id, target_entity_id,
          type, direction, valid_from, valid_to, current_status,
          attributes, discovery_channel, inference_pattern, evidence_ids,
          epistemic_state, confidence, created_by
        )
        VALUES (
          ${relId}, ${req.user!.tenantId}, ${investigationId}, ${input.source_entity_id},
          ${input.target_entity_id}, ${input.type}, ${input.direction},
          ${input.valid_from ? JSON.stringify(input.valid_from) : null}::jsonb,
          ${input.valid_to ? JSON.stringify(input.valid_to) : null}::jsonb,
          ${input.current_status}, ${JSON.stringify(input.attributes)}::jsonb,
          ${input.discovery_channel}, ${input.inference_pattern || null},
          ${input.evidence_ids}, ${input.epistemic_state}, ${input.confidence},
          ${req.user!.userId}
        )
        RETURNING *;
      `;

      // Audit relationship creation
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: inv.workspace_id,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "relationship.create",
        objectType: "relationship",
        objectId: relId,
        objectDisplay: `${input.type} (${input.source_entity_id} -> ${input.target_entity_id})`,
        after: {
          type: input.type,
          direction: input.direction,
          discovery_channel: input.discovery_channel,
        },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(201);
      return normalizeRelationship(rows[0]!);
    },
  );

  // ── GET /v1/investigations/:id/relationships ─────────────────────────────
  fastify.get(
    "/v1/investigations/:id/relationships",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const query = PaginationQuerySchema.parse(req.query);
      const urlObj = new URL(req.url, "http://localhost");
      const typeFilter = urlObj.searchParams.get("type");
      const entityFilter = urlObj.searchParams.get("entity_id");

      const cursor = decodeCursor(query.cursor);

      let rows: (DbRelationship & { created_at_raw?: string })[];
      if (cursor) {
        rows = await req.tx!<(DbRelationship & { created_at_raw?: string })[]>`
          SELECT r.*, r.created_at::text AS created_at_raw
          FROM relationships r
          WHERE r.investigation_id = ${investigationId}
            AND r.tenant_id = ${req.user!.tenantId}
            AND r.deleted_at IS NULL
            ${typeFilter ? req.tx!`AND r.type = ${typeFilter}` : req.tx!``}
            ${entityFilter ? req.tx!`AND (r.source_entity_id = ${entityFilter} OR r.target_entity_id = ${entityFilter})` : req.tx!``}
            AND (
              r.created_at < ${cursor.createdAt}::timestamptz
              OR (r.created_at = ${cursor.createdAt}::timestamptz AND r.id < ${cursor.id}::uuid)
            )
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${query.limit + 1};
        `;
      } else {
        rows = await req.tx!<(DbRelationship & { created_at_raw?: string })[]>`
          SELECT r.*, r.created_at::text AS created_at_raw
          FROM relationships r
          WHERE r.investigation_id = ${investigationId}
            AND r.tenant_id = ${req.user!.tenantId}
            AND r.deleted_at IS NULL
            ${typeFilter ? req.tx!`AND r.type = ${typeFilter}` : req.tx!``}
            ${entityFilter ? req.tx!`AND (r.source_entity_id = ${entityFilter} OR r.target_entity_id = ${entityFilter})` : req.tx!``}
          ORDER BY r.created_at DESC, r.id DESC
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
        items: items.map((r) => normalizeRelationship(r)),
        nextCursor,
      };
    },
  );

  // ── GET /v1/investigations/:id/entities/:entityId/relationships ──────────
  fastify.get(
    "/v1/investigations/:id/entities/:entityId/relationships",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, entityId } = req.params as { id: string; entityId: string };

      const rows = await req.tx!<DbRelationship[]>`
        SELECT *
        FROM relationships
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND (source_entity_id = ${entityId} OR target_entity_id = ${entityId})
          AND deleted_at IS NULL
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => normalizeRelationship(r)),
      };
    },
  );

  // ── Direct GET /v1/entities/:id/relationships (Alias route) ──────────────
  fastify.get(
    "/v1/entities/:id/relationships",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: entityId } = req.params as { id: string };

      const rows = await req.tx!<DbRelationship[]>`
        SELECT *
        FROM relationships
        WHERE tenant_id = ${req.user!.tenantId}
          AND (source_entity_id = ${entityId} OR target_entity_id = ${entityId})
          AND deleted_at IS NULL
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => normalizeRelationship(r)),
      };
    },
  );

  // ── POST /v1/investigations/:id/relationships/:relId/verify (REL-05) ─────
  fastify.post(
    "/v1/investigations/:id/relationships/:relId/verify",
    { config: { permission: "assertion.validate" } },
    async (req, reply) => {
      const { id: investigationId, relId } = req.params as { id: string; relId: string };
      const parsed = VerifyRelationshipRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbRelationship[]>`
        UPDATE relationships
        SET
          epistemic_state = 'Verified',
          confidence = 1.0000,
          verified_by = ${req.user!.userId},
          verified_at = NOW(),
          review_rationale = ${parsed.data.rationale},
          updated_at = NOW()
        WHERE id = ${relId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Relationship Not Found",
          status: 404,
          detail: `Relationship ${relId} was not found.`,
          request_id: req.id,
        });
      }

      const invRows = await req.tx!<{ workspace_id: string }[]>`
        SELECT workspace_id FROM investigations WHERE id = ${investigationId} AND tenant_id = ${req.user!.tenantId};
      `;
      const wsId = invRows[0]?.workspace_id || investigationId;

      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: wsId,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "relationship.verify",
        objectType: "relationship",
        objectId: relId,
        objectDisplay: `${rows[0].type} (${rows[0].source_entity_id} -> ${rows[0].target_entity_id})`,
        after: { epistemic_state: "Verified", verified_by: req.user!.userId, rationale: parsed.data.rationale },
        rationale: parsed.data.rationale,
        outcome: "success",
        requestId: req.id,
      });

      reply.status(200);
      return normalizeRelationship(rows[0]);
    },
  );

  // ── Direct POST /v1/relationships/:id/verify (Alias route) ───────────────
  fastify.post(
    "/v1/relationships/:id/verify",
    { config: { permission: "assertion.validate" } },
    async (req, reply) => {
      const { id: relId } = req.params as { id: string };
      const parsed = VerifyRelationshipRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbRelationship[]>`
        UPDATE relationships
        SET
          epistemic_state = 'Verified',
          confidence = 1.0000,
          verified_by = ${req.user!.userId},
          verified_at = NOW(),
          review_rationale = ${parsed.data.rationale},
          updated_at = NOW()
        WHERE id = ${relId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Relationship Not Found",
          status: 404,
          detail: `Relationship ${relId} was not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return normalizeRelationship(rows[0]);
    },
  );

  // ── POST /v1/investigations/:id/relationships/:relId/refute (REL-06) ─────
  fastify.post(
    "/v1/investigations/:id/relationships/:relId/refute",
    { config: { permission: "assertion.validate" } },
    async (req, reply) => {
      const { id: investigationId, relId } = req.params as { id: string; relId: string };
      const parsed = RefuteRelationshipRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbRelationship[]>`
        UPDATE relationships
        SET
          epistemic_state = 'Refuted',
          confidence = 1.0000,
          verified_by = ${req.user!.userId},
          verified_at = NOW(),
          review_rationale = ${parsed.data.rationale},
          updated_at = NOW()
        WHERE id = ${relId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Relationship Not Found",
          status: 404,
          detail: `Relationship ${relId} was not found.`,
          request_id: req.id,
        });
      }

      const invRows = await req.tx!<{ workspace_id: string }[]>`
        SELECT workspace_id FROM investigations WHERE id = ${investigationId} AND tenant_id = ${req.user!.tenantId};
      `;
      const wsId = invRows[0]?.workspace_id || investigationId;

      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: wsId,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "relationship.refute",
        objectType: "relationship",
        objectId: relId,
        objectDisplay: `${rows[0].type} (${rows[0].source_entity_id} -> ${rows[0].target_entity_id})`,
        after: { epistemic_state: "Refuted", verified_by: req.user!.userId, rationale: parsed.data.rationale },
        rationale: parsed.data.rationale,
        outcome: "success",
        requestId: req.id,
      });

      reply.status(200);
      return normalizeRelationship(rows[0]);
    },
  );

  // ── Direct POST /v1/relationships/:id/refute (Alias route) ───────────────
  fastify.post(
    "/v1/relationships/:id/refute",
    { config: { permission: "assertion.validate" } },
    async (req, reply) => {
      const { id: relId } = req.params as { id: string };
      const parsed = RefuteRelationshipRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbRelationship[]>`
        UPDATE relationships
        SET
          epistemic_state = 'Refuted',
          confidence = 1.0000,
          verified_by = ${req.user!.userId},
          verified_at = NOW(),
          review_rationale = ${parsed.data.rationale},
          updated_at = NOW()
        WHERE id = ${relId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Relationship Not Found",
          status: 404,
          detail: `Relationship ${relId} was not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return normalizeRelationship(rows[0]);
    },
  );

  // ── POST /v1/investigations/:id/relationships/bulk-verify (REL-07) ───────
  fastify.post(
    "/v1/investigations/:id/relationships/bulk-verify",
    { config: { permission: "assertion.validate" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const body = req.body as { type: string; evidence_id: string; rationale: string };

      if (!body.type || !body.evidence_id || !body.rationale) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: "type, evidence_id, and rationale are required for bulk-verify.",
          request_id: req.id,
        });
      }

      const updated = await req.tx!<DbRelationship[]>`
        UPDATE relationships
        SET
          epistemic_state = 'Verified',
          confidence = 1.0000,
          verified_by = ${req.user!.userId},
          verified_at = NOW(),
          review_rationale = ${body.rationale},
          updated_at = NOW()
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND type = ${body.type}
          AND ${body.evidence_id}::uuid = ANY(evidence_ids)
          AND epistemic_state != 'Verified'
        RETURNING *;
      `;

      reply.status(200);
      return {
        investigation_id: investigationId,
        verified_count: updated.length,
        relationships: updated.map((r) => normalizeRelationship(r)),
      };
    },
  );
};
