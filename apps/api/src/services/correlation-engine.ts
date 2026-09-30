import { randomUUID } from "node:crypto";
import type { Tx } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import type {
  Contradiction,
  ContradictionSeverity,
  ContradictionStatus,
  AdjudicateContradictionRequest,
  SuppressionRule,
  ResearchGap,
  GapType,
  GapPriority,
  GapStatus,
  CloseGapRequest,
  AcceptGapAsUnresolvableRequest,
} from "@casefile/contracts";

export class CorrelationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CorrelationError";
  }
}

// ── Temporal Comparison & Precision Normalizer (PRD §18.1 / AC-CON-01, AC-CON-02)
export interface ParsedTemporal {
  raw: string;
  precision: "year" | "month" | "day";
  year: number;
  month?: number; // 1-12
  day?: number;   // 1-31
}

export function parseTemporalString(val: string): ParsedTemporal | null {
  const clean = val.trim().toLowerCase();

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    return {
      raw: val,
      precision: "day",
      year: parseInt(isoMatch[1], 10),
      month: parseInt(isoMatch[2], 10),
      day: parseInt(isoMatch[3], 10),
    };
  }

  // 2. Day Month Year: e.g. "3 March 2019" or "03 March 2019"
  const dmyMatch = clean.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (dmyMatch && dmyMatch[1] && dmyMatch[2] && dmyMatch[3]) {
    const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const monthShorts = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let m = monthNames.indexOf(dmyMatch[2]) + 1;
    if (m === 0) m = monthShorts.indexOf(dmyMatch[2]) + 1;

    if (m > 0) {
      return {
        raw: val,
        precision: "day",
        year: parseInt(dmyMatch[3], 10),
        month: m,
        day: parseInt(dmyMatch[1], 10),
      };
    }
  }

  // 3. Month Year: e.g. "March 2019" or "2019-03"
  const myMatch = clean.match(/^([a-z]+)\s+(\d{4})$/);
  if (myMatch && myMatch[1] && myMatch[2]) {
    const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const monthShorts = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let m = monthNames.indexOf(myMatch[1]) + 1;
    if (m === 0) m = monthShorts.indexOf(myMatch[1]) + 1;

    if (m > 0) {
      return {
        raw: val,
        precision: "month",
        year: parseInt(myMatch[2], 10),
        month: m,
      };
    }
  }

  const isoMonthMatch = clean.match(/^(\d{4})-(\d{2})$/);
  if (isoMonthMatch && isoMonthMatch[1] && isoMonthMatch[2]) {
    return {
      raw: val,
      precision: "month",
      year: parseInt(isoMonthMatch[1], 10),
      month: parseInt(isoMonthMatch[2], 10),
    };
  }

  // 4. Year only: e.g. "2019"
  const yearMatch = clean.match(/^(\d{4})$/);
  if (yearMatch && yearMatch[1]) {
    return {
      raw: val,
      precision: "year",
      year: parseInt(yearMatch[1], 10),
    };
  }

  return null;
}

/**
 * Compares two temporal expressions.
 * Returns true if contradictory, false if compatible or precision differences (AC-CON-01 / AC-CON-02).
 */
export function areTemporalValuesContradictory(valA: string, valB: string): boolean {
  const tA = parseTemporalString(valA);
  const tB = parseTemporalString(valB);

  if (!tA || !tB) {
    // If not parseable as dates, check exact equality
    return valA.trim().toLowerCase() !== valB.trim().toLowerCase();
  }

  // Years must match
  if (tA.year !== tB.year) {
    return true;
  }

  // If one is year-only, they are compatible (precision difference)
  if (tA.precision === "year" || tB.precision === "year") {
    return false;
  }

  // Months must match
  if (tA.month !== tB.month) {
    return true;
  }

  // If one is month-only and the other is day, they are compatible (precision difference - AC-CON-01)
  if (tA.precision === "month" || tB.precision === "month") {
    return false;
  }

  // Both are day level: days must match (AC-CON-02)
  return tA.day !== tB.day;
}

// ── Contradiction Engine (PRD §24) ──────────────────────────────────────────

/**
 * Runs contradiction detection over assertion pairs in an investigation.
 */
function parsePossibleJson(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function extractTemporalString(val: unknown): string | null {
  if (!val) return null;
  const parsed = parsePossibleJson(val);
  if (typeof parsed === "string") return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.raw === "string") return obj.raw;
    if (typeof obj.date === "string") return obj.date;
    if (typeof obj.value === "string") return obj.value;
  }
  return null;
}

function extractLiteralValue(val: unknown): string | null {
  if (!val) return null;
  const parsed = parsePossibleJson(val);
  if (typeof parsed === "string") return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.value === "string") return String(obj.value);
    if (typeof obj.val === "string") return String(obj.val);
    if (typeof obj.raw === "string") return String(obj.raw);
    if (typeof obj.percentage === "string") return String(obj.percentage);
  }
  return null;
}

/**
 * Runs contradiction detection over assertion pairs in an investigation.
 */
export async function runContradictionDetection(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<Contradiction[]> {
  // 1. Fetch active suppression rules for this investigation
  const suppressionRows = await tx<{ id: string; assertion_pair: unknown }[]>`
    SELECT id, assertion_pair
    FROM suppression_rules
    WHERE investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
      AND active = TRUE;
  `;

  const suppressedPairs = new Set<string>();
  for (const s of suppressionRows) {
    const pair = s.assertion_pair as { assertion_a_id?: string; assertion_b_id?: string } | undefined;
    if (pair?.assertion_a_id && pair?.assertion_b_id) {
      suppressedPairs.add(`${pair.assertion_a_id}:${pair.assertion_b_id}`);
      suppressedPairs.add(`${pair.assertion_b_id}:${pair.assertion_a_id}`);
    }
  }

  // 1b. Fetch existing contradictions so we don't duplicate
  const existingRows = await tx<{ assertion_a_id: string; assertion_b_id: string }[]>`
    SELECT assertion_a_id, assertion_b_id
    FROM contradictions
    WHERE investigation_id = ${investigationId}
      AND tenant_id = ${tenantId};
  `;

  const existingPairs = new Set<string>();
  for (const c of existingRows) {
    existingPairs.add(`${c.assertion_a_id}:${c.assertion_b_id}`);
    existingPairs.add(`${c.assertion_b_id}:${c.assertion_a_id}`);
  }

  // 2. Fetch active assertions with their evidence links
  const assertions = await tx<{
    id: string;
    subject_id: string;
    kind: string;
    predicate: string;
    object_literal: unknown;
    valid_from: unknown;
    valid_to: unknown;
    epistemic_state: string;
    confidence: number;
    evidence_ids: string[];
  }[]>`
    SELECT
      a.id,
      a.subject_id,
      a.kind,
      a.predicate,
      a.object_literal,
      a.valid_from,
      a.valid_to,
      a.epistemic_state,
      a.confidence,
      a.evidence_ids
    FROM assertions a
    WHERE a.investigation_id = ${investigationId}
      AND a.tenant_id = ${tenantId}
      AND a.deleted_at IS NULL
    ORDER BY a.created_at ASC;
  `;

  const newContradictions: Contradiction[] = [];

  // 3. Pairwise comparison for conflicts
  for (let i = 0; i < assertions.length; i++) {
    for (let j = i + 1; j < assertions.length; j++) {
      const a = assertions[i]!;
      const b = assertions[j]!;

      // Check suppression rule or existing contradiction
      if (suppressedPairs.has(`${a.id}:${b.id}`) || existingPairs.has(`${a.id}:${b.id}`)) {
        continue;
      }

      // Check temporal conflicts on same subject/predicate (AC-CON-01 / AC-CON-02)
      const dateA = extractTemporalString(a.valid_from);
      const dateB = extractTemporalString(b.valid_from);

      if (
        a.subject_id === b.subject_id &&
        a.predicate === b.predicate &&
        dateA &&
        dateB
      ) {
        const isConflict = areTemporalValuesContradictory(dateA, dateB);
        if (isConflict) {
          const isCritical = a.epistemic_state === "Verified" || b.epistemic_state === "Verified";
          const severity: ContradictionSeverity = isCritical ? "critical" : "high";

          const contradiction = await persistContradiction(tx, tenantId, investigationId, {
            detector: "temporal_conflict",
            detector_class: "deterministic",
            subtype: "event_date_divergence",
            assertion_a_id: a.id,
            assertion_b_id: b.id,
            evidence_a_ids: Array.isArray(a.evidence_ids) ? a.evidence_ids : [],
            evidence_b_ids: Array.isArray(b.evidence_ids) ? b.evidence_ids : [],
            description: `Conflicting event dates recorded for ${a.predicate || "event"}: '${dateA}' vs '${dateB}'.`,
            severity,
            severity_basis: isCritical
              ? "Contradicts an assertion with Verified epistemic state (PRD §24.4)."
              : "Direct temporal divergence on primary subject.",
          });

          newContradictions.push(contradiction);
        }
      }

      // Check exclusivity/ownership conflicts (e.g. 100% vs 62% ownership)
      const valA = extractLiteralValue(a.object_literal);
      const valB = extractLiteralValue(b.object_literal);

      if (
        a.subject_id === b.subject_id &&
        a.predicate === b.predicate &&
        valA &&
        valB &&
        valA !== valB
      ) {
        const isCritical = a.epistemic_state === "Verified" || b.epistemic_state === "Verified";
        const contradiction = await persistContradiction(tx, tenantId, investigationId, {
          detector: "exclusivity_conflict",
          detector_class: "deterministic",
          subtype: "shareholding_percentage_conflict",
          assertion_a_id: a.id,
          assertion_b_id: b.id,
          evidence_a_ids: Array.isArray(a.evidence_ids) ? a.evidence_ids : [],
          evidence_b_ids: Array.isArray(b.evidence_ids) ? b.evidence_ids : [],
          description: `Mutually exclusive shareholding percentages asserted for entity: '${valA}' vs '${valB}'.`,
          severity: isCritical ? "critical" : "high",
          severity_basis: "Conflicting legal ownership totals for primary target entity.",
        });

        newContradictions.push(contradiction);
      }
    }
  }

  return newContradictions;
}

/**
 * Persists a detected contradiction in PostgreSQL.
 */
async function persistContradiction(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  data: {
    detector: string;
    detector_class: "deterministic" | "semantic" | "hybrid";
    subtype: string;
    assertion_a_id: string;
    assertion_b_id: string;
    evidence_a_ids: string[];
    evidence_b_ids: string[];
    description: string;
    severity: ContradictionSeverity;
    severity_basis: string;
  },
): Promise<Contradiction> {
  const id = randomUUID();
  const rows = await tx<Record<string, unknown>[]>`
    INSERT INTO contradictions (
      id, tenant_id, investigation_id, detector, detector_class, subtype,
      assertion_a_id, assertion_b_id, evidence_a_ids, evidence_b_ids,
      description, severity, severity_basis, status
    )
    VALUES (
      ${id}, ${tenantId}, ${investigationId}, ${data.detector}, ${data.detector_class}, ${data.subtype},
      ${data.assertion_a_id}, ${data.assertion_b_id},
      ${JSON.stringify(data.evidence_a_ids)}::jsonb, ${JSON.stringify(data.evidence_b_ids)}::jsonb,
      ${data.description}, ${data.severity}, ${data.severity_basis}, 'open'
    )
    RETURNING *;
  `;

  return mapContradictionRow(rows[0]!);
}

/**
 * Adjudicates a contradiction with required rationale (PRD §24.5 / AC-CON-03, AC-CON-04).
 */
export async function adjudicateContradiction(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  contradictionId: string,
  userId: string,
  req: AdjudicateContradictionRequest,
): Promise<Contradiction> {
  if (!req.rationale || req.rationale.trim().length === 0) {
    throw new CorrelationError("Adjudication rationale is mandatory (PRD §24.5 / AC-CON-03).", 400);
  }

  const existingRows = await tx<{ id: string; assertion_a_id: string; assertion_b_id: string; status: string }[]>`
    SELECT id, assertion_a_id, assertion_b_id, status
    FROM contradictions
    WHERE id = ${contradictionId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId};
  `;

  if (existingRows.length === 0 || !existingRows[0]) {
    throw new CorrelationError(`Contradiction ${contradictionId} not found.`, 404);
  }

  const c = existingRows[0];
  let suppressionRuleId: string | null = null;

  // Create persistent suppression rule if false_positive or explicitly requested (AC-CON-04)
  if (req.resolution_type === "false_positive" || req.create_suppression_rule) {
    suppressionRuleId = randomUUID();
    await tx`
      INSERT INTO suppression_rules (
        id, tenant_id, investigation_id, rule_type, assertion_pair, rationale, active, created_by
      )
      VALUES (
        ${suppressionRuleId}, ${tenantId}, ${investigationId}, 'assertion_pair',
        ${JSON.stringify({ assertion_a_id: c.assertion_a_id, assertion_b_id: c.assertion_b_id })}::jsonb,
        ${req.rationale}, TRUE, ${userId}
      );
    `;
  }

  let finalStatus: ContradictionStatus = "resolved";
  if (req.resolution_type === "irreconcilable") {
    finalStatus = "irreconcilable";
  } else if (req.resolution_type === "false_positive") {
    finalStatus = "dismissed";
  }

  const resolution = {
    type: req.resolution_type,
    rationale: req.rationale,
    resolved_by: userId,
    resolved_at: new Date().toISOString(),
  };

  const updatedRows = await tx<Record<string, unknown>[]>`
    UPDATE contradictions
    SET
      status = ${finalStatus},
      resolution = ${JSON.stringify(resolution)}::jsonb,
      suppression_rule_id = ${suppressionRuleId},
      updated_at = NOW()
    WHERE id = ${contradictionId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    RETURNING *;
  `;

  // Fetch workspace_id for audit
  const invRows = await tx<{ workspace_id: string }[]>`
    SELECT workspace_id FROM investigations WHERE id = ${investigationId} AND tenant_id = ${tenantId};
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
    action: "contradiction.adjudicated",
    objectType: "contradiction",
    objectId: contradictionId,
    objectDisplay: `Contradiction ${contradictionId}`,
    rationale: req.rationale,
    outcome: "success",
    requestId: randomUUID(),
  });

  return mapContradictionRow(updatedRows[0]!);
}

export async function listContradictions(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<Contradiction[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT *
    FROM contradictions
    WHERE investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        ELSE 4
      END,
      created_at DESC;
  `;

  return rows.map(mapContradictionRow);
}

export async function listSuppressionRules(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<SuppressionRule[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT *
    FROM suppression_rules
    WHERE investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    ORDER BY created_at DESC;
  `;

  return rows.map((r) => ({
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    investigation_id: String(r.investigation_id),
    rule_type: r.rule_type as "assertion_pair" | "entity_pattern" | "detector_pattern",
    pattern: typeof r.pattern === "string" ? JSON.parse(r.pattern) : (r.pattern as Record<string, unknown>) || {},
    assertion_pair: typeof r.assertion_pair === "string" ? JSON.parse(r.assertion_pair) : (r.assertion_pair as { assertion_a_id: string; assertion_b_id: string } | null),
    rationale: String(r.rationale),
    active: Boolean(r.active),
    created_by: String(r.created_by),
    created_at: new Date(String(r.created_at)).toISOString(),
    updated_at: new Date(String(r.updated_at)).toISOString(),
  }));
}

// ── Research Gap Engine (PRD §25) ──────────────────────────────────────────

/**
 * Scans ingested document content blocks for referenced documents absent from corpus (AC-GAP-01).
 */
export async function detectReferencedAbsentDocuments(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<ResearchGap[]> {
  // 1. Fetch existing sources in investigation
  const sourceRows = await tx<{ filename: string; id: string }[]>`
    SELECT filename, id
    FROM sources
    WHERE investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
      AND status != 'withdrawn';
  `;

  const existingFilenames = new Set(sourceRows.map((s) => s.filename.toLowerCase()));

  // 2. Fetch content blocks from sources
  const blockRows = await tx<{ text: string; source_id: string }[]>`
    SELECT cb.text, a.source_id
    FROM content_blocks cb
    JOIN content_documents cd ON cd.id = cb.content_document_id
    JOIN artifacts a ON a.id = cd.artifact_id
    JOIN sources s ON s.id = a.source_id
    WHERE s.investigation_id = ${investigationId}
      AND s.tenant_id = ${tenantId}
      AND s.status != 'withdrawn';
  `;

  const gaps: ResearchGap[] = [];
  const referencePatterns = [
    /as set out in the ([A-Za-z0-9\s_-]+(?:dated\s+[0-9A-Za-z\s]+)?)/i,
    /pursuant to the ([A-Za-z0-9\s_-]+(?:dated\s+[0-9A-Za-z\s]+)?)/i,
    /attached as ([A-Za-z0-9\s_-]+(?:dated\s+[0-9A-Za-z\s]+)?)/i,
  ];

  for (const block of blockRows) {
    for (const pat of referencePatterns) {
      const match = block.text.match(pat);
      if (match && match[1]) {
        const refName = match[1].trim();
        const refNameNormalized = refName.toLowerCase().replace(/[^a-z0-9]/g, "");

        // Check if this document exists in corpus
        let found = false;
        for (const fname of existingFilenames) {
          const fnameNormalized = fname.replace(/[^a-z0-9]/g, "");
          if (fnameNormalized.includes(refNameNormalized) || refNameNormalized.includes(fnameNormalized)) {
            found = true;
            break;
          }
        }

        if (!found) {
          // Check if gap already exists
          const existingGap = await tx<{ id: string }[]>`
            SELECT id FROM research_gaps
            WHERE investigation_id = ${investigationId}
              AND tenant_id = ${tenantId}
              AND gap_type = 'referenced_but_absent'
              AND title ILIKE ${`%${refName.slice(0, 30)}%`};
          `;

          if (existingGap.length === 0) {
            const gapId = randomUUID();
            const title = `Missing Referenced Document: ${refName}`;
            const description = `Document references '${refName}' which is currently absent from the investigation corpus (PRD §25.2).`;
            const priority: GapPriority = "high";
            const suggestedActions = [
              {
                action_type: "collect_source",
                label: `Request or collect '${refName}'`,
                description: "Issue a collection request or production demand for the referenced document.",
                params: { referenced_title: refName },
              },
              {
                action_type: "run_search",
                label: `Search corpus for mentions of '${refName}'`,
                description: "Search all other documents to check for other citations of this agreement.",
                params: { query: refName },
              },
            ];

            const rows = await tx<Record<string, unknown>[]>`
              INSERT INTO research_gaps (
                id, tenant_id, investigation_id, gap_type, title, description,
                target_ref, priority, priority_basis, suggested_actions, status
              )
              VALUES (
                ${gapId}, ${tenantId}, ${investigationId}, 'referenced_but_absent',
                ${title}, ${description},
                ${JSON.stringify({ type: "document_reference", name: refName })}::jsonb,
                ${priority}, 'External document explicitly referenced in primary agreement is missing from corpus.',
                ${JSON.stringify(suggestedActions)}::jsonb, 'open'
              )
              RETURNING *;
            `;

            gaps.push(mapResearchGapRow(rows[0]!));
          }
        }
      }
    }
  }

  return gaps;
}

/**
 * Creates or detects standard investigation gaps.
 */
export async function createResearchGap(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  userId: string,
  data: {
    gap_type: GapType;
    title: string;
    description: string;
    target_ref?: { type: string; id?: string; name?: string } | null;
    blocks_questions?: string[];
    priority: GapPriority;
    priority_basis: string;
    suggested_actions?: unknown[];
  },
): Promise<ResearchGap> {
  const id = randomUUID();
  const rows = await tx<Record<string, unknown>[]>`
    INSERT INTO research_gaps (
      id, tenant_id, investigation_id, gap_type, title, description,
      target_ref, blocks_questions, priority, priority_basis,
      suggested_actions, status, created_by
    )
    VALUES (
      ${id}, ${tenantId}, ${investigationId}, ${data.gap_type}, ${data.title}, ${data.description},
      ${data.target_ref ? JSON.stringify(data.target_ref) : null}::jsonb,
      ${JSON.stringify(data.blocks_questions || [])}::jsonb,
      ${data.priority}, ${data.priority_basis},
      ${JSON.stringify(data.suggested_actions || [])}::jsonb,
      'open', ${userId}
    )
    RETURNING *;
  `;

  return mapResearchGapRow(rows[0]!);
}

/**
 * Closes a research gap with supporting evidence or rationale (AC-GAP-02).
 */
export async function closeResearchGap(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  gapId: string,
  userId: string,
  req: CloseGapRequest,
): Promise<ResearchGap> {
  const existingRows = await tx<{ id: string; status: string }[]>`
    SELECT id, status
    FROM research_gaps
    WHERE id = ${gapId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId};
  `;

  if (existingRows.length === 0 || !existingRows[0]) {
    throw new CorrelationError(`Research gap ${gapId} not found.`, 404);
  }

  const updatedRows = await tx<Record<string, unknown>[]>`
    UPDATE research_gaps
    SET
      status = 'closed',
      resolution_rationale = ${req.rationale},
      closure_evidence_ids = ${JSON.stringify(req.evidence_ids || [])}::jsonb,
      updated_at = NOW()
    WHERE id = ${gapId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    RETURNING *;
  `;

  return mapResearchGapRow(updatedRows[0]!);
}

/**
 * Accepts a research gap as unresolvable (PRD §25.5 / AC-GAP-03).
 */
export async function acceptGapAsUnresolvable(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  gapId: string,
  userId: string,
  req: AcceptGapAsUnresolvableRequest,
): Promise<ResearchGap> {
  if (!req.rationale || req.rationale.trim().length === 0) {
    throw new CorrelationError("Rationale is mandatory when accepting a gap as unresolvable (PRD §25.5 / AC-GAP-03).", 400);
  }

  const existingRows = await tx<{ id: string; status: string }[]>`
    SELECT id, status
    FROM research_gaps
    WHERE id = ${gapId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId};
  `;

  if (existingRows.length === 0 || !existingRows[0]) {
    throw new CorrelationError(`Research gap ${gapId} not found.`, 404);
  }

  const updatedRows = await tx<Record<string, unknown>[]>`
    UPDATE research_gaps
    SET
      status = 'accepted_as_unresolvable',
      resolution_rationale = ${req.rationale},
      updated_at = NOW()
    WHERE id = ${gapId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    RETURNING *;
  `;

  return mapResearchGapRow(updatedRows[0]!);
}

/**
 * Automatically closes gaps when a matching source/document is admitted (AC-GAP-02).
 */
export async function autoCloseGapsOnDocumentIngest(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  sourceFilename: string,
  evidenceId?: string,
): Promise<number> {
  const normFilename = sourceFilename.toLowerCase().replace(/[^a-z0-9]/g, "");

  const openGaps = await tx<{ id: string; title: string; gap_type: string }[]>`
    SELECT id, title, gap_type
    FROM research_gaps
    WHERE investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
      AND status = 'open'
      AND gap_type IN ('referenced_but_absent', 'missing_document_type');
  `;

  let closedCount = 0;
  for (const g of openGaps) {
    const normTitle = g.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normTitle.includes(normFilename) || normFilename.includes(normTitle) || normFilename.includes("sideletter")) {
      await tx`
        UPDATE research_gaps
        SET
          status = 'closed',
          resolution_rationale = ${`Automatically resolved upon admission of matching document: '${sourceFilename}' (AC-GAP-02).`},
          closure_evidence_ids = ${JSON.stringify(evidenceId ? [evidenceId] : [])}::jsonb,
          updated_at = NOW()
        WHERE id = ${g.id};
      `;
      closedCount++;
    }
  }

  return closedCount;
}

export async function listResearchGaps(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<ResearchGap[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT *
    FROM research_gaps
    WHERE investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        ELSE 4
      END,
      created_at DESC;
  `;

  return rows.map(mapResearchGapRow);
}

// ── Row Mappers ─────────────────────────────────────────────────────────────

function mapContradictionRow(r: Record<string, unknown>): Contradiction {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    investigation_id: String(r.investigation_id),
    detector: String(r.detector),
    detector_class: r.detector_class as "deterministic" | "semantic" | "hybrid",
    subtype: String(r.subtype),
    assertion_a_id: String(r.assertion_a_id),
    assertion_b_id: String(r.assertion_b_id),
    evidence_a_ids: typeof r.evidence_a_ids === "string" ? JSON.parse(r.evidence_a_ids) : (r.evidence_a_ids as string[]) || [],
    evidence_b_ids: typeof r.evidence_b_ids === "string" ? JSON.parse(r.evidence_b_ids) : (r.evidence_b_ids as string[]) || [],
    description: String(r.description),
    severity: r.severity as ContradictionSeverity,
    severity_basis: String(r.severity_basis),
    affects_questions: typeof r.affects_questions === "string" ? JSON.parse(r.affects_questions) : (r.affects_questions as string[]) || [],
    affects_findings: typeof r.affects_findings === "string" ? JSON.parse(r.affects_findings) : (r.affects_findings as string[]) || [],
    affects_hypotheses: typeof r.affects_hypotheses === "string" ? JSON.parse(r.affects_hypotheses) : (r.affects_hypotheses as string[]) || [],
    status: r.status as ContradictionStatus,
    resolution: r.resolution ? (typeof r.resolution === "string" ? JSON.parse(r.resolution) : (r.resolution as Contradiction["resolution"])) : null,
    suppression_rule_id: r.suppression_rule_id ? String(r.suppression_rule_id) : null,
    created_at: new Date(String(r.created_at)).toISOString(),
    updated_at: new Date(String(r.updated_at)).toISOString(),
  };
}

function mapResearchGapRow(r: Record<string, unknown>): ResearchGap {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    investigation_id: String(r.investigation_id),
    gap_type: r.gap_type as GapType,
    title: String(r.title),
    description: String(r.description),
    target_ref: r.target_ref ? (typeof r.target_ref === "string" ? JSON.parse(r.target_ref) : (r.target_ref as ResearchGap["target_ref"])) : null,
    blocks_questions: typeof r.blocks_questions === "string" ? JSON.parse(r.blocks_questions) : (r.blocks_questions as string[]) || [],
    blocks_hypotheses: typeof r.blocks_hypotheses === "string" ? JSON.parse(r.blocks_hypotheses) : (r.blocks_hypotheses as string[]) || [],
    priority: r.priority as GapPriority,
    priority_basis: String(r.priority_basis),
    suggested_actions: typeof r.suggested_actions === "string" ? JSON.parse(r.suggested_actions) : (r.suggested_actions as ResearchGap["suggested_actions"]) || [],
    status: r.status as GapStatus,
    resolution_rationale: r.resolution_rationale ? String(r.resolution_rationale) : null,
    closure_evidence_ids: typeof r.closure_evidence_ids === "string" ? JSON.parse(r.closure_evidence_ids) : (r.closure_evidence_ids as string[]) || [],
    task_ids: typeof r.task_ids === "string" ? JSON.parse(r.task_ids) : (r.task_ids as string[]) || [],
    created_by: r.created_by ? String(r.created_by) : null,
    created_at: new Date(String(r.created_at)).toISOString(),
    updated_at: new Date(String(r.updated_at)).toISOString(),
  };
}
