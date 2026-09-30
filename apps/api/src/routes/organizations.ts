import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import "../types.js";
import { CreateOrganizationRequestSchema, OrganizationSchema } from "@casefile/contracts";

export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/v1/organizations",
    { config: { permission: "org.manage" } },
    async (req, reply) => {
      const parsed = CreateOrganizationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          type: "https://docs.casefile.com/errors/validation-error",
          title: "Validation Error",
          status: 400,
          detail: parsed.error.message,
          request_id: req.id,
        });
      }

      const orgId = randomUUID();
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
        INSERT INTO organizations (id, tenant_id, name, created_by)
        VALUES (${orgId}, ${req.user!.tenantId}, ${parsed.data.name}, ${req.user!.userId})
        RETURNING id, tenant_id, name, created_at, updated_at, created_by;
      `;

      reply.status(201);
      return OrganizationSchema.parse(rows[0]);
    },
  );

  fastify.get(
    "/v1/organizations/:id",
    {
      config: {
        permission: "org.manage",
        resourceIdParam: "id",
        resourceType: "organization",
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
        FROM organizations
        WHERE id = ${id} AND tenant_id = ${req.user!.tenantId} AND deleted_at IS NULL;
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          type: "https://docs.casefile.com/errors/not-found",
          title: "Organization Not Found",
          status: 404,
          detail: `Organization ${id} does not exist`,
          instance: req.url,
          request_id: req.id,
        });
      }

      return reply.status(200).send(OrganizationSchema.parse(rows[0]));
    },
  );
};
