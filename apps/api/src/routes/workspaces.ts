import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import {
  CreateWorkspaceRequestSchema,
  WorkspaceSchema,
  AddWorkspaceMemberRequestSchema,
  WorkspaceMemberSchema,
  CreateEthicalWallRequestSchema,
  EthicalWallSchema,
  PaginationQuerySchema,
  UpdateWorkspacePolicyRequestSchema,
} from "@casefile/contracts";
import { writeAuditEvent } from "@casefile/audit";
import { encodeCursor, decodeCursor } from "../pagination.js";

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

export const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/v1/workspaces",
    { config: { permission: "workspace.create" } },
    async (req, reply) => {
      const parsed = CreateWorkspaceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const wsId = randomUUID();
      const rows = await req.tx!<
        {
          id: string;
          tenant_id: string;
          name: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]
      >`
        INSERT INTO workspaces (id, tenant_id, name, created_by)
        VALUES (${wsId}, ${req.user!.tenantId}, ${parsed.data.name}, ${req.user!.userId})
        RETURNING id, tenant_id, name, created_at, updated_at, created_by;
      `;

      await writeAuditEvent(req.tx!, {
        tenantId: req.user!.tenantId,
        workspaceId: wsId,
        actorType: "user",
        actorId: req.user!.userId,
        actorDisplay: req.user!.userId,
        action: "workspace.create",
        objectType: "workspace",
        objectId: wsId,
        objectDisplay: parsed.data.name,
        after: { name: parsed.data.name },
        outcome: "success",
        requestId: req.id,
      });

      reply.status(201);
      return WorkspaceSchema.parse(rows[0]);
    },
  );

  fastify.get(
    "/v1/workspaces",
    { config: { permission: "workspace.manage" } },
    async (req, reply) => {
      const query = PaginationQuerySchema.parse(req.query);
      const cursor = decodeCursor(query.cursor);

      let rows: {
        id: string;
        tenant_id: string;
        name: string;
        created_at: Date;
        updated_at: Date;
        created_by: string | null;
      }[];

      if (cursor) {
        rows = await req.tx!<{
          id: string;
          tenant_id: string;
          name: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]>`
          SELECT id, tenant_id, name, created_at, updated_at, created_by
          FROM workspaces
          WHERE tenant_id = ${req.user!.tenantId}
            AND deleted_at IS NULL
            AND (created_at, id) < (${new Date(cursor.createdAt)}, ${cursor.id})
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit + 1};
        `;
      } else {
        rows = await req.tx!<{
          id: string;
          tenant_id: string;
          name: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]>`
          SELECT id, tenant_id, name, created_at, updated_at, created_by
          FROM workspaces
          WHERE tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
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
              createdAt: lastItem.created_at.toISOString(),
            })
          : null;

      return reply.status(200).send({
        items: items.map((w) => WorkspaceSchema.parse(w)),
        nextCursor,
      });
    },
  );

  fastify.get(
    "/v1/workspaces/:id",
    {
      config: {
        permission: "investigation.read",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const rows = await req.tx!<
        {
          id: string;
          tenant_id: string;
          name: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]
      >`
        SELECT id, tenant_id, name, created_at, updated_at, created_by
        FROM workspaces
        WHERE id = ${id} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Workspace Not Found",
          status: 404,
          detail: `Workspace ${id} does not exist`,
          instance: req.url,
          request_id: req.id,
        });
      }

      return reply.status(200).send(WorkspaceSchema.parse(rows[0]));
    },
  );

  fastify.post(
    "/v1/workspaces/:id/members",
    {
      config: {
        permission: "workspace.members",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };
      const parsed = AddWorkspaceMemberRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      // Verify workspace exists in current tenant (PRD §45.2, Invariant I7)
      const wsCheck = await req.tx!<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (wsCheck.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Workspace not found",
          request_id: req.id,
        });
      }

      const memberId = randomUUID();
      const rows = await req.tx!<
        {
          id: string;
          tenant_id: string;
          workspace_id: string;
          user_id: string;
          role: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]
      >`
        INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role, created_by)
        VALUES (${memberId}, ${req.user!.tenantId}, ${workspaceId}, ${parsed.data.user_id}, ${parsed.data.role}, ${req.user!.userId})
        RETURNING id, tenant_id, workspace_id, user_id, role, created_at, updated_at, created_by;
      `;

      reply.status(201);
      return WorkspaceMemberSchema.parse(rows[0]);
    },
  );

  fastify.get(
    "/v1/workspaces/:id/members",
    {
      config: {
        permission: "workspace.members",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };

      // Verify workspace exists in current tenant
      const wsCheck = await req.tx!<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (wsCheck.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Workspace not found",
          request_id: req.id,
        });
      }

      const rows = await req.tx!<
        {
          id: string;
          tenant_id: string;
          workspace_id: string;
          user_id: string;
          role: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]
      >`
        SELECT id, tenant_id, workspace_id, user_id, role, created_at, updated_at, created_by
        FROM workspace_members
        WHERE workspace_id = ${workspaceId} AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at ASC;
      `;

      return reply.status(200).send({
        items: rows.map((m: Record<string, unknown>) => WorkspaceMemberSchema.parse(m)),
      });
    },
  );

  fastify.post(
    "/v1/workspaces/:id/ethical-walls",
    {
      config: {
        permission: "workspace.policy",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };
      const parsed = CreateEthicalWallRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }
      // FIXES-1 (DEV-024): only a wall that names a user can be applied. There is no group
      // membership table, so a group wall would screen nobody, silently; a "role" wall cannot even
      // be stored (the column's enum is user | group). Refused until groups exist.
      if (parsed.data.subject_type !== "user") {
        return reply.status(422).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Unsupported ethical wall",
          status: 422,
          detail:
            `An ethical wall can name a user only. A ${parsed.data.subject_type} wall would not be applied: ` +
            "there is no group membership in Casefile yet, so nothing can tell who it screens (DEV-024). " +
            "Create one wall per person instead.",
          request_id: req.id,
        });
      }
      // FINAL (DEV-036): a wall over the whole workspace (no investigation) cannot be stored
      // (ethical_walls.investigation_id is NOT NULL) and failed with a 500. Refused, with the reason,
      // until workspace-wide walls are stored and applied everywhere a wall is checked.
      if (!parsed.data.investigation_id) {
        return reply.status(422).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Unsupported ethical wall",
          status: 422,
          detail:
            "An ethical wall must name the investigation it screens. A wall over the whole workspace is not " +
            "supported yet: it could not be stored, so it would screen nobody (DEV-036). " +
            "Create one wall per investigation instead.",
          request_id: req.id,
        });
      }

      // Verify workspace exists in current tenant
      const wsCheck = await req.tx!<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (wsCheck.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Workspace not found",
          request_id: req.id,
        });
      }

      const wallId = randomUUID();
      const rows = await req.tx!<
        {
          id: string;
          tenant_id: string;
          workspace_id: string;
          subject_type: string;
          subject_id: string;
          investigation_id: string | null;
          reason: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]
      >`
        INSERT INTO ethical_walls (
          id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason, created_by
        ) VALUES (
          ${wallId}, ${req.user!.tenantId}, ${workspaceId}, ${parsed.data.subject_type},
          ${parsed.data.subject_id}, ${parsed.data.investigation_id ?? null}, ${parsed.data.reason}, ${req.user!.userId}
        )
        RETURNING id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason, created_at, updated_at, created_by;
      `;

      reply.status(201);
      return EthicalWallSchema.parse(rows[0]);
    },
  );

  fastify.get(
    "/v1/workspaces/:id/ethical-walls",
    {
      config: {
        permission: "workspace.policy",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };

      // Verify workspace exists in current tenant
      const wsCheck = await req.tx!<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (wsCheck.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Workspace not found",
          request_id: req.id,
        });
      }

      const rows = await req.tx!<
        {
          id: string;
          tenant_id: string;
          workspace_id: string;
          subject_type: string;
          subject_id: string;
          investigation_id: string | null;
          reason: string;
          created_at: Date;
          updated_at: Date;
          created_by: string | null;
        }[]
      >`
        SELECT id, tenant_id, workspace_id, subject_type, subject_id, investigation_id, reason, created_at, updated_at, created_by
        FROM ethical_walls
        WHERE workspace_id = ${workspaceId} AND tenant_id = ${req.user!.tenantId}
        ORDER BY created_at ASC;
      `;

      return reply.status(200).send({
        items: rows.map((w: Record<string, unknown>) => EthicalWallSchema.parse(w)),
      });
    },
  );

  // §45.2 & WS-04, WS-05, WS-06 GET /v1/workspaces/:id/policy
  fastify.get(
    "/v1/workspaces/:id/policy",
    {
      config: {
        permission: "workspace.policy",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };

      const rows = await req.tx!<{
        id: string;
        policy: Record<string, unknown>;
        confidence_weights: Record<string, number>;
        entity_sharing_enabled: boolean;
        ethical_wall_mode: boolean;
        retention_policy: Record<string, unknown>;
      }[]>`
        SELECT id, policy, confidence_weights, entity_sharing_enabled, ethical_wall_mode, retention_policy
        FROM workspaces
        WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Workspace not found",
          request_id: req.id,
        });
      }

      const ws = rows[0]!;
      const policyObj = parseJsonField<Record<string, unknown>>(ws.policy, {});
      const retentionObj = parseJsonField<Record<string, unknown>>(ws.retention_policy, {});
      const weightsObj = parseJsonField<Record<string, number>>(ws.confidence_weights, {});

      reply.status(200);
      return {
        workspace_id: ws.id,
        retention_policy: retentionObj,
        confidence_weights: weightsObj,
        entity_sharing_enabled: ws.entity_sharing_enabled,
        ethical_wall_mode: ws.ethical_wall_mode,
        separation_of_duties: Boolean(policyObj.separation_of_duties),
        mfa_required: Boolean(policyObj.mfa_required),
        model_policy: policyObj.model_policy as Record<string, unknown> | undefined,
      };
    },
  );

  // §45.2 & WS-04, WS-05, WS-06, AUTH-09, SEC-09, SEC-10 PATCH /v1/workspaces/:id/policy
  fastify.patch(
    "/v1/workspaces/:id/policy",
    {
      config: {
        permission: "workspace.policy",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id: workspaceId } = req.params as { id: string };
      const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const parsed = UpdateWorkspacePolicyRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }
      const body = parsed.data;

      const rows = await req.tx!<{
        id: string;
        policy: Record<string, unknown> | string;
        confidence_weights: Record<string, number> | string;
        entity_sharing_enabled: boolean;
        ethical_wall_mode: boolean;
        retention_policy: Record<string, unknown> | string;
      }[]>`
        SELECT id, policy, confidence_weights, entity_sharing_enabled, ethical_wall_mode, retention_policy
        FROM workspaces
        WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Workspace not found",
          request_id: req.id,
        });
      }

      const existing = rows[0]!;
      const existingPolicy = parseJsonField<Record<string, unknown>>(existing.policy, {});
      const existingRetention = parseJsonField<Record<string, unknown>>(existing.retention_policy, {});
      const existingWeights = parseJsonField<Record<string, number>>(existing.confidence_weights, {});

      const updatedPolicy = {
        ...existingPolicy,
        ...(body.separation_of_duties !== undefined ? { separation_of_duties: body.separation_of_duties } : {}),
        ...(body.mfa_required !== undefined ? { mfa_required: body.mfa_required } : {}),
        ...(body.model_policy !== undefined ? { model_policy: body.model_policy } : {}),
      };
      const updatedRetention = body.retention_policy !== undefined ? body.retention_policy : existingRetention;
      const updatedWeights = body.confidence_weights !== undefined ? body.confidence_weights : existingWeights;
      const updatedSharing = body.entity_sharing_enabled !== undefined ? body.entity_sharing_enabled : existing.entity_sharing_enabled;
      const updatedWall = body.ethical_wall_mode !== undefined ? body.ethical_wall_mode : existing.ethical_wall_mode;
      const tx = req.tx!;
      await tx`
        UPDATE workspaces
        SET policy = ${JSON.stringify(updatedPolicy)}::jsonb,
            retention_policy = ${JSON.stringify(updatedRetention)}::jsonb,
            confidence_weights = ${JSON.stringify(updatedWeights)}::jsonb,
            entity_sharing_enabled = ${updatedSharing},
            ethical_wall_mode = ${updatedWall},
            updated_at = NOW()
        WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId};
      `;

      reply.status(200);
      return {
        workspace_id: workspaceId,
        retention_policy: updatedRetention,
        confidence_weights: updatedWeights,
        entity_sharing_enabled: updatedSharing,
        ethical_wall_mode: updatedWall,
        separation_of_duties: Boolean(updatedPolicy.separation_of_duties),
        mfa_required: Boolean(updatedPolicy.mfa_required),
        model_policy: updatedPolicy.model_policy as Record<string, unknown> | undefined,
      };
    },
  );

  // WS-03 DELETE /v1/workspaces/:id/members/:memberId (Immediate revocation)
  fastify.delete(
    "/v1/workspaces/:id/members/:memberId",
    {
      config: {
        permission: "workspace.members",
        resourceIdParam: "id",
        resourceType: "workspace",
      },
    },
    async (req, reply) => {
      const { id: workspaceId, memberId } = req.params as { id: string; memberId: string };

      const wsCheck = await req.tx!<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${workspaceId} AND tenant_id = ${req.user!.tenantId};
      `;
      if (wsCheck.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Workspace not found",
          request_id: req.id,
        });
      }

      await req.tx!`
        DELETE FROM workspace_members
        WHERE workspace_id = ${workspaceId}
          AND (id = ${memberId} OR user_id = ${memberId})
          AND tenant_id = ${req.user!.tenantId};
      `;

      return reply.status(200).send({ status: "removed" });
    },
  );
};

