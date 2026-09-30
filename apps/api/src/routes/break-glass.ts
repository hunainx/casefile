import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { BreakGlassService } from "../services/break-glass.js";
import { AuthError } from "../auth/service.js";

const RequestBreakGlassSchema = z.object({
  tenantId: z.string().uuid(),
  staffUserId: z.string().uuid(),
  reason: z.string().min(5),
  durationMinutes: z.number().int().min(5).max(480).optional(),
});

const ApproveBreakGlassSchema = z.object({
  grantId: z.string().uuid(),
  tenantId: z.string().uuid(),
});

const RevokeBreakGlassSchema = z.object({
  grantId: z.string().uuid(),
  tenantId: z.string().uuid(),
});

export const breakGlassRoutes: FastifyPluginAsync = async (fastify) => {
  // Submit Break-Glass Request
  fastify.post(
    "/v1/admin/break-glass/request",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const parsed = RequestBreakGlassSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const grant = await BreakGlassService.requestBreakGlass(req.tx!, {
        tenantId: parsed.data.tenantId,
        staffUserId: parsed.data.staffUserId,
        reason: parsed.data.reason,
        requestedBy: req.user.userId,
        durationMinutes: parsed.data.durationMinutes,
        requestId: req.id,
      });

      return reply.status(201).send(grant);
    },
  );

  // Dual-Approve Break-Glass Request
  fastify.post(
    "/v1/admin/break-glass/approve",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const parsed = ApproveBreakGlassSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const grant = await BreakGlassService.approveBreakGlass(req.tx!, {
        grantId: parsed.data.grantId,
        approvedBy: req.user.userId,
        tenantId: parsed.data.tenantId,
        requestId: req.id,
      });

      return reply.status(200).send(grant);
    },
  );

  // Revoke Break-Glass Request
  fastify.post(
    "/v1/admin/break-glass/revoke",
    { config: { authenticated: true } },
    async (req, reply) => {
      if (!req.user) throw new AuthError("Unauthorized", "UNAUTHORIZED", 401);
      const parsed = RevokeBreakGlassSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const grant = await BreakGlassService.revokeBreakGlass(req.tx!, {
        grantId: parsed.data.grantId,
        revokedBy: req.user.userId,
        tenantId: parsed.data.tenantId,
        requestId: req.id,
      });

      return reply.status(200).send(grant);
    },
  );
};
