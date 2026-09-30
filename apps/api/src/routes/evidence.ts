import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  EvidenceSchema,
  CreateEvidenceRequestSchema,
  UpdateEvidenceReviewRequestSchema,
  WithdrawEvidenceRequestSchema,
  EvidenceProvenanceChainSchema,
  CitationResolutionResponseSchema,
  DriftCheckReportSchema,
} from "@casefile/contracts";
import {
  createEvidence,
  resolveCitation,
  getProvenanceChain,
  checkSpanDrift,
  withdrawEvidence,
  GroundingVerificationError,
} from "../services/evidence-grounding.js";

export const evidenceRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /v1/investigations/:id/evidence (Create Evidence / Cite-from-selection) ─
  fastify.post(
    "/v1/investigations/:id/evidence",
    { config: { permission: "evidence.create" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = CreateEvidenceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      try {
        const evidence = await createEvidence(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          req.user!.userId,
          parsed.data,
        );

        reply.status(201);
        return EvidenceSchema.parse(evidence);
      } catch (err: unknown) {
        if (err instanceof GroundingVerificationError) {
          return reply.status(422).send({
            type: "https://docs.casefile.com/errors/grounding-verification-failed",
            title: "Grounding Verification Failed",
            status: 422,
            detail: err.message,
            instance: `/v1/investigations/${investigationId}/evidence`,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );

  // ── GET /v1/investigations/:id/evidence (List Evidence) ────────────────────
  fastify.get(
    "/v1/investigations/:id/evidence",
    { config: { permission: "source.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const query = req.query as { limit?: string; cursor?: string; status?: string };
      const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM evidence
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
          ${query.status ? req.tx!`AND status = ${query.status}` : req.tx!``}
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${limit};
      `;

      reply.status(200);
      return {
        items: rows.map((r) => ({
          ...r,
          locator: typeof r.locator === "string" ? JSON.parse(r.locator) : r.locator,
          version: Number(r.version),
          admitted_at: new Date(String(r.admitted_at)).toISOString(),
          created_at: new Date(String(r.created_at)).toISOString(),
          updated_at: new Date(String(r.updated_at)).toISOString(),
          deleted_at: r.deleted_at ? new Date(String(r.deleted_at)).toISOString() : null,
          supports: [],
          contradicts: [],
        })),
      };
    },
  );

  // ── GET /v1/investigations/:id/evidence/:evidenceId/citation (Citation Resolver) ─
  fastify.get(
    "/v1/investigations/:id/evidence/:evidenceId/citation",
    { config: { permission: "source.read" } },
    async (req, reply) => {
      const { id: investigationId, evidenceId } = req.params as { id: string; evidenceId: string };

      try {
        const citation = await resolveCitation(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          evidenceId,
        );

        reply.status(200);
        return CitationResolutionResponseSchema.parse(citation);
      } catch (err: unknown) {
        if (err instanceof GroundingVerificationError) {
          return reply.status(404).send({
            type: "https://docs.casefile.com/errors/not-found",
            title: "Evidence Not Found",
            status: 404,
            detail: err.message,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );

  // ── GET /v1/investigations/:id/evidence/:evidenceId/provenance (Derivation Chain) ─
  fastify.get(
    "/v1/investigations/:id/evidence/:evidenceId/provenance",
    { config: { permission: "source.read" } },
    async (req, reply) => {
      const { id: investigationId, evidenceId } = req.params as { id: string; evidenceId: string };

      try {
        const chain = await getProvenanceChain(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          evidenceId,
        );

        reply.status(200);
        return EvidenceProvenanceChainSchema.parse(chain);
      } catch (err: unknown) {
        if (err instanceof GroundingVerificationError) {
          return reply.status(404).send({
            type: "https://docs.casefile.com/errors/not-found",
            title: "Evidence Not Found",
            status: 404,
            detail: err.message,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );

  // ── POST /v1/investigations/:id/evidence/drift-check (Run Span Drift Job) ─
  fastify.post(
    "/v1/investigations/:id/evidence/drift-check",
    { config: { permission: "evidence.create" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const report = await checkSpanDrift(
        req.tx!,
        req.user!.tenantId,
        investigationId,
      );

      reply.status(200);
      return DriftCheckReportSchema.parse(report);
    },
  );

  // ── POST /v1/investigations/:id/evidence/:evidenceId/withdraw (Withdraw Evidence) ─
  fastify.post(
    "/v1/investigations/:id/evidence/:evidenceId/withdraw",
    { config: { permission: "evidence.withdraw" } },
    async (req, reply) => {
      const { id: investigationId, evidenceId } = req.params as { id: string; evidenceId: string };
      const parsed = WithdrawEvidenceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      try {
        const evidence = await withdrawEvidence(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          evidenceId,
          req.user!.userId,
          parsed.data,
        );

        reply.status(200);
        return EvidenceSchema.parse(evidence);
      } catch (err: unknown) {
        if (err instanceof GroundingVerificationError) {
          return reply.status(404).send({
            type: "https://docs.casefile.com/errors/not-found",
            title: "Evidence Not Found",
            status: 404,
            detail: err.message,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );

  // ── PATCH /v1/investigations/:id/evidence/:evidenceId/review (Review / Dispute) ─
  fastify.patch(
    "/v1/investigations/:id/evidence/:evidenceId/review",
    { config: { permission: "evidence.create" } },
    async (req, reply) => {
      const { id: investigationId, evidenceId } = req.params as { id: string; evidenceId: string };
      const parsed = UpdateEvidenceReviewRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const rows = await req.tx!<Record<string, unknown>[]>`
        UPDATE evidence
        SET
          review_state = ${parsed.data.review_state},
          updated_at = NOW()
        WHERE id = ${evidenceId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        RETURNING *;
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Evidence Not Found",
          status: 404,
          detail: `Evidence ${evidenceId} not found.`,
          request_id: req.id,
        });
      }

      reply.status(200);
      return {
        id: evidenceId,
        review_state: parsed.data.review_state,
        message: "Evidence review state updated successfully.",
      };
    },
  );
};
