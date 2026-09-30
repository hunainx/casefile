import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import { AuditEventSchema, AuditExportRequestSchema, PaginationQuerySchema } from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import { encodeCursor, decodeCursor } from "../pagination.js";

function parseJsonField(val: unknown): Record<string, unknown> | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "object") return val as Record<string, unknown>;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeAuditEvent(row: Record<string, unknown>) {
  return AuditEventSchema.parse({
    ...row,
    seq: Number(row.seq),
    prev_hash: typeof row.prev_hash === "string" ? row.prev_hash.trim() : row.prev_hash,
    hash: typeof row.hash === "string" ? row.hash.trim() : row.hash,
    before: parseJsonField(row.before),
    after: parseJsonField(row.after),
    ai_involvement: parseJsonField(row.ai_involvement),
  });
}

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/v1/audit/events",
    {
      config: {
        permission: "audit.export",
        requiresStepUp: true, // ⚠ action requiring step-up MFA (D51)
      },
    },
    async (req, reply) => {
      const query = PaginationQuerySchema.parse(req.query);
      const cursor = decodeCursor(query.cursor);

      let rows: { id: string; timestamp: Date | string; seq: number | string; [key: string]: unknown }[];

      if (cursor) {
        rows = await req.tx!`
          SELECT *
          FROM audit_events
          WHERE tenant_id = ${req.user!.tenantId}
            AND (timestamp, id) < (${new Date(cursor.createdAt)}, ${cursor.id})
          ORDER BY timestamp DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      } else {
        rows = await req.tx!`
          SELECT *
          FROM audit_events
          WHERE tenant_id = ${req.user!.tenantId}
          ORDER BY timestamp DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      }

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeCursor({
              id: lastItem.id,
              createdAt: new Date(lastItem.timestamp).toISOString(),
            })
          : null;

      reply.status(200);
      return {
        items: items.map((e) => normalizeAuditEvent(e)),
        nextCursor,
      };
    },
  );

  // PRD §45.2 / REQ-API-POST-V1-AUDIT-EXPORT / REQ-M-AUDIT-009: POST /v1/audit/export
  fastify.post(
    "/v1/audit/export",
    {
      config: {
        permission: "audit.export",
        requiresStepUp: true, // ⚠ export requires step-up MFA (D51)
      },
    },
    async (req, reply) => {
      const parsed = AuditExportRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const { format, from, to } = parsed.data;

      const events = await req.tx!<{ id: string; timestamp: Date; seq: number | string; action: string; actor_id: string; [key: string]: unknown }[]>`
        SELECT *
        FROM audit_events
        WHERE tenant_id = ${req.user!.tenantId}
          ${from ? req.tx!`AND timestamp >= ${new Date(from)}` : req.tx!``}
          ${to ? req.tx!`AND timestamp <= ${new Date(to)}` : req.tx!``}
        ORDER BY seq ASC;
      `;

      const exportId = randomUUID();

      // REQ-M-AUDIT-009: Exporting audit events must itself emit an audit event
      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "audit.export",
        objectType: "audit_events",
        objectId: exportId,
        objectDisplay: `Audit Export ${exportId}`,
        after: {
          format,
          record_count: events.length,
          export_id: exportId,
        },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(200);

      if (format === "csv") {
        const header = "id,seq,timestamp,action,actor_id,outcome\n";
        const rows = events
          .map((e) => `"${e.id}","${e.seq}","${new Date(e.timestamp).toISOString()}","${e.action}","${e.actor_id}","${e.outcome || "success"}"`)
          .join("\n");
        return {
          export_id: exportId,
          format: "csv",
          record_count: events.length,
          data: header + rows,
        };
      }

      return {
        export_id: exportId,
        format: "json",
        record_count: events.length,
        data: events.map((e) => normalizeAuditEvent(e)),
      };
    },
  );
};

