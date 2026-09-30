import type { z } from "zod";
import {
  OrganizationSchema,
  CreateOrganizationRequestSchema,
  WorkspaceSchema,
  CreateWorkspaceRequestSchema,
  WorkspacePolicySchema,
  UpdateWorkspacePolicyRequestSchema,
  UserSchema,
  CreateUserRequestSchema,
  WorkspaceMemberSchema,
  AddWorkspaceMemberRequestSchema,
  EthicalWallSchema,
  CreateEthicalWallRequestSchema,
  AuditEventSchema,
  ProblemDetailsSchema,
  AuthTokenRequestSchema,
  AuthTokenResponseSchema,
  AuthRefreshRequestSchema,
  MeResponseSchema,
} from "./schemas/index.js";

/**
 * Converts a simple Zod schema into an OpenAPI 3.1 JSON Schema representation.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as {
    typeName: string;
    description?: string;
    checks?: Array<{ kind: string }>;
    values?: string[];
    options?: z.ZodTypeAny[];
    type?: z.ZodTypeAny;
    valueType?: z.ZodTypeAny;
    innerType?: z.ZodTypeAny;
    shape?: () => Record<string, z.ZodTypeAny>;
    value?: unknown;
  };
  const typeName = def.typeName;

  switch (typeName) {
    case "ZodString": {
      const res: Record<string, unknown> = { type: "string" };
      if (def.description) res.description = def.description;
      return res;
    }
    case "ZodNumber": {
      const res: Record<string, unknown> = {
        type: def.checks?.some((c) => c.kind === "int") ? "integer" : "number",
      };
      if (def.description) res.description = def.description;
      return res;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodLiteral":
      return { type: typeof def.value, enum: [def.value] };
    case "ZodUnion":
      return { oneOf: def.options?.map((opt) => zodToJsonSchema(opt)) ?? [] };
    case "ZodArray":
      return { type: "array", items: def.type ? zodToJsonSchema(def.type) : {} };
    case "ZodRecord":
      return { type: "object", additionalProperties: def.valueType ? zodToJsonSchema(def.valueType) : {} };
    case "ZodNullable": {
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : {};
      return { ...inner, nullable: true };
    }
    case "ZodOptional":
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case "ZodObject": {
      const shape = def.shape ? def.shape() : {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, propSchema] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(propSchema);
        const propTypeName = (propSchema._def as { typeName: string }).typeName;
        if (propTypeName !== "ZodOptional" && propTypeName !== "ZodNullable") {
          required.push(key);
        }
      }

      const res: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) res.required = required;
      if (def.description) res.description = def.description;
      return res;
    }
    default:
      return { type: "string" };
  }
}

/**
 * Generates the authoritative OpenAPI 3.1 contract document from Zod schemas (D32).
 */
export function generateOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Casefile Core API",
      version: "1.0.0",
      description: "Authoritative internal API contract generated from Zod schemas (D32, D38).",
    },
    servers: [{ url: "/v1" }],
    components: {
      schemas: {
        ProblemDetails: zodToJsonSchema(ProblemDetailsSchema),
        Organization: zodToJsonSchema(OrganizationSchema),
        CreateOrganizationRequest: zodToJsonSchema(CreateOrganizationRequestSchema),
        Workspace: zodToJsonSchema(WorkspaceSchema),
        CreateWorkspaceRequest: zodToJsonSchema(CreateWorkspaceRequestSchema),
        WorkspacePolicy: zodToJsonSchema(WorkspacePolicySchema),
        UpdateWorkspacePolicyRequest: zodToJsonSchema(UpdateWorkspacePolicyRequestSchema),
        User: zodToJsonSchema(UserSchema),
        CreateUserRequest: zodToJsonSchema(CreateUserRequestSchema),
        WorkspaceMember: zodToJsonSchema(WorkspaceMemberSchema),
        AddWorkspaceMemberRequest: zodToJsonSchema(AddWorkspaceMemberRequestSchema),
        EthicalWall: zodToJsonSchema(EthicalWallSchema),
        CreateEthicalWallRequest: zodToJsonSchema(CreateEthicalWallRequestSchema),
        AuditEvent: zodToJsonSchema(AuditEventSchema),
        AuthTokenRequest: zodToJsonSchema(AuthTokenRequestSchema),
        AuthTokenResponse: zodToJsonSchema(AuthTokenResponseSchema),
        AuthRefreshRequest: zodToJsonSchema(AuthRefreshRequestSchema),
        MeResponse: zodToJsonSchema(MeResponseSchema),
      },
    },
    paths: {
      "/auth/token": {
        post: {
          summary: "Exchange credentials for access and refresh tokens",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthTokenRequest" } } },
          },
          responses: {
            "200": {
              description: "Tokens issued",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AuthTokenResponse" } } },
            },
            "401": {
              description: "Invalid credentials",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
      "/auth/refresh": {
        post: {
          summary: "Rotate refresh token and issue new access token",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthRefreshRequest" } } },
          },
          responses: {
            "200": {
              description: "Tokens rotated",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AuthTokenResponse" } } },
            },
            "401": {
              description: "Invalid or reused refresh token",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
      "/me": {
        get: {
          summary: "Get current authenticated user profile",
          responses: {
            "200": {
              description: "Authenticated user details",
              content: { "application/json": { schema: { $ref: "#/components/schemas/MeResponse" } } },
            },
            "401": {
              description: "Unauthorized",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
      "/organizations/{id}": {
        get: {
          summary: "Get organization by ID",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "Organization details",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Organization" } } },
            },
            "404": {
              description: "Organization not found",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
      "/workspaces": {
        get: {
          summary: "List workspaces in tenant",
          responses: {
            "200": {
              description: "Workspaces list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/Workspace" } },
                    },
                    required: ["items"],
                  },
                },
              },
            },
            "403": {
              description: "Permission denied",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
        post: {
          summary: "Create Workspace",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWorkspaceRequest" } } },
          },
          responses: {
            "201": {
              description: "Workspace created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Workspace" } } },
            },
            "403": {
              description: "Permission denied",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
      "/workspaces/{id}/members": {
        get: {
          summary: "List workspace members",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "Workspace members list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/WorkspaceMember" } },
                    },
                    required: ["items"],
                  },
                },
              },
            },
            "404": {
              description: "Workspace not found",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
        post: {
          summary: "Add member to workspace",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AddWorkspaceMemberRequest" } } },
          },
          responses: {
            "201": {
              description: "Member added",
              content: { "application/json": { schema: { $ref: "#/components/schemas/WorkspaceMember" } } },
            },
            "404": {
              description: "Workspace not found",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
      "/workspaces/{id}/policy": {
        get: {
          summary: "Get workspace policy",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "Workspace policy",
              content: { "application/json": { schema: { $ref: "#/components/schemas/WorkspacePolicy" } } },
            },
            "404": {
              description: "Workspace not found",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
        patch: {
          summary: "Update workspace policy",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateWorkspacePolicyRequest" } } },
          },
          responses: {
            "200": {
              description: "Updated workspace policy",
              content: { "application/json": { schema: { $ref: "#/components/schemas/WorkspacePolicy" } } },
            },
            "404": {
              description: "Workspace not found",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
      "/audit/events": {
        get: {
          summary: "List Audit Events",
          responses: {
            "200": {
              description: "Audit events list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      events: { type: "array", items: { $ref: "#/components/schemas/AuditEvent" } },
                    },
                    required: ["events"],
                  },
                },
              },
            },
            "403": {
              description: "Permission denied",
              content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
            },
          },
        },
      },
    },
  };
}

