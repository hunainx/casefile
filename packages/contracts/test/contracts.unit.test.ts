import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  generateOpenApiDocument,
  OrganizationSchema,
  WorkspaceSchema,
  UserSchema,
  WorkspaceMemberSchema,
  EthicalWallSchema,
  AuditEventSchema,
  ProblemDetailsSchema,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("packages/contracts — Unit Tests", () => {
  it("generated OpenAPI 3.1 document matches the committed snapshot (D32)", () => {
    const committedSnapshot = readFileSync(
      resolve(__dirname, "../openapi.json"),
      "utf-8",
    );
    const expected = JSON.parse(committedSnapshot);
    const actual = generateOpenApiDocument();

    expect(actual).toEqual(expected);
  });

  describe("Schema Validations", () => {
    it("validates RFC 9457 Problem Details schema", () => {
      const validProblem = {
        type: "https://docs.casefile.com/errors/permission-denied",
        title: "Permission Denied",
        status: 403,
        detail: "Access denied",
        instance: "/v1/workspaces/11111111-1111-1111-1111-111111111111",
        request_id: "req_test_1",
      };

      const parsed = ProblemDetailsSchema.parse(validProblem);
      expect(parsed.status).toBe(403);
      expect(parsed.title).toBe("Permission Denied");

      expect(() =>
        ProblemDetailsSchema.parse({
          type: "not-a-url",
          title: "Bad",
          status: 403,
        }),
      ).toThrow();
    });

    it("validates Organization & User schemas", () => {
      const validOrg = {
        id: "11111111-1111-1111-1111-111111111111",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        name: "Acme Legal Corp",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      expect(OrganizationSchema.parse(validOrg).name).toBe("Acme Legal Corp");
      expect(() => OrganizationSchema.parse({ id: "invalid-uuid" })).toThrow();

      const validUser = {
        id: "44444444-4444-4444-4444-444444444444",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        email: "alice@acme.example",
        name: "Alice",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      expect(UserSchema.parse(validUser).email).toBe("alice@acme.example");
    });

    it("validates Workspace & WorkspaceMember schemas", () => {
      const validWs = {
        id: "22222222-2222-2222-2222-222222222222",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        name: "Financial Crimes",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      expect(WorkspaceSchema.parse(validWs).name).toBe("Financial Crimes");

      const validMember = {
        id: "33333333-3333-3333-3333-333333333333",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        workspace_id: "22222222-2222-2222-2222-222222222222",
        user_id: "44444444-4444-4444-4444-444444444444",
        role: "lead_inv",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      expect(WorkspaceMemberSchema.parse(validMember).role).toBe("lead_inv");
      expect(() =>
        WorkspaceMemberSchema.parse({ ...validMember, role: "invalid_role" }),
      ).toThrow();
    });

    it("validates Ethical Wall schema", () => {
      const validWall = {
        id: "55555555-5555-5555-5555-555555555555",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        workspace_id: "22222222-2222-2222-2222-222222222222",
        subject_type: "user",
        subject_id: "44444444-4444-4444-4444-444444444444",
        investigation_id: "66666666-6666-6666-6666-666666666666",
        reason: "Matter conflict of interest",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      expect(EthicalWallSchema.parse(validWall).reason).toBe("Matter conflict of interest");
    });

    it("validates Audit Event schema with ULID and sequence", () => {
      const validEvent = {
        id: "01HM0000000000000000000001",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        seq: 1,
        timestamp: new Date().toISOString(),
        actor_type: "user",
        actor_id: "44444444-4444-4444-4444-444444444444",
        actor_display: "Alice",
        action: "workspace.create",
        object_type: "workspace",
        object_id: "22222222-2222-2222-2222-222222222222",
        object_display: "Financial Crimes",
        request_id: "req_123",
        outcome: "success",
        prev_hash: "0".repeat(64),
        hash: "a".repeat(64),
      };

      const parsed = AuditEventSchema.parse(validEvent);
      expect(parsed.id).toBe("01HM0000000000000000000001");
      expect(parsed.seq).toBe(1);
    });
  });
});
