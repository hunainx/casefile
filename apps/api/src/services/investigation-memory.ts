import { randomUUID } from "node:crypto";
import type { Tx } from "@casefile/db";
import type {
  ContextManifest,
  Tier1DefinitionMemory,
  Tier2StateMemory,
  Tier3WorkingMemory,
  Tier4RetrievedChunk,
  OmissionRecord,
  TokenBudget,
  AssembleManifestRequest,
} from "@casefile/contracts";

/**
 * Estimates token count based on standard 4 chars per token rule
 */
export function estimateTokens(text: string | object): number {
  const str = typeof text === "string" ? text : JSON.stringify(text);
  return Math.ceil(str.length / 4);
}

/**
 * Fetches Tier 1 (Definition Memory) for an investigation
 */
export async function getTier1DefinitionMemory(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<Tier1DefinitionMemory> {
  const [invRows, questionRows] = await Promise.all([
    tx<{ objective: string | null; scope: unknown; sensitivity: string }[]>`
      SELECT objective, scope, sensitivity
      FROM investigations
      WHERE id = ${investigationId} AND tenant_id = ${tenantId} AND deleted_at IS NULL;
    `,
    tx<{ id: string; question: string; sequence: number; materiality: string; status: string }[]>`
      SELECT id, text AS question, sequence, materiality, status
      FROM investigation_questions
      WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND deleted_at IS NULL
      ORDER BY sequence ASC;
    `,
  ]);

  const inv = invRows[0];
  let rawScopeObj: { subjects?: { descriptor: string; subject_type: string; role?: string }[] } = {};
  if (typeof inv?.scope === "string") {
    try {
      rawScopeObj = JSON.parse(inv.scope);
    } catch {
      rawScopeObj = {};
    }
  } else if (typeof inv?.scope === "object" && inv?.scope !== null) {
    rawScopeObj = inv.scope as { subjects?: { descriptor: string; subject_type: string; role?: string }[] };
  }

  const scopeSubjects = (rawScopeObj?.subjects || []).map((s) => ({
    descriptor: s.descriptor,
    subject_type: s.subject_type,
    role: s.role || "primary_subject",
  }));

  return {
    objective: inv?.objective || "Investigation Objective Not Defined",
    questions: questionRows.map((q) => ({
      id: q.id,
      question: q.question,
      sequence: q.sequence,
      materiality: q.materiality,
      status: q.status,
    })),
    scope_subjects: scopeSubjects,
    classification: inv?.sensitivity || "restricted",
  };
}

/**
 * Fetches Tier 2 (State Memory) for an investigation
 */
export async function getTier2StateMemory(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<Tier2StateMemory> {
  const [entities, findings, contradictions, gaps, corpusCounts] = await Promise.all([
    tx<{ id: string; canonical_name: string; type: string; is_focal: boolean; confidence: string | number }[]>`
      SELECT id, canonical_name, type, is_focal, confidence
      FROM entities
      WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND deleted_at IS NULL
      ORDER BY is_focal DESC, confidence DESC
      LIMIT 25;
    `,
    tx<{ id: string; predicate: string; object_literal: string | null; epistemic_state: string; verified_by: string | null }[]>`
      SELECT id, predicate, object_literal, epistemic_state, reviewed_by AS verified_by
      FROM assertions
      WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND epistemic_state = 'Verified' AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50;
    `,
    tx<{ id: string; severity: string; details: unknown }[]>`
      SELECT id, severity, details
      FROM contradiction_alerts
      WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 20;
    `,
    tx<{ id: string; id_q: string; question: string }[]>`
      SELECT id, id AS id_q, text AS question
      FROM investigation_questions
      WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND status != 'answered' AND deleted_at IS NULL
      LIMIT 20;
    `,
    tx<{ total_sources: string; total_chunks: string; total_entities: string; total_assertions: string }[]>`
      SELECT
        (SELECT COUNT(*) FROM sources WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND withdrawn_at IS NULL) AS total_sources,
        (SELECT COUNT(*) FROM chunks WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId}) AS total_chunks,
        (SELECT COUNT(*) FROM entities WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND deleted_at IS NULL) AS total_entities,
        (SELECT COUNT(*) FROM assertions WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND deleted_at IS NULL) AS total_assertions;
    `,
  ]);

  const counts = corpusCounts[0];
  const totalSources = Number(counts?.total_sources || 0);
  const totalChunks = Number(counts?.total_chunks || 0);
  const totalEntities = Number(counts?.total_entities || 0);
  const totalAssertions = Number(counts?.total_assertions || 0);

  return {
    focal_entities: entities.map((e) => ({
      id: e.id,
      canonical_name: e.canonical_name,
      type: e.type,
      is_focal: e.is_focal,
      confidence: Number(e.confidence),
      mention_count: 1,
    })),
    verified_findings: findings.map((f) => ({
      id: f.id,
      statement: `${f.predicate}: ${f.object_literal || "verified attribute"}`,
      epistemic_state: f.epistemic_state,
      verified_by: f.verified_by || null,
    })),
    open_contradictions: contradictions.map((c) => ({
      id: c.id,
      severity: c.severity,
      details: (c.details as Record<string, unknown>) || {},
    })),
    open_gaps: gaps.map((g) => ({
      id: g.id,
      question_id: g.id_q,
      description: `Unresolved inquiry: ${g.question}`,
      status: "open",
    })),
    active_hypotheses: [],
    corpus_profile: {
      total_sources: totalSources,
      total_chunks: totalChunks,
      total_entities: totalEntities,
      total_assertions: totalAssertions,
      coverage_ratio: totalSources > 0 ? 1.0 : 0.0,
    },
  };
}

/**
 * Assembles deterministic Context Manifest across all 4 tiers with token budgeting & omission tracking.
 */
export async function assembleContextManifest(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  userId: string,
  req: AssembleManifestRequest,
): Promise<ContextManifest> {
  const totalBudget = req.custom_token_limit || 200000;
  const sysInstructionsTokens = 3000;
  const responseReserveTokens = 15000;
  const tier1Budget = 4000;
  const tier2Budget = 20000;
  const tier3Budget = 8000;
  const tier4Budget = totalBudget - sysInstructionsTokens - responseReserveTokens - tier1Budget - tier2Budget - tier3Budget; // ~150k

  const omitted: OmissionRecord[] = [];

  // 1. Fetch Tier 1
  const tier1 = await getTier1DefinitionMemory(tx, tenantId, investigationId);
  const tier1Tokens = estimateTokens(tier1);

  // 2. Fetch Tier 2
  const tier2 = await getTier2StateMemory(tx, tenantId, investigationId);
  const tier2Tokens = estimateTokens(tier2);

  // 3. Fetch Tier 3 (Working Memory / recent searches)
  const recentSearchRows = await tx<{ query: string }[]>`
    SELECT query
    FROM search_history
    WHERE investigation_id = ${investigationId} AND tenant_id = ${tenantId} AND user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 10;
  `;
  const tier3: Tier3WorkingMemory = {
    current_view: req.working_context || {},
    recent_searches: recentSearchRows.map((s) => s.query),
    recent_exchanges: [],
    recent_decisions: [],
    session_ttl_minutes: 60,
  };
  const tier3Tokens = estimateTokens(tier3);

  // 4. Fetch Tier 4 (Retrieved Evidence Chunks)
  const tier4: Tier4RetrievedChunk[] = [];
  let tier4Tokens = 0;

  if (req.target_chunk_ids && req.target_chunk_ids.length > 0) {
    const chunkRows = await tx<{ id: string; source_id: string; text: string; contextual_header: string | null }[]>`
      SELECT c.id, a.source_id, COALESCE(c.text, cb.text) AS text, c.contextual_header
      FROM chunks c
      JOIN content_documents cd ON cd.id = c.content_document_id
      JOIN artifacts a ON a.id = cd.artifact_id
      -- Text stored once (D94): a chunk with no text of its own is its one block.
      LEFT JOIN content_blocks cb ON c.text IS NULL AND cb.id = c.block_ids[1] AND cb.tenant_id = c.tenant_id
      WHERE c.id = ANY(${req.target_chunk_ids}) AND c.investigation_id = ${investigationId} AND c.tenant_id = ${tenantId};
    `;

    for (const c of chunkRows) {
      const chunkTokens = estimateTokens(c.text);
      if (tier4Tokens + chunkTokens <= tier4Budget) {
        tier4.push({
          chunk_id: c.id,
          source_id: c.source_id,
          text: c.text,
          locator: c.contextual_header || null,
          relevance_score: 0.95,
          retrieval_mode: "targeted",
        });
        tier4Tokens += chunkTokens;
      } else {
        // Record Omission per PRD §13.3
        omitted.push({
          item_id: c.id,
          item_type: "chunk",
          reason: "token_budget",
          detail: `Chunk ${c.id} omitted: exceeded Tier 4 token budget allocation (${tier4Budget} tokens).`,
        });
      }
    }
  }

  const totalUsed = sysInstructionsTokens + tier1Tokens + tier2Tokens + tier3Tokens + tier4Tokens + responseReserveTokens;
  const remaining = Math.max(0, totalBudget - totalUsed);

  const tokenBudget: TokenBudget = {
    total_allocated: totalBudget,
    system_instructions: sysInstructionsTokens,
    tier1_used: tier1Tokens,
    tier2_used: tier2Tokens,
    tier3_used: tier3Tokens,
    tier4_used: tier4Tokens,
    response_reserve: responseReserveTokens,
    total_used: totalUsed,
    remaining: remaining,
  };

  const manifestId = randomUUID();
  const assembledAt = new Date().toISOString();

  const manifest: ContextManifest = {
    id: manifestId,
    investigation_id: investigationId,
    operation: req.operation,
    tier1,
    tier2,
    tier3,
    tier4,
    token_budget: tokenBudget,
    omitted,
    model_target: req.model_target || "default-reasoning-v1",
    assembled_at: assembledAt,
  };

  // Persist Context Manifest
  await tx`
    INSERT INTO context_manifests (
      id, tenant_id, investigation_id, operation, tier1,
      tier2, tier3, tier4, token_budget, omitted,
      model_target, assembled_at, created_by
    )
    VALUES (
      ${manifestId}, ${tenantId}, ${investigationId}, ${req.operation},
      ${JSON.stringify(tier1)}::jsonb, ${JSON.stringify(tier2)}::jsonb,
      ${JSON.stringify(tier3)}::jsonb, ${JSON.stringify(tier4)}::jsonb,
      ${JSON.stringify(tokenBudget)}::jsonb, ${JSON.stringify(omitted)}::jsonb,
      ${req.model_target || "default-reasoning-v1"}, ${assembledAt}::timestamptz, ${userId}
    );
  `;

  return manifest;
}
