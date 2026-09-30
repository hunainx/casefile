import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  AICapabilityResultSchema,
  InvokeCapabilityRequestSchema,
  PromoteAIResultRequestSchema,
  ToolExecutionRequestSchema,
  AIToolExecutionSchema,
  ContextManifestSchema,
} from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import {
  invokeAICapability,
  promoteAIResult,
  executeAITool,
  detectPromptInjection,
  AIGatewayError,
  ToolExecutionError,
} from "../services/ai-gateway.js";

export const aiRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /v1/investigations/:id/ai/invoke (Invoke AI Capability) ────────────
  fastify.post(
    "/v1/investigations/:id/ai/invoke",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = InvokeCapabilityRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      // Check Prompt Injection (Invariant I5 / AC-INJ-01)
      const query = parsed.data.query || parsed.data.input_text || "Synthesize beneficial ownership evidence";
      const injectionCheck = detectPromptInjection(query);
      if (injectionCheck.isInjection) {
        const invRows = await req.tx!<Record<string, unknown>[]>`
          SELECT workspace_id
          FROM investigations
          WHERE id = ${investigationId} AND tenant_id = ${req.user!.tenantId};
        `;
        const workspaceId = (invRows[0]?.workspace_id as string) || null;

        await writeAuditEvent(req.tx!, {
          tenantId: req.user!.tenantId,
          workspaceId,
          investigationId,
          actorType: "user",
          actorId: req.user!.userId,
          actorDisplay: "User",
          action: "security.prompt_injection_detected",
          objectType: "ai_capability",
          objectId: randomUUID(),
          objectDisplay: `Capability ${parsed.data.capability}`,
          outcome: "denied",
          denialReason: `Prompt injection pattern detected: ${injectionCheck.patternMatched} (Invariant I5)`,
          requestId: req.id,
        });

        return reply.status(422).send({
          type: "https://docs.casefile.com/errors/prompt-injection-detected",
          title: "Prompt Injection Detected",
          status: 422,
          detail: `Adversarial prompt injection detected: ${injectionCheck.patternMatched} (Invariant I5 / AC-INJ-01).`,
          instance: `/v1/investigations/${investigationId}/ai/invoke`,
          request_id: req.id,
        });
      }

      try {
        const result = await invokeAICapability(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          req.user!.userId,
          parsed.data,
        );

        reply.status(200);
        return AICapabilityResultSchema.parse(result);
      } catch (err: unknown) {
        if (err instanceof AIGatewayError) {
          const notImplemented = err.statusCode === 501;
          return reply.status(err.statusCode).send({
            type: notImplemented
              ? "https://docs.casefile.com/errors/not-implemented"
              : "https://docs.casefile.com/errors/ai-gateway-error",
            title: notImplemented ? "Not Implemented" : "AI Gateway Error",
            status: err.statusCode,
            detail: err.message,
            instance: `/v1/investigations/${investigationId}/ai/invoke`,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );

  // ── GET /v1/investigations/:id/ai/results/:resultId (Get AI Result) ────────
  fastify.get(
    "/v1/investigations/:id/ai/results/:resultId",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, resultId } = req.params as { id: string; resultId: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM ai_results
        WHERE id = ${resultId}
          AND investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId};
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "AI Result Not Found",
          status: 404,
          detail: `AI Result ${resultId} was not found.`,
          request_id: req.id,
        });
      }

      const r = rows[0];
      reply.status(200);
      return AICapabilityResultSchema.parse({
        id: String(r.id),
        tenant_id: String(r.tenant_id),
        investigation_id: String(r.investigation_id),
        capability: r.capability,
        context_manifest_id: r.context_manifest_id ? String(r.context_manifest_id) : null,
        prompt_template_hash: String(r.prompt_template_hash),
        model: {
          provider: String(r.model_provider),
          model_id: String(r.model_id),
          version: String(r.model_version),
        },
        output: typeof r.output === "string" ? JSON.parse(r.output) : r.output,
        citations: typeof r.citations === "string" ? JSON.parse(r.citations) : r.citations,
        epistemic_state: r.epistemic_state,
        confidence: Number(r.confidence),
        insufficiency: typeof r.insufficiency === "string" ? JSON.parse(r.insufficiency) : r.insufficiency,
        falsifiers: typeof r.falsifiers === "string" ? JSON.parse(r.falsifiers) : r.falsifiers,
        verification: typeof r.verification === "string" ? JSON.parse(r.verification) : r.verification,
        plane: r.plane,
        promoted_by: r.promoted_by ? String(r.promoted_by) : null,
        promoted_at: r.promoted_at ? new Date(String(r.promoted_at)).toISOString() : null,
        cost: typeof r.cost === "string" ? JSON.parse(r.cost) : r.cost,
        latency_ms: Number(r.latency_ms),
        status: r.status,
        created_by: String(r.created_by),
        created_at: new Date(String(r.created_at)).toISOString(),
        updated_at: new Date(String(r.updated_at)).toISOString(),
      });
    },
  );

  // ── GET /v1/investigations/:id/ai/results/:resultId/manifest (Get Manifest) ─
  fastify.get(
    "/v1/investigations/:id/ai/results/:resultId/manifest",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId, resultId } = req.params as { id: string; resultId: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT m.*
        FROM context_manifests m
        JOIN ai_results r ON r.context_manifest_id = m.id
        WHERE r.id = ${resultId}
          AND r.investigation_id = ${investigationId}
          AND r.tenant_id = ${req.user!.tenantId};
      `;

      if (rows.length === 0 || !rows[0]) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Manifest Not Found",
          status: 404,
          detail: `Context manifest for AI result ${resultId} was not found.`,
          request_id: req.id,
        });
      }

      const r = rows[0];
      reply.status(200);
      return ContextManifestSchema.parse({
        id: String(r.id),
        investigation_id: String(r.investigation_id),
        operation: r.operation,
        tier1: typeof r.tier1 === "string" ? JSON.parse(r.tier1) : r.tier1,
        tier2: typeof r.tier2 === "string" ? JSON.parse(r.tier2) : r.tier2,
        tier3: typeof r.tier3 === "string" ? JSON.parse(r.tier3) : r.tier3,
        tier4: typeof r.tier4 === "string" ? JSON.parse(r.tier4) : r.tier4,
        token_budget: typeof r.token_budget === "string" ? JSON.parse(r.token_budget) : r.token_budget,
        omitted: typeof r.omitted === "string" ? JSON.parse(r.omitted) : r.omitted,
        model_target: String(r.model_target),
        assembled_at: new Date(String(r.assembled_at)).toISOString(),
      });
    },
  );

  // ── POST /v1/investigations/:id/ai/results/:resultId/promote (Class D) ─────
  fastify.post(
    "/v1/investigations/:id/ai/results/:resultId/promote",
    { config: { permission: "assertion.validate" } },
    async (req, reply) => {
      const { id: investigationId, resultId } = req.params as { id: string; resultId: string };
      const parsed = PromoteAIResultRequestSchema.safeParse(req.body);
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
        const promoted = await promoteAIResult(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          resultId,
          req.user!.userId,
          parsed.data.rationale,
        );

        reply.status(200);
        return AICapabilityResultSchema.parse(promoted);
      } catch (err: unknown) {
        if (err instanceof AIGatewayError) {
          return reply.status(err.statusCode).send({
            type: "https://docs.casefile.com/errors/ai-gateway-error",
            title: "Promotion Failed",
            status: err.statusCode,
            detail: err.message,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );

  // ── POST /v1/investigations/:id/ai/tools/execute (Execute Tool Call) ───────
  fastify.post(
    "/v1/investigations/:id/ai/tools/execute",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = ToolExecutionRequestSchema.safeParse(req.body);
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
        const execution = await executeAITool(
          req.tx!,
          req.user!.tenantId,
          investigationId,
          req.user!.userId,
          parsed.data,
        );

        reply.status(200);
        return AIToolExecutionSchema.parse(execution);
      } catch (err: unknown) {
        if (err instanceof ToolExecutionError) {
          return reply.status(err.statusCode).send({
            type: "https://docs.casefile.com/errors/tool-execution-error",
            title: "Tool Execution Denied",
            status: err.statusCode,
            detail: err.message,
            action_class: err.actionClass,
            request_id: req.id,
          });
        }
        throw err;
      }
    },
  );
};
