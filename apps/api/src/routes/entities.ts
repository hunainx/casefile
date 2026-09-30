import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import "../types.js";
import {
  CreateEntityRequestSchema,
  UpdateEntityRequestSchema,
  CreateEntityAliasRequestSchema,
  CreateEntityIdentifierRequestSchema,
  MergeEntitiesRequestSchema,
  UnmergeEntitiesRequestSchema,
  RunExtractionRequestSchema,
  EntitySchema,
  EntityAliasSchema,
  EntityIdentifierSchema,
  EntityMentionSchema,
  MergeCandidateSchema,
  PaginationQuerySchema,
  type Entity,
  type EntityIdentifier,
  type Relationship,
  type MergeEntitiesRequest,
} from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import { encodeCursor, decodeCursor } from "../pagination.js";
import { evaluateEntityPair } from "../services/entity-resolution.js";
import { verifyExtractionQuotes } from "../services/extraction.js";
import { documentText } from "../services/document-text.js";

interface DbEntity {
  id: string;
  tenant_id: string;
  investigation_id: string;
  scope: string;
  type: string;
  subtype: string | null;
  canonical_name: string;
  sensitivity: string;
  subject_role: string | null;
  is_focal: boolean;
  confidence: string | number;
  epistemic_state: string;
  status: string;
  merged_into_id: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  deleted_at: Date | null;
  mention_count?: string | number;
  source_count?: string | number;
  first_seen?: Date | string | null;
  last_seen?: Date | string | null;
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

function normalizeEntity(
  row: DbEntity,
  aliases: Record<string, unknown>[] = [],
  identifiers: Record<string, unknown>[] = [],
) {
  const parsedRow = parseJsonField(row, row);
  return EntitySchema.parse({
    ...parsedRow,
    confidence: Number(parsedRow.confidence || 0.85),
    mention_count: parsedRow.mention_count ? Number(parsedRow.mention_count) : 0,
    source_count: parsedRow.source_count ? Number(parsedRow.source_count) : 0,
    first_seen: parsedRow.first_seen || null,
    last_seen: parsedRow.last_seen || null,
    aliases: aliases.map((a) => {
      const pa = parseJsonField(a, a);
      return EntityAliasSchema.parse({
        ...pa,
        confidence: Number(pa.confidence || 0.85),
        valid_from: pa.valid_from ? parseJsonField(pa.valid_from, null) : null,
        valid_to: pa.valid_to ? parseJsonField(pa.valid_to, null) : null,
      });
    }),
    identifiers: identifiers.map((i) => {
      const pi = parseJsonField(i, i);
      return EntityIdentifierSchema.parse(pi);
    }),
  });
}

async function executeMerge(
  req: FastifyRequest,
  reply: FastifyReply,
  investigationId: string,
  input: MergeEntitiesRequest,
) {
  // 1. Fetch both entities
  const [srcRows, tgtRows] = await Promise.all([
    req.tx!<DbEntity[]>`
      SELECT * FROM entities
      WHERE id = ${input.source_entity_id}
        AND investigation_id = ${investigationId}
        AND tenant_id = ${req.user!.tenantId}
        AND deleted_at IS NULL;
    `,
    req.tx!<DbEntity[]>`
      SELECT * FROM entities
      WHERE id = ${input.target_entity_id}
        AND investigation_id = ${investigationId}
        AND tenant_id = ${req.user!.tenantId}
        AND deleted_at IS NULL;
    `,
  ]);

  if (srcRows.length === 0 || !srcRows[0] || tgtRows.length === 0 || !tgtRows[0]) {
    return reply.status(404).send({
      type: "https://docs.casefile.com/errors/not-found",
      title: "Entity Not Found",
      status: 404,
      detail: "One or both entities to merge were not found.",
      request_id: req.id,
    });
  }

  const srcEntity = srcRows[0];
  const tgtEntity = tgtRows[0];

  // 2. Fetch identifiers for both entities to check conflicts (PRD §15.4 / AC-RES-02)
  const [srcIds, tgtIds] = await Promise.all([
    req.tx!<Record<string, unknown>[]>`
      SELECT * FROM entity_identifiers WHERE entity_id = ${input.source_entity_id} AND tenant_id = ${req.user!.tenantId};
    `,
    req.tx!<Record<string, unknown>[]>`
      SELECT * FROM entity_identifiers WHERE entity_id = ${input.target_entity_id} AND tenant_id = ${req.user!.tenantId};
    `,
  ]);

  const parsedSrcIds = srcIds.map((i) => EntityIdentifierSchema.parse(i));
  const parsedTgtIds = tgtIds.map((i) => EntityIdentifierSchema.parse(i));

  let hasConflictingIdentifiers = false;
  let conflictDetail = "";
  for (const idA of parsedSrcIds) {
    for (const idB of parsedTgtIds) {
      if (idA.scheme === idB.scheme) {
        const jurA = (idA.jurisdiction || "").trim().toLowerCase();
        const jurB = (idB.jurisdiction || "").trim().toLowerCase();
        const sameJur = !jurA || !jurB || jurA === jurB;
        if (idA.value.trim().toLowerCase() !== idB.value.trim().toLowerCase() && sameJur) {
          hasConflictingIdentifiers = true;
          conflictDetail = `Conflicting ${idA.scheme} identifiers in same jurisdiction (${idA.jurisdiction || "global"}): '${idA.value}' vs '${idB.value}'.`;
          break;
        }
      }
    }
  }

  // AC-RES-02: Conflicting identifiers block merge unless force_override is true
  if (hasConflictingIdentifiers && !input.force_override) {
    return reply.status(422).send({
      type: "https://docs.casefile.com/errors/conflicting-identifiers-blocked",
      title: "Merge Blocked by Conflicting Identifiers",
      status: 422,
      detail: `${conflictDetail} Merge is blocked and can only proceed with an explicit override plus rationale (AC-RES-02).`,
      request_id: req.id,
    });
  }

  // 3. Check for conflicting attributes to raise ContradictionAlert (PRD §15.6 / AC-RES-03)
  const [srcAssertions, tgtAssertions] = await Promise.all([
    req.tx!<Record<string, unknown>[]>`
      SELECT * FROM assertions WHERE subject_id = ${input.source_entity_id} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
    `,
    req.tx!<Record<string, unknown>[]>`
      SELECT * FROM assertions WHERE subject_id = ${input.target_entity_id} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
    `,
  ]);

  const contradictionsRaised: string[] = [];
  for (const sa of srcAssertions) {
    for (const ta of tgtAssertions) {
      if (sa.predicate === ta.predicate) {
        const valS = JSON.stringify(sa.object_literal || sa.object_id);
        const valT = JSON.stringify(ta.object_literal || ta.object_id);
        if (valS !== valT) {
          const alertId = randomUUID();
          await req.tx!`
            INSERT INTO contradiction_alerts (
              id, tenant_id, investigation_id, verified_assertion_id,
              conflicting_assertion_id, severity, details
            )
            VALUES (
              ${alertId}, ${req.user!.tenantId}, ${investigationId},
              ${String(ta.id)}::uuid, ${String(sa.id)}::uuid, 'high',
              ${JSON.stringify({
                message: `Attribute conflict on predicate '${sa.predicate}' merged from entity '${srcEntity.canonical_name}' into '${tgtEntity.canonical_name}' (AC-RES-03).`,
                source_value: sa.object_literal || sa.object_id,
                target_value: ta.object_literal || ta.object_id,
              })}::jsonb
            );
          `;
          contradictionsRaised.push(String(sa.predicate));
        }
      }
    }
  }

  // 4. Mark Source Entity as merged_away
  await req.tx!`
    UPDATE entities
    SET status = 'merged_away', merged_into_id = ${input.target_entity_id}, updated_at = NOW()
    WHERE id = ${input.source_entity_id};
  `;

  // 5. Repoint mentions to survivor
  await req.tx!`
    UPDATE entity_mentions
    SET entity_id = ${input.target_entity_id}
    WHERE entity_id = ${input.source_entity_id};
  `;

  // 6. Record Merge History for exact unmerge (AC-RES-04)
  const mergeHistoryId = randomUUID();
  await req.tx!`
    INSERT INTO entity_merge_history (
      id, tenant_id, investigation_id, surviving_entity_id,
      merged_entity_id, pre_merge_state_survivor, pre_merge_state_merged,
      match_score, signals, rationale, forced_override, merged_by
    )
    VALUES (
      ${mergeHistoryId}, ${req.user!.tenantId}, ${investigationId},
      ${input.target_entity_id}, ${input.source_entity_id},
      ${JSON.stringify(tgtEntity)}::jsonb, ${JSON.stringify(srcEntity)}::jsonb,
      1.0000, ${JSON.stringify([{ signal: "human_merge_decision", value: input.rationale, weight: 1.0, contribution: 1.0 }])}::jsonb,
      ${input.rationale}, ${input.force_override}, ${req.user!.userId}
    );
  `;

  // 7. Update candidate status if present
  await req.tx!`
    UPDATE entity_merge_candidates
    SET status = 'approved', updated_at = NOW()
    WHERE ((entity_a_id = ${input.source_entity_id} AND entity_b_id = ${input.target_entity_id})
       OR (entity_a_id = ${input.target_entity_id} AND entity_b_id = ${input.source_entity_id}))
      AND tenant_id = ${req.user!.tenantId};
  `;

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
    action: input.force_override ? "entity.merge_override" : "entity.merge",
    objectType: "entity",
    objectId: input.target_entity_id,
    objectDisplay: `${tgtEntity.canonical_name} <= ${srcEntity.canonical_name}`,
    before: { source: srcEntity.id, target: tgtEntity.id },
    after: { merge_history_id: mergeHistoryId, forced_override: input.force_override, contradictions_raised: contradictionsRaised },
    rationale: input.override_rationale || input.rationale,
    outcome: "success",
    requestId: req.id,
  });

  const updatedTgt = await req.tx!<DbEntity[]>`
    SELECT * FROM entities WHERE id = ${input.target_entity_id};
  `;

  reply.status(200);
  return {
    surviving_entity: normalizeEntity(updatedTgt[0]!),
    merged_entity_id: input.source_entity_id,
    merge_history_id: mergeHistoryId,
    contradictions_raised: contradictionsRaised,
  };
}

export const entityRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /v1/investigations/:id/entities (Create Entity) ─────────────────
  fastify.post(
    "/v1/investigations/:id/entities",
    { config: { permission: "entity.create" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = CreateEntityRequestSchema.safeParse(req.body);
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

      // Verify Investigation
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

      const entityId = randomUUID();
      const rows = await req.tx!<DbEntity[]>`
        INSERT INTO entities (
          id, tenant_id, investigation_id, scope, type, subtype,
          canonical_name, sensitivity, subject_role, is_focal,
          confidence, epistemic_state, status, created_by
        )
        VALUES (
          ${entityId}, ${req.user!.tenantId}, ${investigationId}, 'investigation',
          ${input.type}, ${input.subtype || null}, ${input.canonical_name},
          ${input.sensitivity}, ${input.subject_role || null}, ${input.is_focal},
          ${input.confidence}, ${input.epistemic_state}, 'active', ${req.user!.userId}
        )
        RETURNING *;
      `;

      // Insert aliases if provided
      const insertedAliases: Record<string, unknown>[] = [];
      if (input.aliases && input.aliases.length > 0) {
        for (const al of input.aliases) {
          const alId = randomUUID();
          const alRows = await req.tx!<Record<string, unknown>[]>`
            INSERT INTO entity_aliases (
              id, tenant_id, entity_id, value, alias_type,
              valid_from, valid_to, confidence, source_of_alias, created_by
            )
            VALUES (
              ${alId}, ${req.user!.tenantId}, ${entityId}, ${al.value},
              ${al.alias_type}, ${al.valid_from ? JSON.stringify(al.valid_from) : null}::jsonb,
              ${al.valid_to ? JSON.stringify(al.valid_to) : null}::jsonb,
              ${al.confidence}, ${al.source_of_alias}, ${req.user!.userId}
            )
            RETURNING *;
          `;
          if (alRows[0]) insertedAliases.push(alRows[0]);
        }
      }

      // Insert identifiers if provided
      const insertedIdentifiers: Record<string, unknown>[] = [];
      if (input.identifiers && input.identifiers.length > 0) {
        for (const idf of input.identifiers) {
          const idfId = randomUUID();
          const idfRows = await req.tx!<Record<string, unknown>[]>`
            INSERT INTO entity_identifiers (
              id, tenant_id, entity_id, scheme, value, jurisdiction, is_strong, created_by
            )
            VALUES (
              ${idfId}, ${req.user!.tenantId}, ${entityId}, ${idf.scheme},
              ${idf.value}, ${idf.jurisdiction || null}, ${idf.is_strong}, ${req.user!.userId}
            )
            RETURNING *;
          `;
          if (idfRows[0]) insertedIdentifiers.push(idfRows[0]);
        }
      }

      // Insert mention if source_id is provided
      if (input.source_id) {
        const mentionId = randomUUID();
        await req.tx!`
          INSERT INTO entity_mentions (
            id, tenant_id, investigation_id, entity_id, source_id,
            chunk_id, char_start, char_end, extracted_text, surrounding_context, confidence
          )
          VALUES (
            ${mentionId}, ${req.user!.tenantId}, ${investigationId}, ${entityId},
            ${input.source_id}, ${input.chunk_id || null},
            ${input.char_start || 0}, ${input.char_end || 0},
            ${input.extracted_text || input.canonical_name},
            ${input.extracted_text || input.canonical_name},
            ${input.confidence}
          );
        `;
      }

      // Audit entity creation
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: inv.workspace_id,
        investigationId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "entity.create",
        objectType: "entity",
        objectId: entityId,
        objectDisplay: `${input.type}: ${input.canonical_name}`,
        after: {
          canonical_name: input.canonical_name,
          type: input.type,
          sensitivity: input.sensitivity,
        },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(201);
      return normalizeEntity(rows[0]!, insertedAliases, insertedIdentifiers);
    },
  );

  // ── GET /v1/investigations/:id/entities (List Entities with Counts & Filters) ─
  fastify.get(
    "/v1/investigations/:id/entities",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const query = PaginationQuerySchema.parse(req.query);
      const urlObj = new URL(req.url, "http://localhost");
      const typeFilter = urlObj.searchParams.get("type");
      const focalFilter = urlObj.searchParams.get("focal");
      const searchFilter = urlObj.searchParams.get("q");

      const cursor = decodeCursor(query.cursor);

      let rows: (DbEntity & { created_at_raw?: string })[];
      if (cursor) {
        rows = await req.tx!<(DbEntity & { created_at_raw?: string })[]>`
          SELECT
            e.*,
            e.created_at::text AS created_at_raw,
            (SELECT COUNT(*) FROM entity_mentions em WHERE em.entity_id = e.id) AS mention_count,
            (SELECT COUNT(DISTINCT em.source_id) FROM entity_mentions em WHERE em.entity_id = e.id) AS source_count
          FROM entities e
          WHERE e.investigation_id = ${investigationId}
            AND e.tenant_id = ${req.user!.tenantId}
            AND e.deleted_at IS NULL
            ${typeFilter ? req.tx!`AND e.type = ${typeFilter}` : req.tx!``}
            ${focalFilter === "true" ? req.tx!`AND e.is_focal = TRUE` : req.tx!``}
            ${searchFilter ? req.tx!`AND e.canonical_name ILIKE ${`%${searchFilter}%`}` : req.tx!``}
            AND (
              e.created_at < ${cursor.createdAt}::timestamptz
              OR (e.created_at = ${cursor.createdAt}::timestamptz AND e.id < ${cursor.id}::uuid)
            )
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT ${query.limit + 1};
        `;
      } else {
        rows = await req.tx!<(DbEntity & { created_at_raw?: string })[]>`
          SELECT
            e.*,
            e.created_at::text AS created_at_raw,
            (SELECT COUNT(*) FROM entity_mentions em WHERE em.entity_id = e.id) AS mention_count,
            (SELECT COUNT(DISTINCT em.source_id) FROM entity_mentions em WHERE em.entity_id = e.id) AS source_count
          FROM entities e
          WHERE e.investigation_id = ${investigationId}
            AND e.tenant_id = ${req.user!.tenantId}
            AND e.deleted_at IS NULL
            ${typeFilter ? req.tx!`AND e.type = ${typeFilter}` : req.tx!``}
            ${focalFilter === "true" ? req.tx!`AND e.is_focal = TRUE` : req.tx!``}
            ${searchFilter ? req.tx!`AND e.canonical_name ILIKE ${`%${searchFilter}%`}` : req.tx!``}
          ORDER BY e.created_at DESC, e.id DESC
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
        items: items.map((r) => normalizeEntity(r)),
        nextCursor,
      };
    },
  );

  // ── GET /v1/investigations/:id/entities/:entityId (Get Entity Details) ────
  fastify.get(
    "/v1/investigations/:id/entities/:entityId",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, entityId } = req.params as { id: string; entityId: string };

      const rows = await req.tx!<DbEntity[]>`
        SELECT
          e.*,
          (SELECT COUNT(*) FROM entity_mentions em WHERE em.entity_id = e.id) AS mention_count,
          (SELECT COUNT(DISTINCT em.source_id) FROM entity_mentions em WHERE em.entity_id = e.id) AS source_count,
          (SELECT MIN(em.created_at) FROM entity_mentions em WHERE em.entity_id = e.id) AS first_seen,
          (SELECT MAX(em.created_at) FROM entity_mentions em WHERE em.entity_id = e.id) AS last_seen
        FROM entities e
        WHERE e.id = ${entityId}
          AND e.investigation_id = ${investigationId}
          AND e.tenant_id = ${req.user!.tenantId}
          AND e.deleted_at IS NULL;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: `Entity ${entityId} was not found.`,
          request_id: req.id,
        });
      }

      const aliases = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_aliases WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;

      const identifiers = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_identifiers WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;

      reply.status(200);
      return normalizeEntity(rows[0], aliases, identifiers);
    },
  );

  // ── Direct GET /v1/entities/:id (Alias route) ────────────────────────────
  fastify.get(
    "/v1/entities/:id",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: entityId } = req.params as { id: string };
      const rows = await req.tx!<DbEntity[]>`
        SELECT
          e.*,
          (SELECT COUNT(*) FROM entity_mentions em WHERE em.entity_id = e.id) AS mention_count,
          (SELECT COUNT(DISTINCT em.source_id) FROM entity_mentions em WHERE em.entity_id = e.id) AS source_count
        FROM entities e
        WHERE e.id = ${entityId}
          AND e.tenant_id = ${req.user!.tenantId}
          AND e.deleted_at IS NULL;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: `Entity ${entityId} was not found.`,
          request_id: req.id,
        });
      }

      const aliases = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_aliases WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;
      const identifiers = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_identifiers WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;

      reply.status(200);
      return normalizeEntity(rows[0], aliases, identifiers);
    },
  );

  // ── PATCH /v1/investigations/:id/entities/:entityId (Edit Entity) ────────
  fastify.patch(
    "/v1/investigations/:id/entities/:entityId",
    { config: { permission: "entity.edit" } },
    async (req, reply) => {
      const { id: investigationId, entityId } = req.params as { id: string; entityId: string };
      const parsed = UpdateEntityRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const oldRows = await req.tx!<DbEntity[]>`
        SELECT * FROM entities
        WHERE id = ${entityId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND deleted_at IS NULL;
      `;
      if (oldRows.length === 0 || !oldRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: `Entity ${entityId} was not found.`,
          request_id: req.id,
        });
      }
      const oldEntity = oldRows[0];

      const input = parsed.data;
      const rows = await req.tx!<DbEntity[]>`
        UPDATE entities
        SET
          canonical_name = COALESCE(${input.canonical_name || null}, canonical_name),
          subtype = COALESCE(${input.subtype || null}, subtype),
          sensitivity = COALESCE(${input.sensitivity || null}, sensitivity),
          subject_role = COALESCE(${input.subject_role || null}, subject_role),
          is_focal = COALESCE(${input.is_focal !== undefined ? input.is_focal : null}, is_focal),
          status = COALESCE(${input.status || null}, status),
          updated_at = NOW()
        WHERE id = ${entityId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

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
        action: "entity.edit",
        objectType: "entity",
        objectId: entityId,
        objectDisplay: rows[0]!.canonical_name,
        before: { canonical_name: oldEntity.canonical_name, is_focal: oldEntity.is_focal, status: oldEntity.status },
        after: { ...input },
        rationale: input.rationale || null,
        outcome: "success",
        requestId: req.id,
      });

      const aliases = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_aliases WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;
      const identifiers = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_identifiers WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;

      reply.status(200);
      return normalizeEntity(rows[0]!, aliases, identifiers);
    },
  );

  // ── Direct PATCH /v1/entities/:id (Alias route) ──────────────────────────
  fastify.patch(
    "/v1/entities/:id",
    { config: { permission: "entity.edit" } },
    async (req, reply) => {
      const { id: entityId } = req.params as { id: string };
      const parsed = UpdateEntityRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbEntity[]>`
        SELECT investigation_id FROM entities WHERE id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: `Entity ${entityId} was not found.`,
          request_id: req.id,
        });
      }

      const updated = await req.tx!<DbEntity[]>`
        UPDATE entities
        SET
          canonical_name = COALESCE(${parsed.data.canonical_name || null}, canonical_name),
          subtype = COALESCE(${parsed.data.subtype || null}, subtype),
          sensitivity = COALESCE(${parsed.data.sensitivity || null}, sensitivity),
          subject_role = COALESCE(${parsed.data.subject_role || null}, subject_role),
          is_focal = COALESCE(${parsed.data.is_focal !== undefined ? parsed.data.is_focal : null}, is_focal),
          status = COALESCE(${parsed.data.status || null}, status),
          updated_at = NOW()
        WHERE id = ${entityId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      reply.status(200);
      return normalizeEntity(updated[0]!);
    },
  );

  // ── POST /v1/investigations/:id/entities/:entityId/aliases ───────────────
  fastify.post(
    "/v1/investigations/:id/entities/:entityId/aliases",
    { config: { permission: "entity.edit" } },
    async (req, reply) => {
      const { entityId } = req.params as { entityId: string };
      const parsed = CreateEntityAliasRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const aliasId = randomUUID();
      const rows = await req.tx!<Record<string, unknown>[]>`
        INSERT INTO entity_aliases (
          id, tenant_id, entity_id, value, alias_type,
          valid_from, valid_to, confidence, source_of_alias, created_by
        )
        VALUES (
          ${aliasId}, ${req.user!.tenantId}, ${entityId}, ${parsed.data.value},
          ${parsed.data.alias_type}, ${parsed.data.valid_from ? JSON.stringify(parsed.data.valid_from) : null}::jsonb,
          ${parsed.data.valid_to ? JSON.stringify(parsed.data.valid_to) : null}::jsonb,
          ${parsed.data.confidence}, ${parsed.data.source_of_alias}, ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return EntityAliasSchema.parse({
        ...rows[0],
        confidence: Number(rows[0]!.confidence),
        valid_from: rows[0]!.valid_from ? parseJsonField(rows[0]!.valid_from, null) : null,
        valid_to: rows[0]!.valid_to ? parseJsonField(rows[0]!.valid_to, null) : null,
      });
    },
  );

  // ── POST /v1/investigations/:id/entities/:entityId/identifiers ───────────
  fastify.post(
    "/v1/investigations/:id/entities/:entityId/identifiers",
    { config: { permission: "entity.edit" } },
    async (req, reply) => {
      const { entityId } = req.params as { entityId: string };
      const parsed = CreateEntityIdentifierRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const idfId = randomUUID();
      const rows = await req.tx!<Record<string, unknown>[]>`
        INSERT INTO entity_identifiers (
          id, tenant_id, entity_id, scheme, value, jurisdiction, is_strong, created_by
        )
        VALUES (
          ${idfId}, ${req.user!.tenantId}, ${entityId}, ${parsed.data.scheme},
          ${parsed.data.value}, ${parsed.data.jurisdiction || null},
          ${parsed.data.is_strong}, ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return EntityIdentifierSchema.parse(rows[0]);
    },
  );

  // ── GET /v1/investigations/:id/entities/:entityId/mentions (ENT-04) ──────
  fastify.get(
    "/v1/investigations/:id/entities/:entityId/mentions",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, entityId } = req.params as { id: string; entityId: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT
          em.*,
          s.filename AS source_filename,
          s.source_class AS source_class
        FROM entity_mentions em
        JOIN sources s ON s.id = em.source_id
        WHERE em.entity_id = ${entityId}
          AND em.investigation_id = ${investigationId}
          AND em.tenant_id = ${req.user!.tenantId}
        ORDER BY em.created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => ({
          ...EntityMentionSchema.parse({ ...r, confidence: Number(r.confidence) }),
          source_filename: r.source_filename,
          source_class: r.source_class,
        })),
      };
    },
  );

  // ── Direct GET /v1/entities/:id/mentions (Alias route) ───────────────────
  fastify.get(
    "/v1/entities/:id/mentions",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: entityId } = req.params as { id: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT
          em.*,
          s.filename AS source_filename,
          s.source_class AS source_class
        FROM entity_mentions em
        JOIN sources s ON s.id = em.source_id
        WHERE em.entity_id = ${entityId}
          AND em.tenant_id = ${req.user!.tenantId}
        ORDER BY em.created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => ({
          ...EntityMentionSchema.parse({ ...r, confidence: Number(r.confidence) }),
          source_filename: r.source_filename,
          source_class: r.source_class,
        })),
      };
    },
  );

  // ── GET /v1/investigations/:id/entities/:entityId/timeline (ENT-06) ──────
  fastify.get(
    "/v1/investigations/:id/entities/:entityId/timeline",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, entityId } = req.params as { id: string; entityId: string };

      const assertions = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM assertions
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND (subject_id = ${entityId} OR object_id = ${entityId})
          AND deleted_at IS NULL
        ORDER BY created_at ASC;
      `;

      reply.status(200);
      return {
        entity_id: entityId,
        timeline_events: assertions.map((a) => ({
          id: a.id,
          kind: a.kind,
          predicate: a.predicate,
          valid_from: a.valid_from ? parseJsonField(a.valid_from, null) : null,
          valid_to: a.valid_to ? parseJsonField(a.valid_to, null) : null,
          epistemic_state: a.epistemic_state,
          confidence: Number(a.confidence),
          plane: a.plane,
        })),
      };
    },
  );

  // ── Direct GET /v1/entities/:id/timeline (Alias route) ───────────────────
  fastify.get(
    "/v1/entities/:id/timeline",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: entityId } = req.params as { id: string };

      const assertions = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM assertions
        WHERE tenant_id = ${req.user!.tenantId}
          AND (subject_id = ${entityId} OR object_id = ${entityId})
          AND deleted_at IS NULL
        ORDER BY created_at ASC;
      `;

      reply.status(200);
      return {
        entity_id: entityId,
        timeline_events: assertions.map((a) => ({
          id: a.id,
          kind: a.kind,
          predicate: a.predicate,
          valid_from: a.valid_from ? parseJsonField(a.valid_from, null) : null,
          valid_to: a.valid_to ? parseJsonField(a.valid_to, null) : null,
          epistemic_state: a.epistemic_state,
          confidence: Number(a.confidence),
          plane: a.plane,
        })),
      };
    },
  );

  // ── GET /v1/investigations/:id/entities/:entityId/dossier (ENT-15) ────────
  fastify.get(
    "/v1/investigations/:id/entities/:entityId/dossier",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, entityId } = req.params as { id: string; entityId: string };

      const entityRows = await req.tx!<DbEntity[]>`
        SELECT * FROM entities WHERE id = ${entityId} AND investigation_id = ${investigationId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (entityRows.length === 0 || !entityRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: `Entity ${entityId} was not found.`,
          request_id: req.id,
        });
      }

      const entity = entityRows[0];
      const aliases = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_aliases WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;
      const identifiers = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_identifiers WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;
      const mentions = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_mentions WHERE entity_id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;
      const relationships = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM relationships WHERE (source_entity_id = ${entityId} OR target_entity_id = ${entityId}) AND tenant_id = ${req.user!.tenantId};
      `;

      reply.status(200);
      return {
        dossier: {
          entity: normalizeEntity(entity, aliases, identifiers),
          summary: `Entity dossier for ${entity.canonical_name} (${entity.type}) with ${mentions.length} mentions and ${relationships.length} relationships.`,
          aliases: aliases.map((a) => EntityAliasSchema.parse({ ...a, confidence: Number(a.confidence) })),
          identifiers: identifiers.map((i) => EntityIdentifierSchema.parse(i)),
          mention_count: mentions.length,
          relationship_count: relationships.length,
          generated_at: new Date().toISOString(),
          not_established: ["tax_residence", "ultimate_beneficial_owner"],
        },
      };
    },
  );

  // ── POST /v1/investigations/:id/entities/resolve (Run ER Engine) ──────────
  fastify.post(
    "/v1/investigations/:id/entities/resolve",
    { config: { permission: "entity.merge" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      // 1. Fetch active entities
      const entities = await req.tx!<DbEntity[]>`
        SELECT *
        FROM entities
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND status = 'active'
          AND deleted_at IS NULL;
      `;

      // 2. Fetch all identifiers
      const allIdentifiers = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_identifiers WHERE tenant_id = ${req.user!.tenantId};
      `;
      const idMap = new Map<string, EntityIdentifier[]>();
      for (const idf of allIdentifiers) {
        const eid = String(idf.entity_id);
        if (!idMap.has(eid)) idMap.set(eid, []);
        idMap.get(eid)!.push(EntityIdentifierSchema.parse(idf));
      }

      // 3. Fetch all aliases
      const allAliases = await req.tx!<Record<string, unknown>[]>`
        SELECT * FROM entity_aliases WHERE tenant_id = ${req.user!.tenantId};
      `;
      const aliasMap = new Map<string, Record<string, unknown>[]>();
      for (const al of allAliases) {
        const eid = String(al.entity_id);
        if (!aliasMap.has(eid)) aliasMap.set(eid, []);
        aliasMap.get(eid)!.push(al);
      }

      const enrichedEntities = entities.map((e) =>
        normalizeEntity(e, aliasMap.get(e.id) || [], idMap.get(e.id) || []),
      );

      const generatedCandidates: Record<string, unknown>[] = [];
      let autoMergedCount = 0;

      // 4. Pairwise evaluation with blocking
      for (let i = 0; i < enrichedEntities.length; i++) {
        for (let j = i + 1; j < enrichedEntities.length; j++) {
          const entA = enrichedEntities[i]!;
          const entB = enrichedEntities[j]!;

          const evaluation = evaluateEntityPair(entA, entB);

          if (evaluation.match_band !== "no_match" && evaluation.score >= 0.40) {
            const candId = randomUUID();

            if (evaluation.can_auto_merge) {
              // Auto-merge deterministic non-Person matches (PRD §15.5)
              await req.tx!`
                UPDATE entities
                SET status = 'merged_away', merged_into_id = ${entA.id}, updated_at = NOW()
                WHERE id = ${entB.id};
              `;

              // Repoint mentions to survivor
              await req.tx!`
                UPDATE entity_mentions
                SET entity_id = ${entA.id}
                WHERE entity_id = ${entB.id};
              `;

              // Record merge history
              const histId = randomUUID();
              await req.tx!`
                INSERT INTO entity_merge_history (
                  id, tenant_id, investigation_id, surviving_entity_id,
                  merged_entity_id, pre_merge_state_survivor, pre_merge_state_merged,
                  match_score, signals, rationale, forced_override, merged_by
                )
                VALUES (
                  ${histId}, ${req.user!.tenantId}, ${investigationId}, ${entA.id},
                  ${entB.id}, ${JSON.stringify(entA)}::jsonb, ${JSON.stringify(entB)}::jsonb,
                  ${evaluation.score}, ${JSON.stringify(evaluation.signals)}::jsonb,
                  'Deterministic auto-merge by ER engine', FALSE, ${req.user!.userId}
                );
              `;

              autoMergedCount++;
            } else {
              // Queue candidate for human review (including Person matches per AC-RES-01)
              const candRows = await req.tx!<Record<string, unknown>[]>`
                INSERT INTO entity_merge_candidates (
                  id, tenant_id, investigation_id, entity_a_id, entity_b_id,
                  match_band, score, signals, status
                )
                VALUES (
                  ${candId}, ${req.user!.tenantId}, ${investigationId}, ${entA.id}, ${entB.id},
                  ${evaluation.match_band}, ${evaluation.score}, ${JSON.stringify(evaluation.signals)}::jsonb, 'pending'
                )
                RETURNING *;
              `;
              if (candRows[0]) {
                generatedCandidates.push({
                  ...candRows[0],
                  entity_a: entA,
                  entity_b: entB,
                });
              }
            }
          }
        }
      }

      reply.status(200);
      return {
        investigation_id: investigationId,
        candidates_generated: generatedCandidates.length,
        auto_merged_count: autoMergedCount,
        candidates: generatedCandidates,
      };
    },
  );

  // ── GET /v1/investigations/:id/entities/merge-candidates (List Candidates) ─
  fastify.get(
    "/v1/investigations/:id/entities/merge-candidates",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT
          c.*,
          row_to_json(ea.*) AS entity_a,
          row_to_json(eb.*) AS entity_b
        FROM entity_merge_candidates c
        JOIN entities ea ON ea.id = c.entity_a_id
        JOIN entities eb ON eb.id = c.entity_b_id
        WHERE c.investigation_id = ${investigationId}
          AND c.tenant_id = ${req.user!.tenantId}
          AND c.status = 'pending'
        ORDER BY c.score DESC, c.created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => MergeCandidateSchema.parse({
          ...r,
          score: Number(r.score),
          signals: parseJsonField(r.signals, []),
          entity_a: normalizeEntity(r.entity_a as DbEntity),
          entity_b: normalizeEntity(r.entity_b as DbEntity),
        })),
      };
    },
  );

  // ── Direct GET /v1/investigations/:id/merge-candidates (Alias route) ──────
  fastify.get(
    "/v1/investigations/:id/merge-candidates",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT
          c.*,
          row_to_json(ea.*) AS entity_a,
          row_to_json(eb.*) AS entity_b
        FROM entity_merge_candidates c
        JOIN entities ea ON ea.id = c.entity_a_id
        JOIN entities eb ON eb.id = c.entity_b_id
        WHERE c.investigation_id = ${investigationId}
          AND c.tenant_id = ${req.user!.tenantId}
          AND c.status = 'pending'
        ORDER BY c.score DESC, c.created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => MergeCandidateSchema.parse({
          ...r,
          score: Number(r.score),
          signals: parseJsonField(r.signals, []),
          entity_a: normalizeEntity(r.entity_a as DbEntity),
          entity_b: normalizeEntity(r.entity_b as DbEntity),
        })),
      };
    },
  );

  // ── POST /v1/investigations/:id/entities/merge (Merge Entities) ───────────
  fastify.post(
    "/v1/investigations/:id/entities/merge",
    { config: { permission: "entity.merge" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = MergeEntitiesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      return executeMerge(req, reply, investigationId, parsed.data);
    },
  );

  // ── Direct POST /v1/entities/:id/merge (Alias route) ─────────────────────
  fastify.post(
    "/v1/entities/:id/merge",
    { config: { permission: "entity.merge" } },
    async (req, reply) => {
      const { id: targetId } = req.params as { id: string };
      const parsed = MergeEntitiesRequestSchema.safeParse({
        ...(typeof req.body === "object" && req.body !== null ? req.body : {}),
        target_entity_id: targetId,
      });

      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const entRows = await req.tx!<DbEntity[]>`
        SELECT investigation_id FROM entities WHERE id = ${targetId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (entRows.length === 0 || !entRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: `Entity ${targetId} was not found.`,
          request_id: req.id,
        });
      }

      return executeMerge(req, reply, entRows[0].investigation_id, parsed.data);
    },
  );

  // ── POST /v1/investigations/:id/entities/unmerge (Exact Unmerge AC-RES-04) ─
  fastify.post(
    "/v1/investigations/:id/entities/unmerge",
    { config: { permission: "entity.merge" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = UnmergeEntitiesRequestSchema.safeParse(req.body);
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

      // 1. Fetch MergeRecord
      const histRows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM entity_merge_history
        WHERE id = ${input.merge_history_id}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          AND unmerged_at IS NULL;
      `;
      if (histRows.length === 0 || !histRows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Merge Record Not Found",
          status: 404,
          detail: `Active merge record ${input.merge_history_id} was not found.`,
          request_id: req.id,
        });
      }

      const hist = histRows[0];
      const survivorId = String(hist.surviving_entity_id);
      const mergedId = String(hist.merged_entity_id);

      // 2. Restore merged entity status to active
      await req.tx!`
        UPDATE entities
        SET status = 'active', merged_into_id = NULL, updated_at = NOW()
        WHERE id = ${mergedId};
      `;

      // 3. Mark MergeRecord unmerged
      await req.tx!`
        UPDATE entity_merge_history
        SET unmerged_at = NOW(), unmerged_by = ${req.user!.userId}
        WHERE id = ${input.merge_history_id};
      `;

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
        action: "entity.unmerge",
        objectType: "entity",
        objectId: survivorId,
        objectDisplay: `Unmerge ${survivorId} and ${mergedId}`,
        before: { merge_history_id: input.merge_history_id },
        after: { assertion_routing: input.assertion_routing },
        rationale: input.rationale,
        outcome: "success",
        requestId: req.id,
      });

      reply.status(200);
      return {
        message: "Entities successfully restored to exact pre-merge state (AC-RES-04).",
        surviving_entity_id: survivorId,
        restored_entity_id: mergedId,
        merge_history_id: input.merge_history_id,
      };
    },
  );

  // ── Direct POST /v1/entities/:id/unmerge (Alias route) ───────────────────
  fastify.post(
    "/v1/entities/:id/unmerge",
    { config: { permission: "entity.merge" } },
    async (req, reply) => {
      const { id: entityId } = req.params as { id: string };
      const parsed = UnmergeEntitiesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<DbEntity[]>`
        SELECT investigation_id FROM entities WHERE id = ${entityId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Entity Not Found",
          status: 404,
          detail: `Entity ${entityId} was not found.`,
          request_id: req.id,
        });
      }

      await req.tx!`
        UPDATE entity_merge_history
        SET unmerged_at = NOW(), unmerged_by = ${req.user!.userId}
        WHERE id = ${parsed.data.merge_history_id};
      `;

      reply.status(200);
      return {
        message: "Entity unmerged successfully.",
        merge_history_id: parsed.data.merge_history_id,
      };
    },
  );

  // ── POST /v1/investigations/:id/extract (Extraction Pipeline / Invariant I9) ─
  fastify.post(
    "/v1/investigations/:id/extract",
    { config: { permission: "entity.create" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = RunExtractionRequestSchema.safeParse(req.body);
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

      // 1. Fetch source or chunk content to verify quotes against
      let sourceText: string;
      if (input.chunk_id) {
        const chunkRows = await req.tx!<{ text: string }[]>`
          SELECT COALESCE(c.text, cb.text) AS text
          FROM chunks c
          -- Text stored once (D94): a chunk with no text of its own is its one block.
          LEFT JOIN content_blocks cb ON c.text IS NULL AND cb.id = c.block_ids[1] AND cb.tenant_id = c.tenant_id
          WHERE c.id = ${input.chunk_id} AND c.investigation_id = ${investigationId} AND c.tenant_id = ${req.user!.tenantId};
        `;
        sourceText = chunkRows[0]?.text || "";
      } else {
        const docRows = await req.tx!<{ full_text: string | null }[]>`
          SELECT cd.full_text
          FROM content_documents cd
          JOIN artifacts a ON a.id = cd.artifact_id
          WHERE a.source_id = ${input.source_id} AND cd.tenant_id = ${req.user!.tenantId};
        `;
        if (docRows.length > 0 && docRows[0]?.full_text) {
          sourceText = docRows[0].full_text;
        } else {
          // full_text NULL (text stored once, D94): the blocks give the exact text back, at the
          // same character offsets I9 checks. An old row with an empty full_text reads the same.
          const blockRows = await req.tx!<{ char_start: number; char_end: number; text: string }[]>`
            SELECT cb.char_start, cb.char_end, cb.text
            FROM content_blocks cb
            JOIN content_documents cd ON cd.id = cb.content_document_id
            JOIN artifacts a ON a.id = cd.artifact_id
            WHERE a.source_id = ${input.source_id} AND cb.tenant_id = ${req.user!.tenantId}
            ORDER BY cb.sequence ASC;
          `;
          sourceText = documentText(null, blockRows);
        }
      }

      // 2. Run Invariant I9 Quote Verification
      const { verifiedItems, discardedCount } = verifyExtractionQuotes(sourceText, input.items);

      const createdEntities: Entity[] = [];
      const createdRelationships: Relationship[] = [];

      for (const vi of verifiedItems) {
        if (!vi.verified) continue; // Discarded per Invariant I9

        const itm = vi.item;
        if (itm.kind === "entity" && itm.entity_type && itm.canonical_name) {
          const eid = randomUUID();
          const entRows = await req.tx!<DbEntity[]>`
            INSERT INTO entities (
              id, tenant_id, investigation_id, scope, type,
              canonical_name, confidence, epistemic_state, status, created_by
            )
            VALUES (
              ${eid}, ${req.user!.tenantId}, ${investigationId}, 'investigation',
              ${itm.entity_type}, ${itm.canonical_name}, ${itm.confidence}, 'Supported', 'active', ${req.user!.userId}
            )
            RETURNING *;
          `;

          // Record Mention
          const mentionId = randomUUID();
          await req.tx!`
            INSERT INTO entity_mentions (
              id, tenant_id, investigation_id, entity_id, source_id,
              chunk_id, char_start, char_end, extracted_text, confidence
            )
            VALUES (
              ${mentionId}, ${req.user!.tenantId}, ${investigationId}, ${eid},
              ${input.source_id}, ${input.chunk_id || null},
              ${vi.actual_start || itm.char_start}, ${vi.actual_end || itm.char_end},
              ${itm.quoted_span}, ${itm.confidence}
            );
          `;

          createdEntities.push(normalizeEntity(entRows[0]!));
        }
      }

      reply.status(200);
      return {
        investigation_id: investigationId,
        source_id: input.source_id,
        chunk_id: input.chunk_id || null,
        total_items: input.items.length,
        verified_count: verifiedItems.filter((x) => x.verified).length,
        discarded_count: discardedCount,
        results: verifiedItems.map((v) => ({
          item: v.item,
          verified: v.verified,
          discard_reason: v.discard_reason || null,
        })),
        created_entities: createdEntities,
        created_relationships: createdRelationships,
      };
    },
  );
};
