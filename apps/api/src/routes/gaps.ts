import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  ResearchGapSchema,
  CloseGapRequestSchema,
  AcceptGapAsUnresolvableRequestSchema,
} from "@casefile/contracts";
import {
  listResearchGaps,
  closeResearchGap,
  acceptGapAsUnresolvable,
  detectReferencedAbsentDocuments,
  CorrelationError,
} from "../services/correlation-engine.js";

export const gapRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /v1/investigations/:id/gaps (List Research Gaps) ────────────────────
  fastify.get(
    "/v1/investigations/:id/gaps",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      // Trigger automatic detection for referenced absent documents (AC-GAP-01)
      await detectReferencedAbsentDocuments(req.tx!, req.user!.tenantId, investigationId);

      const items = await listResearchGaps(req.tx!, req.user!.tenantId, investigationId);

      reply.status(200);
      return {
        items: items.map((g) => ResearchGapSchema.parse(g)),
        total: items.length,
      };
    },
  );

  // ── POST /v1/gaps/:id/close (Close Research Gap) ───────────────────────────
  fastify.post(
    "/v1/gaps/:id/close",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id: gapId } = req.params as { id: string };
      const parsed = CloseGapRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      // Fetch investigation_id from gap
      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT investigation_id
        FROM research_gaps
        WHERE id = ${gapId} AND tenant_id = ${req.user!.tenantId};
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Gap Not Found",
          status: 404,
          detail: `Research gap ${gapId} was not found.`,
          request_id: req.id,
        });
      }

      const investigationId = String(rows[0].investigation_id);

      try {
        const result = await closeResearchGap(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          gapId,
          req.user!.userId,
          parsed.data,
        );

        reply.status(200);
        return ResearchGapSchema.parse(result);
      } catch (err: unknown) {
        if (err instanceof CorrelationError) {
          return reply.status(err.statusCode).send({
            type: "https://docs.casefile.com/errors/correlation-error",
            title: "Correlation Error",
            status: err.statusCode,
            detail: err.message,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );

  // ── POST /v1/gaps/:id/accept-unresolvable (Accept Gap as Unresolvable) ───────
  fastify.post(
    "/v1/gaps/:id/accept-unresolvable",
    { config: { permission: "investigation.define" } },
    async (req, reply) => {
      const { id: gapId } = req.params as { id: string };
      const parsed = AcceptGapAsUnresolvableRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      // Fetch investigation_id from gap
      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT investigation_id
        FROM research_gaps
        WHERE id = ${gapId} AND tenant_id = ${req.user!.tenantId};
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Gap Not Found",
          status: 404,
          detail: `Research gap ${gapId} was not found.`,
          request_id: req.id,
        });
      }

      const investigationId = String(rows[0].investigation_id);

      try {
        const result = await acceptGapAsUnresolvable(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          gapId,
          req.user!.userId,
          parsed.data,
        );

        reply.status(200);
        return ResearchGapSchema.parse(result);
      } catch (err: unknown) {
        if (err instanceof CorrelationError) {
          return reply.status(err.statusCode).send({
            type: "https://docs.casefile.com/errors/correlation-error",
            title: "Correlation Error",
            status: err.statusCode,
            detail: err.message,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );
};
