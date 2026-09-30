import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  SearchRequestSchema,
  SearchResponseSchema,
  SavedSearchSchema,
  CreateSavedSearchRequestSchema,
  SearchMonitorSchema,
  CreateSearchMonitorRequestSchema,
  SearchRelevanceFeedbackRequestSchema,
} from "@casefile/contracts";
import { executeSearch } from "../services/search-engine.js";

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

export const searchRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /v1/investigations/:id/search (Execute Search) ───────────────────
  fastify.post(
    "/v1/investigations/:id/search",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = SearchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const res = await executeSearch(
        req.tx!,
        req.user!.tenantId,
        investigationId,
        req.user!.userId,
        parsed.data,
      );

      reply.status(200);
      return SearchResponseSchema.parse(res);
    },
  );

  // ── GET /v1/investigations/:id/search/history (Search History) ────────────
  fastify.get(
    "/v1/investigations/:id/search/history",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM search_history
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at DESC
        LIMIT 50;
      `;

      reply.status(200);
      return {
        items: rows.map((r) => ({
          id: r.id,
          query: r.query,
          search_mode: r.search_mode,
          filters: parseJsonField(r.filters, {}),
          result_count: Number(r.result_count),
          weights_version: r.weights_version,
          index_generation: r.index_generation,
          created_at: new Date(String(r.created_at)).toISOString(),
        })),
      };
    },
  );

  // ── POST /v1/investigations/:id/search/saved (Save Search) ────────────────
  fastify.post(
    "/v1/investigations/:id/search/saved",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = CreateSavedSearchRequestSchema.safeParse(req.body);
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
      const savedId = randomUUID();

      const rows = await req.tx!<Record<string, unknown>[]>`
        INSERT INTO saved_searches (
          id, tenant_id, investigation_id, name, description,
          query, search_mode, filters, weights_version, created_by
        )
        VALUES (
          ${savedId}, ${req.user!.tenantId}, ${investigationId}, ${input.name},
          ${input.description || null}, ${input.query}, ${input.search_mode},
          ${JSON.stringify(input.filters)}::jsonb, ${input.weights_version}, ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return SavedSearchSchema.parse({
        ...rows[0],
        filters: parseJsonField(rows[0]!.filters, {}),
        created_at: new Date(String(rows[0]!.created_at)).toISOString(),
        updated_at: new Date(String(rows[0]!.updated_at)).toISOString(),
      });
    },
  );

  // ── GET /v1/investigations/:id/search/saved (List Saved Searches) ──────────
  fastify.get(
    "/v1/investigations/:id/search/saved",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM saved_searches
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) =>
          SavedSearchSchema.parse({
            ...r,
            filters: parseJsonField(r.filters, {}),
            created_at: new Date(String(r.created_at)).toISOString(),
            updated_at: new Date(String(r.updated_at)).toISOString(),
          }),
        ),
      };
    },
  );

  // ── POST /v1/investigations/:id/search/monitors (Create Monitor) ──────────
  fastify.post(
    "/v1/investigations/:id/search/monitors",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = CreateSearchMonitorRequestSchema.safeParse(req.body);
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
      const monitorId = randomUUID();

      const rows = await req.tx!<Record<string, unknown>[]>`
        INSERT INTO search_monitors (
          id, tenant_id, investigation_id, saved_search_id,
          name, query, filters, is_active, created_by
        )
        VALUES (
          ${monitorId}, ${req.user!.tenantId}, ${investigationId},
          ${input.saved_search_id || null}, ${input.name}, ${input.query},
          ${JSON.stringify(input.filters)}::jsonb, TRUE, ${req.user!.userId}
        )
        RETURNING *;
      `;

      reply.status(201);
      return SearchMonitorSchema.parse({
        ...rows[0],
        filters: parseJsonField(rows[0]!.filters, {}),
        last_run_at: rows[0]!.last_run_at ? new Date(String(rows[0]!.last_run_at)).toISOString() : null,
        created_at: new Date(String(rows[0]!.created_at)).toISOString(),
      });
    },
  );

  // ── GET /v1/investigations/:id/search/monitors (List Monitors) ────────────
  fastify.get(
    "/v1/investigations/:id/search/monitors",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };

      const rows = await req.tx!<Record<string, unknown>[]>`
        SELECT *
        FROM search_monitors
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at DESC;
      `;

      reply.status(200);
      return {
        items: rows.map((r) =>
          SearchMonitorSchema.parse({
            ...r,
            filters: parseJsonField(r.filters, {}),
            last_run_at: r.last_run_at ? new Date(String(r.last_run_at)).toISOString() : null,
            created_at: new Date(String(r.created_at)).toISOString(),
          }),
        ),
      };
    },
  );

  // ── POST /v1/investigations/:id/search/feedback (Relevance Feedback) ──────
  fastify.post(
    "/v1/investigations/:id/search/feedback",
    { config: { permission: "investigation.read" } },
    async (req, reply) => {
      const { id: investigationId } = req.params as { id: string };
      const parsed = SearchRelevanceFeedbackRequestSchema.safeParse(req.body);
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
      const feedbackId = randomUUID();

      await req.tx!`
        INSERT INTO search_relevance_feedback (
          id, tenant_id, investigation_id, user_id, query,
          chunk_id, source_id, is_relevant, notes
        )
        VALUES (
          ${feedbackId}, ${req.user!.tenantId}, ${investigationId}, ${req.user!.userId},
          ${input.query}, ${input.chunk_id || null}, ${input.source_id},
          ${input.is_relevant}, ${input.notes || null}
        );
      `;

      reply.status(201);
      return {
        id: feedbackId,
        message: "Search relevance feedback recorded successfully (SRCH-18).",
        is_relevant: input.is_relevant,
      };
    },
  );
};
