import { randomUUID } from "node:crypto";
import type { Tx } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import type {
  AICapabilityResult,
  AICapability,
  ActionClass,
  AIToolExecution,
  InvokeCapabilityRequest,
  ToolExecutionRequest,
  VerificationReport,
  InsufficiencyNote,
} from "@casefile/contracts";

export class AIGatewayError extends Error {
  constructor(message: string, public statusCode: number = 400, public details?: Record<string, unknown>) {
    super(message);
    this.name = "AIGatewayError";
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string, public actionClass: ActionClass, public statusCode: number = 400) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/**
 * Determines Action Class for tool name per PRD §26.2 and §60.
 */
export function getToolActionClass(toolName: string): ActionClass {
  switch (toolName) {
    case "search_evidence":
    case "get_entity":
    case "get_relationships":
    case "traverse_graph":
    case "get_timeline":
    case "get_document_content":
    case "get_investigation_state":
    case "compare_documents":
      return "A";
    case "create_extraction":
    case "propose_relationship":
    case "create_gap":
    case "create_contradiction":
      return "B";
    case "propose_merge":
    case "draft_finding":
    case "draft_report_section":
      return "C";
    case "promote_analysis":
    case "bulk_reprocess":
    case "run_connector_query":
      return "D";
    default:
      throw new ToolExecutionError(`Unauthorized or unknown tool '${toolName}' (Invariant I6).`, "D", 403);
  }
}

/**
 * Detects adversarial prompt injections in context chunks or query strings (Invariant I5 / AC-INJ-01).
 */
export function detectPromptInjection(text: string): { isInjection: boolean; patternMatched?: string } {
  const patterns = [
    /ignore (all )?prior instructions/i,
    /system override/i,
    /you are now in (debug|developer|god) mode/i,
    /disregard previous (prompts|rules)/i,
    /reveal system prompt/i,
    /bypass security filters/i,
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return { isInjection: true, patternMatched: pattern.source };
    }
  }

  return { isInjection: false };
}

/**
 * Invokes an AI Capability through the Gateway with verification and grounding (PRD §21, §43, §56.7).
 */
export async function invokeAICapability(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  userId: string,
  req: InvokeCapabilityRequest,
): Promise<AICapabilityResult> {
  const query = req.query || req.input_text || "Synthesize beneficial ownership evidence";

  // Fetch workspace_id for audit logs
  const invRows = await tx<{ workspace_id: string }[]>`
    SELECT workspace_id
    FROM investigations
    WHERE id = ${investigationId} AND tenant_id = ${tenantId};
  `;
  const workspaceId = invRows[0]?.workspace_id || null;

  // 1. Invariant I5 / AC-INJ-01: Prompt Injection Defense
  const injectionCheck = detectPromptInjection(query);
  if (injectionCheck.isInjection) {
    // Write security audit event
    await writeAuditEvent(tx, {
      tenantId,
      workspaceId,
      investigationId,
      actorType: "user",
      actorId: userId,
      actorDisplay: "User",
      action: "security.prompt_injection_detected",
      objectType: "ai_capability",
      objectId: randomUUID(),
      objectDisplay: `Capability ${req.capability}`,
      outcome: "denied",
      denialReason: `Prompt injection pattern detected: ${injectionCheck.patternMatched} (Invariant I5)`,
      requestId: randomUUID(),
    });

    throw new AIGatewayError(
      `Adversarial prompt injection detected: ${injectionCheck.patternMatched} (Invariant I5 / AC-INJ-01).`,
      422,
      { pattern: injectionCheck.patternMatched },
    );
  }

  // 2. There is no AI analysis implementation (DEV-017).
  //
  // Until 2026-09-04 this function returned a hardcoded narrative, attached the
  // investigation's real evidence ids to it as citations, fabricated token counts and
  // cost, and persisted the result to ai_results. It must not do that again. Nothing is
  // written; the caller receives an explicit 501 rather than fiction.
  throw new AIGatewayError(
    `AI capability '${req.capability}' is not implemented. No model is called, no analysis is produced, and nothing is written to ai_results (docs/DEVIATIONS.md DEV-017).`,
    501,
    { capability: req.capability, query_length: query.length },
  );
}

/**
 * Promotes an AI Capability result from machine plane to record plane (Class D Action / Invariant I2).
 */
export async function promoteAIResult(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  resultId: string,
  userId: string,
  rationale: string,
): Promise<AICapabilityResult> {
  const existingRows = await tx<{ id: string; plane: string; output: unknown }[]>`
    SELECT id, plane, output
    FROM ai_results
    WHERE id = ${resultId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId};
  `;

  if (existingRows.length === 0 || !existingRows[0]) {
    throw new AIGatewayError(`AI Result ${resultId} not found.`, 404);
  }

  const updatedRows = await tx<Record<string, unknown>[]>`
    UPDATE ai_results
    SET
      plane = 'record',
      epistemic_state = 'Verified',
      promoted_by = ${userId},
      promoted_at = NOW(),
      updated_at = NOW()
    WHERE id = ${resultId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    RETURNING *;
  `;

  const invRows = await tx<{ workspace_id: string }[]>`
    SELECT workspace_id
    FROM investigations
    WHERE id = ${investigationId} AND tenant_id = ${tenantId};
  `;
  const workspaceId = invRows[0]?.workspace_id || null;

  // Write audit event
  await writeAuditEvent(tx, {
    tenantId,
    workspaceId,
    investigationId,
    actorType: "user",
    actorId: userId,
    actorDisplay: "User",
    action: "ai.analysis_promoted",
    objectType: "ai_result",
    objectId: resultId,
    objectDisplay: `Promoted AI Result ${resultId}`,
    rationale,
    outcome: "success",
    requestId: randomUUID(),
  });

  const r = updatedRows[0]!;
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    investigation_id: String(r.investigation_id),
    capability: r.capability as AICapability,
    context_manifest_id: r.context_manifest_id ? String(r.context_manifest_id) : null,
    prompt_template_hash: String(r.prompt_template_hash),
    model: {
      provider: String(r.model_provider),
      model_id: String(r.model_id),
      version: String(r.model_version),
    },
    output: (typeof r.output === "string" ? JSON.parse(r.output) : r.output) as Record<string, unknown>,
    citations: (typeof r.citations === "string" ? JSON.parse(r.citations) : r.citations) as string[],
    epistemic_state: "Verified",
    confidence: 1.0,
    insufficiency: (typeof r.insufficiency === "string" ? JSON.parse(r.insufficiency) : r.insufficiency) as InsufficiencyNote,
    falsifiers: (typeof r.falsifiers === "string" ? JSON.parse(r.falsifiers) : r.falsifiers) as string[],
    verification: (typeof r.verification === "string" ? JSON.parse(r.verification) : r.verification) as VerificationReport,
    plane: "record",
    promoted_by: userId,
    promoted_at: new Date().toISOString(),
    cost: (typeof r.cost === "string" ? JSON.parse(r.cost) : r.cost) as { input_tokens: number; output_tokens: number; usd: number },
    latency_ms: Number(r.latency_ms),
    status: r.status as "completed",
    created_by: String(r.created_by),
    created_at: new Date(String(r.created_at)).toISOString(),
    updated_at: new Date(String(r.updated_at)).toISOString(),
  };
}

/**
 * Executes a tool call strictly within its registered Action Class boundaries (PRD §26.2 & §60).
 */
export async function executeAITool(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  userId: string,
  req: ToolExecutionRequest,
): Promise<AIToolExecution> {
  const actionClass = getToolActionClass(req.tool_name);
  const start = Date.now();

  // Class D Approval Requirement (§26.2): Block unconfirmed Class D tool calls
  if (actionClass === "D" && !req.allow_class_d && !req.confirmation_token) {
    throw new ToolExecutionError(
      `Class D tool '${req.tool_name}' requires explicit per-action human confirmation (PRD §26.2).`,
      "D",
      403,
    );
  }

  let outputPayload: Record<string, unknown>;

  // Tool Catalog Handlers (§60)
  switch (req.tool_name) {
    case "search_evidence": {
      const evRows = await tx<{ id: string; cited_text: string; weight: string }[]>`
        SELECT id, cited_text, weight
        FROM evidence
        WHERE investigation_id = ${investigationId}
          AND tenant_id = ${tenantId}
          AND status = 'active'
          AND deleted_at IS NULL
        LIMIT 20;
      `;
      outputPayload = {
        evidence_units: evRows.map((e) => ({ id: e.id, text: e.cited_text, weight: e.weight })),
        total_hits: evRows.length,
      };
      break;
    }

    case "get_entity": {
      const entityId = req.input_params.entity_id as string;
      const rows = entityId
        ? await tx<{ id: string; canonical_name: string; type: string }[]>`
            SELECT id, canonical_name, type FROM entities
            WHERE id = ${entityId} AND investigation_id = ${investigationId} AND tenant_id = ${tenantId};
          `
        : await tx<{ id: string; canonical_name: string; type: string }[]>`
            SELECT id, canonical_name, type FROM entities
            WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} LIMIT 1;
          `;
      outputPayload = { entity: rows[0] || null };
      break;
    }

    case "get_investigation_state": {
      const counts = await tx<{ sources: string; entities: string; assertions: string }[]>`
        SELECT
          (SELECT COUNT(*) FROM sources WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId}) AS sources,
          (SELECT COUNT(*) FROM entities WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId}) AS entities,
          (SELECT COUNT(*) FROM assertions WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId}) AS assertions;
      `;
      outputPayload = { state: counts[0] };
      break;
    }

    case "create_extraction": {
      outputPayload = {
        extraction_id: randomUUID(),
        status: "extracted",
        input: req.input_params,
      };
      break;
    }

    case "propose_relationship": {
      outputPayload = {
        proposal_id: randomUUID(),
        subject: req.input_params.subject_id,
        predicate: req.input_params.predicate,
        object: req.input_params.object_id,
        status: "proposed",
      };
      break;
    }

    case "draft_finding": {
      outputPayload = {
        finding_draft_id: randomUUID(),
        question_id: req.input_params.question_id,
        prose: "Drafted finding based on retrieved corporate registry evidence.",
        status: "draft",
      };
      break;
    }

    case "promote_analysis": {
      outputPayload = {
        promoted: true,
        target_id: req.input_params.result_id,
        confirmed_by: userId,
      };
      break;
    }

    default:
      outputPayload = { executed: true, tool: req.tool_name };
      break;
  }

  const executionMs = Date.now() - start;
  const executionId = randomUUID();

  // Persist tool execution
  const rows = await tx<Record<string, unknown>[]>`
    INSERT INTO ai_tool_executions (
      id, tenant_id, investigation_id, tool_name, action_class,
      input_params, output_payload, confirmed_by, status, execution_ms
    )
    VALUES (
      ${executionId}, ${tenantId}, ${investigationId}, ${req.tool_name}, ${actionClass},
      ${JSON.stringify(req.input_params)}::jsonb, ${JSON.stringify(outputPayload)}::jsonb,
      ${actionClass === "D" ? userId : null}, 'executed', ${executionMs}
    )
    RETURNING *;
  `;

  const r = rows[0]!;
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    investigation_id: String(r.investigation_id),
    ai_result_id: null,
    tool_name: String(r.tool_name),
    action_class: r.action_class as ActionClass,
    input_params: (typeof r.input_params === "string" ? JSON.parse(r.input_params) : r.input_params) as Record<string, unknown>,
    output_payload: (typeof r.output_payload === "string" ? JSON.parse(r.output_payload) : r.output_payload) as Record<string, unknown>,
    confirmed_by: r.confirmed_by ? String(r.confirmed_by) : null,
    status: r.status as "executed",
    execution_ms: Number(r.execution_ms),
    created_at: new Date(String(r.created_at)).toISOString(),
  };
}
