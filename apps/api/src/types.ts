import type { Tx } from "@casefile/db";
import type { Permission, WorkspaceRole } from "@casefile/policy";
import type { McpCaller } from "@casefile/mcp";

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  sessionId: string;
  roles: WorkspaceRole[];
  mfa: boolean;
  stepUpAt?: string | undefined;
}

export interface RouteConfig {
  permission?: Permission | undefined;
  public?: boolean | undefined;
  authenticated?: boolean | undefined; // self-scoped authenticated routes (e.g. session management)
  requiresStepUp?: boolean | undefined;
  resourceIdParam?: string | undefined; // param name containing target object ID e.g. "id"
  resourceType?: string | undefined;
}

/**
 * The caller of a /mcp request, set by the /mcp auth gate (apps/api/src/mcp/auth.ts, D73, D77)
 * from the OAuth access token or the local no-login user, checked against the database.
 */
export type { McpCaller } from "@casefile/mcp";

declare module "fastify" {
  interface FastifyRequest {
    id: string;
    user?: AuthenticatedUser;
    mcpCaller?: McpCaller;
    tx?: Tx;
    idempotencyKey?: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyContextConfig extends RouteConfig {}
}
