import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import "../types.js";

/**
 * FINAL (DEV-046): a failed health check says only that the database round trip failed, with the request ID; the
 * error itself (it can name the host, the port or the database) goes to the server log with the same ID.
 */
export function unhealthy(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  req.log.error({ err, request_id: req.id }, "health check failed");
  return reply.status(503).send({ status: "unhealthy", error: "Database round-trip failed", request_id: req.id });
}

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/health",
    { config: { public: true } },
    async (_req, reply) => {
      return reply.status(200).send({
        status: "ok",
        version: "1.0.0",
        service: "casefile-api",
      });
    },
  );

  fastify.get(
    "/ready",
    { config: { public: true } },
    async (req, reply) => {
      try {
        if (req.tx) {
          await req.tx`SELECT 1;`;
        }
        return reply.status(200).send({
          status: "ready",
          database: "connected",
        });
      } catch (err) {
        return unhealthy(req, reply, err);
      }
    },
  );

  fastify.get(
    "/healthz",
    { config: { public: true } },
    async (req, reply) => {
      try {
        if (req.tx) {
          await req.tx`SELECT 1 as healthy;`;
        }
        return reply.status(200).send({
          status: "ok",
          database: "connected",
        });
      } catch (err) {
        return unhealthy(req, reply, err);
      }
    },
  );

  fastify.get(
    "/healthz/",
    { config: { public: true } },
    async (req, reply) => {
      try {
        if (req.tx) {
          await req.tx`SELECT 1 as healthy;`;
        }
        return reply.status(200).send({
          status: "ok",
          database: "connected",
        });
      } catch (err) {
        return unhealthy(req, reply, err);
      }
    },
  );
};
