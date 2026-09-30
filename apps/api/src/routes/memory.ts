import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  AssembleManifestRequestSchema,
  ContextManifestSchema,
  Tier1DefinitionMemorySchema,
  Tier2StateMemorySchema,
  Tier3WorkingMemorySchema,
  UpdateMemoryStateRequestSchema,
} from "@casefile/contracts";
import {
  getTier1DefinitionMemory,
  getTier2StateMemory,
  assembleContextManifest,
} from "../services/investigation-memory.js";

export const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /v1/investigations/:id/memory (Inspect "What Casefile Knows" PRD §13.7) ─
  fastify.get(
    "/v1/investigations/:id/memory",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const [tier1, tier2, recentSearchRows] = await Promise.all([
        getTier1DefinitionMemory(req.tx!, req.user!.tenantId, investigationId),
        getTier2StateMemory(req.tx!, req.user!.tenantId, investigationId),
        req.tx!<{ query: string }[]>`
          SELECT query
          FROM search_history
          WHERE investigation_id = ${investigationId}
            AND tenant_id = ${req.user!.tenantId}
            AND user_id = ${req.user!.userId}
          ORDER BY created_at DESC
          LIMIT 10;
        `,
      ]);

      const tier3 = {
        current_view: {},
        recent_searches: recentSearchRows.map((s) => s.query),
        recent_exchanges: [],
        recent_decisions: [],
        session_ttl_minutes: 60,
      };

      reply.status(200);
      return {
        investigation_id: investigationId,
        tier1: Tier1DefinitionMemorySchema.parse(tier1),
        tier2: Tier2StateMemorySchema.parse(tier2),
        tier3: Tier3WorkingMemorySchema.parse(tier3),
        last_updated: new Date().toISOString(),
      };
    },
  );

  // ── POST /v1/investigations/:id/memory/manifest (Assemble Context Manifest PRD §13.3) ─
  fastify.post(
    "/v1/investigations/:id/memory/manifest",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = AssembleManifestRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const manifest = await assembleContextManifest(
        req.tx!,
        req.user!.tenantId,
        investigationId,
        req.user!.userId,
        parsed.data,
      );

      reply.status(201);
      return ContextManifestSchema.parse(manifest);
    },
  );

  // ── PATCH /v1/investigations/:id/memory (Correct Memory State PRD §13.7) ──
  fastify.patch(
    "/v1/investigations/:id/memory",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = UpdateMemoryStateRequestSchema.safeParse(req.body);
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

      // Update focal status on entities if provided
      if (input.focal_entity_ids) {
        await req.tx!`
          UPDATE entities
          SET is_focal = (id = ANY(${input.focal_entity_ids}))
          WHERE investigation_id = ${investigationId} AND tenant_id = ${req.user!.tenantId};
        `;
      }

      // Upsert snapshot
      await req.tx!`
        INSERT INTO investigation_memory_snapshots (
          tenant_id, investigation_id, focal_entity_ids,
          dismissed_gap_ids, corrected_summaries, updated_by
        )
        VALUES (
          ${req.user!.tenantId}, ${investigationId},
          ${JSON.stringify(input.focal_entity_ids || [])}::jsonb,
          ${JSON.stringify(input.dismissed_gap_ids || [])}::jsonb,
          ${JSON.stringify(input.corrected_summaries || {})}::jsonb,
          ${req.user!.userId}
        )
        ON CONFLICT (tenant_id, investigation_id)
        DO UPDATE SET
          focal_entity_ids = EXCLUDED.focal_entity_ids,
          dismissed_gap_ids = EXCLUDED.dismissed_gap_ids,
          corrected_summaries = EXCLUDED.corrected_summaries,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by;
      `;

      reply.status(200);
      return {
        message: "Investigation memory state updated successfully.",
        investigation_id: investigationId,
      };
    },
  );
};
