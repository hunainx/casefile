import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Tx } from "@casefile/db";
import { createPolicyDenialAuditEvent } from "@casefile/policy";
import { writeAuditEvent } from "@casefile/audit";
import { decideTool, isMcpToolName, type McpCaller, type McpToolName } from "./access.js";
import {
  type MatterContext,
  MatterStatusSchema,
  handleMatterStatus,
  ListInvestigationsSchema,
  handleListInvestigations,
  GetInvestigationSchema,
  handleGetInvestigation,
  ListDocumentsSchema,
  handleListDocuments,
  GetSourceSchema,
  handleGetSource,
  GetDocumentPageSchema,
  handleGetDocumentPage,
  GetDownloadLinkSchema,
  handleGetDownloadLink,
  GetEvidenceSchema,
  handleGetEvidence,
  SearchToolSchema,
  handleSearch,
} from "./tools.js";

/**
 * The 9 read-only tools. guardrails/injection.spec.ts checks that these names are exactly the
 * keys of MCP_TOOL_PERMISSIONS (so none can be listed without a role rule) and that none is a
 * PRD section 60 Class E name.
 */
export const MCP_TOOLS: Tool[] = [
  {
    name: "matter_status",
    description: "Returns operational metadata for the matter: investigation name, status, source counts, vector availability (false), and uncomputed search signals.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_investigations",
    description: "Lists the investigation this matter deployment serves (one deployment serves one matter).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_investigation",
    description: "Retrieves metadata and status for an investigation.",
    inputSchema: {
      type: "object",
      properties: {
        investigation_id: { type: "string", description: "Investigation UUID (optional; only this matter's investigation exists here)" },
      },
    },
  },
  {
    name: "list_documents",
    description: "Lists all ingested source documents for the investigation.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 50 },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "get_source",
    description: "Retrieves source document metadata, content document structure, and content blocks.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: { type: "string", description: "Source document UUID" },
      },
      required: ["source_id"],
    },
  },
  {
    name: "get_document_page",
    description: "Retrieves exact page text with bounding-box coordinate locators for a document page.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Document UUID" },
        page: { type: "integer", description: "1-indexed page number" },
      },
      required: ["document_id", "page"],
    },
  },
  {
    name: "get_download_link",
    description: "Generates a time-limited signed Google Cloud Storage download link for a source document.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Source document UUID" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "get_evidence",
    description: "Retrieves a specific evidence record with cited text span, cryptographic span hash, locator, and verification status.",
    inputSchema: {
      type: "object",
      properties: {
        evidence_id: { type: "string", description: "Evidence record UUID" },
      },
      required: ["evidence_id"],
    },
  },
  {
    name: "search",
    description: "Executes lexical keyword search with fuzzy OCR matching and entity alias expansion across investigation chunks. Exposes transparent scoring breakdown and lists uncomputed signals.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        mode: { type: "string", enum: ["keyword", "exact", "entity", "hybrid"], default: "keyword" },
        limit: { type: "integer", default: 20 },
        offset: { type: "integer", default: 0 },
        filters: {
          type: "object",
          properties: {
            source_id: { type: "string" },
            document_type: { type: "string" },
            custodian: { type: "string" },
          },
        },
      },
      required: ["query"],
    },
  },
];

/** Where a server's tool calls run, and who is calling. */
export interface MatterToolHost {
  /**
   * The caller, read inside the call's transaction. /mcp returns the caller its auth gate
   * established for this request; the stdio CLI re-runs the eligibility check on every call.
   */
  caller(tx: Tx): Promise<McpCaller>;
  /** Runs `fn` in the transaction whose commit the reply waits for (D64). */
  inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** A request ID for the audit rows. */
  requestId(): string;
  /** An audit row could not be written: the host must fail the request, not send its output. */
  onAuditFailure(err: unknown): void;
}

/** Tool arguments go into the audit row; an oversized object is recorded by size only. */
function auditableArguments(args: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(args);
  return json.length <= 4096 ? args : { _truncated: true, _json_length: json.length };
}

/**
 * Registers tools/list and tools/call on an MCP SDK server (D74, D77):
 * - tools/list shows only the tools the caller may use;
 * - a refused call writes the existing policy-denial audit event and answers isError;
 * - an allowed call runs in a savepoint and writes exactly one mcp.tool_call audit row with the
 *   real user as actor and the caller's auth mode, whether the tool succeeded or failed;
 * - an audit row that cannot be written fails the request through onAuditFailure.
 */
export function registerMatterTools(server: Server, host: MatterToolHost): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const requestId = host.requestId();
    return host.inTx(async (tx) => {
      const caller = await host.caller(tx);
      return { tools: MCP_TOOLS.filter((t) => isMcpToolName(t.name) && decideTool(t.name, caller, requestId).allowed) };
    });
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = request.params.arguments || {};
    const requestId = host.requestId();

    if (!isMcpToolName(toolName)) {
      // A plain Error carrying a JSON-RPC code: the SDK copies code and message into
      // the reply as they are (McpError would prefix "MCP error -32601: ").
      throw Object.assign(new Error(`Method not found: '${toolName}'`), { code: ErrorCode.MethodNotFound });
    }

    return host.inTx(async (tx) => {
      const caller = await host.caller(tx);
      const marks = { client_id: caller.clientId, auth_mode: caller.authMode };
      const decision = decideTool(toolName, caller, requestId);
      if (!decision.allowed) {
        // The existing policy-denial audit event (REQ-M-AUDIT-006), in the call's transaction.
        const denial = createPolicyDenialAuditEvent(
          {
            tenantId: caller.tenantId,
            userId: caller.userId,
            permission: decision.permission,
            workspaceId: caller.workspaceId,
            workspaceRole: caller.effectiveRole,
            investigationId: caller.investigationId,
            requestId,
            targetObjectType: "mcp_tool",
          },
          decision.result,
        );
        try {
          await writeAuditEvent(tx, {
            ...denial,
            actorDisplay: actorDisplay(caller),
            sessionId: caller.sessionId,
            after: { tool: toolName, ...marks },
          });
        } catch (err) {
          host.onAuditFailure(err);
          throw err;
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Permission denied: your role on this matter (${caller.effectiveRole}) does not allow ${toolName} (${decision.permission}: ${decision.result.outcome}).`,
            },
          ],
        };
      }

      const ctx: MatterContext = {
        tenantId: caller.tenantId,
        investigationId: caller.investigationId,
        userId: caller.userId,
        roles: [caller.effectiveRole],
      };

      // The tool runs in a savepoint: if its SQL fails, only the savepoint rolls back and the
      // audit row below is still written and committed.
      let result: unknown;
      let toolError: unknown;
      try {
        result = await tx.savepoint((sp) => runTool(toolName, sp, ctx, toolArgs));
      } catch (err) {
        toolError = err;
      }

      try {
        await writeAuditEvent(tx, {
          tenantId: caller.tenantId,
          workspaceId: caller.workspaceId,
          investigationId: caller.investigationId,
          actorType: "user",
          actorId: caller.userId,
          actorDisplay: actorDisplay(caller),
          sessionId: caller.sessionId,
          action: "mcp.tool_call",
          objectType: "mcp_tool",
          objectId: caller.investigationId,
          objectDisplay: toolName,
          after: {
            tool: toolName,
            arguments: auditableArguments(toolArgs),
            ...marks,
            ...(toolError !== undefined ? { error: toolError instanceof Error ? toolError.message : String(toolError) } : {}),
          },
          requestId,
          outcome: toolError === undefined ? "success" : "failure",
        });
      } catch (err) {
        host.onAuditFailure(err);
        throw err;
      }

      if (toolError !== undefined) {
        const message = toolError instanceof Error ? toolError.message : String(toolError);
        return { isError: true, content: [{ type: "text" as const, text: `Tool execution error: ${message}` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
  });
}

/** "MCP (claude.ai)" for an OAuth connection; "MCP (stdio)" or the local marker otherwise. */
function actorDisplay(caller: McpCaller): string {
  return `MCP (${caller.clientId ? new URL(caller.clientId).host : caller.authMode})`;
}

/** Parses the arguments and runs one of the 9 read-only tools. */
async function runTool(toolName: McpToolName, tx: Tx, ctx: MatterContext, toolArgs: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "matter_status":
      MatterStatusSchema.parse(toolArgs);
      return handleMatterStatus(tx, ctx);
    case "list_investigations":
      ListInvestigationsSchema.parse(toolArgs);
      return handleListInvestigations(tx, ctx);
    case "get_investigation":
      return handleGetInvestigation(tx, ctx, GetInvestigationSchema.parse(toolArgs));
    case "list_documents":
      return handleListDocuments(tx, ctx, ListDocumentsSchema.parse(toolArgs));
    case "get_source":
      return handleGetSource(tx, ctx, GetSourceSchema.parse(toolArgs));
    case "get_document_page":
      return handleGetDocumentPage(tx, ctx, GetDocumentPageSchema.parse(toolArgs));
    case "get_download_link":
      return handleGetDownloadLink(tx, ctx, GetDownloadLinkSchema.parse(toolArgs));
    case "get_evidence":
      return handleGetEvidence(tx, ctx, GetEvidenceSchema.parse(toolArgs));
    case "search":
      return handleSearch(tx, ctx, SearchToolSchema.parse(toolArgs));
  }
}
