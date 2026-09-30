import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  ContradictionSchema,
  AdjudicateContradictionRequestSchema,
  SuppressionRuleSchema,
} from "@casefile/contracts";
import {
  listContradictions,
  adjudicateContradiction,
  listSuppressionRules,
  runContradictionDetection,
  CorrelationError,
} from "../services/correlation-engine.js";

export const contradictionRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /v1/investigations/:id/contradictions (List Contradictions) ──────────
  fastify.get(
    "/v1/investigations/:id/contradictions",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      // Trigger detection pass
      await runContradictionDetection(req.tx!, req.user!.tenantId, investigationId);

      const items = await listContradictions(req.tx!, req.user!.tenantId, investigationId);

      reply.status(200);
      return {
        items: items.map((c) => ContradictionSchema.parse(c)),
        total: items.length,
      };
    },
  );

  // ── POST /v1/contradictions/:id/adjudicate (Adjudicate Contradiction) ───────
  fastify.post(
    "/v1/contradictions/:id/adjudicate",
    { config: { permission: "contradiction.adjudicate" } },
    async (req, reply) => {
      const { id: contradictionId } = req.params as { id: string };
      const parsed = AdjudicateContradictionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      // Fetch investigation_id from contradiction
      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT investigation_id
        FROM contradictions
        WHERE id = ${contradictionId} AND tenant_id = ${req.user!.tenantId};
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Contradiction Not Found",
          status: 404,
          detail: `Contradiction ${contradictionId} was not found.`,
          request_id: req.id,
        });
      }

      const investigationId = String(rows[0].investigation_id);

      try {
        const result = await adjudicateContradiction(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          contradictionId,
          req.user!.userId,
          parsed.data,
        );

        reply.status(200);
        return ContradictionSchema.parse(result);
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

  // ── GET /v1/investigations/:id/contradictions/suppression-rules ─────────────
  fastify.get(
    "/v1/investigations/:id/contradictions/suppression-rules",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const items = await listSuppressionRules(req.tx!, req.user!.tenantId, investigationId);

      reply.status(200);
      return {
        items: items.map((r) => SuppressionRuleSchema.parse(r)),
        total: items.length,
      };
    },
  );
};
