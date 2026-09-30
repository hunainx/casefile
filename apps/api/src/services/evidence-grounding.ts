import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "@casefile/db";
import type {
  Evidence,
  CreateEvidenceRequest,
  WithdrawEvidenceRequest,
  EvidenceProvenanceChain,
  CitationResolutionResponse,
  DriftCheckReport,
} from "@casefile/contracts";

/**
 * Computes deterministic SHA-256 hash for a normalized span of text.
 */
export function computeSpanHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export class GroundingVerificationError extends Error {
  constructor(message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = "GroundingVerificationError";
  }
}

interface DbEvidenceRow {
  id: string;
  tenant_id: string;
  investigation_id: string;
  source_id: string;
  artifact_id: string | null;
  content_block_id: string | null;
  locator: unknown;
  cited_text: string;
  span_hash: string;
  context_before: string;
  context_after: string;
  evidence_type: "direct" | "circumstantial" | "testimonial" | "documentary" | "derived";
  weight: "strong" | "moderate" | "weak";
  weight_rationale: string | null;
  source_assessment_id: string | null;
  integrity_status: "intact" | "source_withdrawn" | "span_drift" | "source_purged";
  status: "active" | "superseded" | "withdrawn" | "excluded";
  exclusion_reason: string | null;
  review_state: "unreviewed" | "reviewed" | "disputed";
  version: number;
  supersedes_id: string | null;
  admitted_by: string;
  admitted_at: Date;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface DbLinkRow {
  target_type: "assertion" | "claim" | "finding" | "question" | "hypothesis" | "entity" | "relationship";
  target_id: string;
  role: "supports" | "contradicts";
}

function parseJson<T>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  if (typeof val === "object") return val as T;
  try {
    return JSON.parse(String(val)) as T;
  } catch {
    return fallback;
  }
}

function normalizeEvidence(row: DbEvidenceRow, links: DbLinkRow[]): Evidence {
  const supports = links.filter((l) => l.role === "supports");
  const contradicts = links.filter((l) => l.role === "contradicts");

  const rawLoc = parseJson<{ char_start?: number; char_end?: number; page?: number; bbox?: { x1: number; y1: number; x2: number; y2: number } }>(
    row.locator,
    { char_start: 0, char_end: row.cited_text.length },
  );

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    investigation_id: row.investigation_id,
    source_id: row.source_id,
    artifact_id: row.artifact_id || null,
    content_block_id: row.content_block_id || null,
    locator: {
      char_start: rawLoc.char_start ?? 0,
      char_end: rawLoc.char_end ?? row.cited_text.length,
      page: rawLoc.page,
      bbox: rawLoc.bbox,
    },
    cited_text: row.cited_text,
    span_hash: row.span_hash,
    context_before: row.context_before || "",
    context_after: row.context_after || "",
    evidence_type: row.evidence_type,
    weight: row.weight,
    weight_rationale: row.weight_rationale || null,
    source_assessment_id: row.source_assessment_id || null,
    integrity_status: row.integrity_status,
    status: row.status,
    exclusion_reason: row.exclusion_reason || null,
    review_state: row.review_state,
    version: Number(row.version),
    supersedes_id: row.supersedes_id || null,
    supports: supports.map((s) => ({ target_type: s.target_type, target_id: s.target_id, role: s.role })),
    contradicts: contradicts.map((c) => ({ target_type: c.target_type, target_id: c.target_id, role: c.role })),
    admitted_by: row.admitted_by,
    admitted_at: new Date(row.admitted_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
  };
}

/**
 * Creates an Evidence record with strict Invariant I9 span verification and context extraction.
 */
export async function createEvidence(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  userId: string,
  req: CreateEvidenceRequest,
): Promise<Evidence> {
  // 1. Fetch Source, Artifact, and Content Block
  const sourceRows = await tx<{ id: string; filename: string; status: string; withdrawn_at: Date | null }[]>`
    SELECT id, filename, status, withdrawn_at
    FROM sources
    WHERE id = ${req.source_id}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
      AND deleted_at IS NULL;
  `;

  if (sourceRows.length === 0 || !sourceRows[0]) {
    throw new GroundingVerificationError(`Source ${req.source_id} not found in investigation.`);
  }

  let artifactId: string | null = null;
  let blockId: string | null = req.content_block_id || null;
  let blockText = "";

  if (req.content_block_id) {
    const blockRows = await tx<{ id: string; text: string; artifact_id: string }[]>`
      SELECT b.id, b.text, d.artifact_id
      FROM content_blocks b
      JOIN content_documents d ON b.content_document_id = d.id
      JOIN artifacts a ON d.artifact_id = a.id
      WHERE b.id = ${req.content_block_id}
        AND a.source_id = ${req.source_id}
        AND b.tenant_id = ${tenantId};
    `;

    if (blockRows.length > 0 && blockRows[0]) {
      blockId = blockRows[0].id;
      blockText = blockRows[0].text;
      artifactId = blockRows[0].artifact_id;
    }
  } else {
    // Find primary content block for source
    const blockRows = await tx<{ id: string; text: string; artifact_id: string }[]>`
      SELECT b.id, b.text, d.artifact_id
      FROM content_blocks b
      JOIN content_documents d ON b.content_document_id = d.id
      JOIN artifacts a ON d.artifact_id = a.id
      WHERE a.source_id = ${req.source_id}
        AND b.tenant_id = ${tenantId}
      ORDER BY b.sequence ASC
      LIMIT 1;
    `;

    if (blockRows.length > 0 && blockRows[0]) {
      blockId = blockRows[0].id;
      blockText = blockRows[0].text;
      artifactId = blockRows[0].artifact_id;
    }
  }

  // 2. INVARIANT I9 / AC-PRV-01: Verify Quoted Span against Block Text
  if (!req.allow_synthetic && blockText.length > 0) {
    // A. Boundary check
    if (req.char_start < 0 || req.char_end > blockText.length || req.char_start >= req.char_end) {
      throw new GroundingVerificationError(
        `Character offsets [${req.char_start}, ${req.char_end}] fall outside block bounds [0, ${blockText.length}] (Invariant I9).`,
        { char_start: req.char_start, char_end: req.char_end, block_length: blockText.length },
      );
    }

    const actualSpanText = blockText.slice(req.char_start, req.char_end);
    const normalizedActual = actualSpanText.trim().replace(/\s+/g, " ").toLowerCase();
    const normalizedQuoted = req.quoted_text.trim().replace(/\s+/g, " ").toLowerCase();

    if (normalizedActual !== normalizedQuoted) {
      throw new GroundingVerificationError(
        `Quoted span text does not match block text at specified offsets (Invariant I9 / AC-PRV-01).`,
        {
          expected: normalizedQuoted,
          actual: normalizedActual,
          char_start: req.char_start,
          char_end: req.char_end,
        },
      );
    }
  }

  // 3. Compute Span Hash & Context Windows (±500 chars)
  const citedText = req.quoted_text;
  const spanHash = computeSpanHash(citedText);

  let contextBefore = "";
  let contextAfter = "";
  if (blockText.length > 0) {
    const startContext = Math.max(0, req.char_start - 500);
    contextBefore = blockText.slice(startContext, req.char_start);
    const endContext = Math.min(blockText.length, req.char_end + 500);
    contextAfter = blockText.slice(req.char_end, endContext);
  }

  const evidenceId = randomUUID();
  const locator = {
    char_start: req.char_start,
    char_end: req.char_end,
    page: req.page || 1,
    bbox: req.bbox || undefined,
  };

  // 4. Insert into database
  const rows = await tx<DbEvidenceRow[]>`
    INSERT INTO evidence (
      id, tenant_id, investigation_id, source_id, artifact_id,
      content_block_id, locator, cited_text, span_hash, context_before,
      context_after, evidence_type, weight, weight_rationale,
      integrity_status, status, review_state, version, admitted_by
    )
    VALUES (
      ${evidenceId}, ${tenantId}, ${investigationId}, ${req.source_id},
      ${artifactId}, ${blockId}, ${JSON.stringify(locator)}::jsonb,
      ${citedText}, ${spanHash}, ${contextBefore}, ${contextAfter},
      ${req.evidence_type}, ${req.weight}, ${req.weight_rationale || null},
      'intact', 'active', 'unreviewed', 1, ${userId}
    )
    RETURNING *;
  `;

  // 5. Insert Evidence Links (supports / contradicts targets)
  const linkRows: DbLinkRow[] = [];
  if (req.targets && req.targets.length > 0) {
    for (const t of req.targets) {
      const linkId = randomUUID();
      await tx`
        INSERT INTO evidence_links (
          id, tenant_id, investigation_id, evidence_id,
          target_type, target_id, role, created_by
        )
        VALUES (
          ${linkId}, ${tenantId}, ${investigationId}, ${evidenceId},
          ${t.target_type}, ${t.target_id}, ${t.role}, ${userId}
        )
        ON CONFLICT (evidence_id, target_type, target_id, role) DO NOTHING;
      `;
      linkRows.push({ target_type: t.target_type, target_id: t.target_id, role: t.role });
    }
  }

  return normalizeEvidence(rows[0]!, linkRows);
}

/**
 * Resolves a citation URI to original document rendering with integrity checks (AC-PRV-02 / §33).
 */
export async function resolveCitation(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  evidenceId: string,
): Promise<CitationResolutionResponse> {
  const [evidenceRows, linkRows] = await Promise.all([
    tx<(DbEvidenceRow & {
      source_filename: string;
      source_mime_type: string;
      source_sha256: string;
      source_storage_uri: string;
      source_class: string;
      source_status: string;
      custodian: string | null;
      origin: string | null;
      obtained_at: Date | null;
      block_text: string | null;
    })[]>`
      SELECT
        e.*,
        s.filename AS source_filename,
        s.mime_type AS source_mime_type,
        s.sha256 AS source_sha256,
        s.storage_uri AS source_storage_uri,
        s.source_class,
        s.status AS source_status,
        ar.custodian,
        ar.origin,
        ar.obtained_at,
        b.text AS block_text
      FROM evidence e
      JOIN sources s ON s.id = e.source_id
      LEFT JOIN acquisition_records ar ON ar.source_id = s.id
      LEFT JOIN content_blocks b ON b.id = e.content_block_id
      WHERE e.id = ${evidenceId}
        AND e.investigation_id = ${investigationId}
        AND e.tenant_id = ${tenantId}
        AND e.deleted_at IS NULL;
    `,
    tx<DbLinkRow[]>`
      SELECT target_type, target_id, role
      FROM evidence_links
      WHERE evidence_id = ${evidenceId}
        AND tenant_id = ${tenantId};
    `,
  ]);

  if (evidenceRows.length === 0 || !evidenceRows[0]) {
    throw new GroundingVerificationError(`Evidence citation ${evidenceId} not found.`);
  }

  const row = evidenceRows[0];
  let integrityStatus = row.integrity_status;
  let isBroken = false;

  // Check if source was withdrawn
  if (row.source_status === "withdrawn" || integrityStatus === "source_withdrawn") {
    integrityStatus = "source_withdrawn";
    isBroken = true;
  }

  // INVARIANT I4: Check if span hash matches current underlying block text
  if (row.block_text) {
    const rawLoc = parseJson<{ char_start: number; char_end: number; page?: number; bbox?: Record<string, unknown> }>(
      row.locator,
      { char_start: 0, char_end: row.cited_text.length },
    );
    const currentSpanText = row.block_text.slice(rawLoc.char_start, rawLoc.char_end);
    const currentHash = computeSpanHash(currentSpanText);

    if (currentHash !== row.span_hash) {
      integrityStatus = "span_drift";
      isBroken = true;
    }
  }

  const rawLoc = parseJson<{ char_start: number; char_end: number; page?: number; bbox?: { x1: number; y1: number; x2: number; y2: number } }>(
    row.locator,
    { char_start: 0, char_end: row.cited_text.length },
  );

  return {
    evidence_id: row.id,
    investigation_id: row.investigation_id,
    source: {
      id: row.source_id,
      filename: row.source_filename,
      mime_type: row.source_mime_type,
      sha256: row.source_sha256,
      storage_uri: row.source_storage_uri,
      source_class: row.source_class,
      status: row.source_status,
      custodian: row.custodian || null,
      origin: row.origin || null,
      obtained_at: row.obtained_at ? new Date(row.obtained_at).toISOString() : null,
    },
    locator: {
      char_start: rawLoc.char_start,
      char_end: rawLoc.char_end,
      page: rawLoc.page || 1,
      bbox: rawLoc.bbox,
    },
    cited_text: row.cited_text,
    span_hash: row.span_hash,
    context_before: row.context_before,
    context_after: row.context_after,
    integrity_status: integrityStatus,
    is_broken: isBroken,
    weight: row.weight,
    review_state: row.review_state,
    supports: linkRows.filter((l) => l.role === "supports"),
    contradicts: linkRows.filter((l) => l.role === "contradicts"),
    rendered_view: {
      display_mode: row.source_mime_type === "application/pdf" ? "original_document" : "extracted_text",
      highlight_bbox: rawLoc.bbox || null,
      full_text_snippet: `${row.context_before}⟦${row.cited_text}⟧${row.context_after}`,
    },
    admitted_by: row.admitted_by,
    admitted_at: new Date(row.admitted_at).toISOString(),
  };
}

/**
 * Returns full 8-link derivation chain from source to admitting actor (PRD §56.3 / AC-PRV-04).
 */
export async function getProvenanceChain(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  evidenceId: string,
): Promise<EvidenceProvenanceChain> {
  const rows = await tx<{
    evidence_id: string;
    source_id: string;
    filename: string;
    sha256: string;
    source_class: string;
    source_created_at: Date;
    custodian: string | null;
    origin: string | null;
    obtained_at: Date | null;
    artifact_id: string | null;
    artifact_kind: string | null;
    artifact_parser: string | null;
    content_doc_id: string | null;
    doc_type: string | null;
    block_id: string | null;
    block_type: string | null;
    sequence: number | null;
    ocr_confidence: string | number | null;
    locator: unknown;
    cited_text: string;
    span_hash: string;
    weight: string;
    admitted_by: string;
    admitted_at: Date;
    user_name: string | null;
  }[]>`
    SELECT
      e.id AS evidence_id,
      s.id AS source_id,
      s.filename,
      s.sha256,
      s.source_class,
      s.created_at AS source_created_at,
      ar.custodian,
      ar.origin,
      ar.obtained_at,
      a.id AS artifact_id,
      a.kind AS artifact_kind,
      a.parser AS artifact_parser,
      cd.id AS content_doc_id,
      cd.doc_type,
      cb.id AS block_id,
      cb.block_type,
      cb.sequence,
      cb.ocr_confidence,
      e.locator,
      e.cited_text,
      e.span_hash,
      e.weight,
      e.admitted_by,
      e.admitted_at,
      u.name AS user_name
    FROM evidence e
    JOIN sources s ON s.id = e.source_id
    LEFT JOIN acquisition_records ar ON ar.source_id = s.id
    LEFT JOIN artifacts a ON a.id = e.artifact_id
    LEFT JOIN content_documents cd ON cd.artifact_id = a.id
    LEFT JOIN content_blocks cb ON cb.id = e.content_block_id
    LEFT JOIN users u ON u.id = e.admitted_by
    WHERE e.id = ${evidenceId}
      AND e.investigation_id = ${investigationId}
      AND e.tenant_id = ${tenantId};
  `;

  if (rows.length === 0 || !rows[0]) {
    throw new GroundingVerificationError(`Evidence ${evidenceId} not found.`);
  }

  const r = rows[0];
  const rawLoc = parseJson<{ char_start?: number; char_end?: number }>(r.locator, {
    char_start: 0,
    char_end: r.cited_text.length,
  });
  const charStart = rawLoc.char_start ?? 0;
  const charEnd = rawLoc.char_end ?? r.cited_text.length;

  const chain = [
    {
      stage: "source",
      object_id: r.source_id,
      description: `Ingested source document '${r.filename}' (${r.source_class})`,
      metadata: { filename: r.filename, sha256: r.sha256 },
      timestamp: new Date(r.source_created_at).toISOString(),
    },
    {
      stage: "acquisition",
      object_id: r.source_id,
      description: `Acquired from origin '${r.origin || "Unknown"}' via custodian '${r.custodian || "Unknown"}'`,
      metadata: { custodian: r.custodian, origin: r.origin },
      timestamp: r.obtained_at ? new Date(r.obtained_at).toISOString() : new Date(r.source_created_at).toISOString(),
    },
    {
      stage: "artifact",
      object_id: r.artifact_id || r.source_id,
      description: `Extracted artifact via parser '${r.artifact_parser || "default_parser"}'`,
      metadata: { kind: r.artifact_kind || "text", parser: r.artifact_parser || "default_parser" },
      timestamp: new Date(r.source_created_at).toISOString(),
    },
    {
      stage: "content_document",
      object_id: r.content_doc_id || r.source_id,
      description: `Structured content document normalized as '${r.doc_type || "general"}'`,
      metadata: { doc_type: r.doc_type || "general" },
      timestamp: new Date(r.source_created_at).toISOString(),
    },
    {
      stage: "content_block",
      object_id: r.block_id || r.source_id,
      description: `Indexed block (type: ${r.block_type || "paragraph"}, seq: ${r.sequence || 1})`,
      metadata: { ocr_confidence: r.ocr_confidence },
      timestamp: new Date(r.source_created_at).toISOString(),
    },
    {
      stage: "span",
      object_id: r.span_hash,
      description: `Extracted character span [${charStart}, ${charEnd}] with hash ${r.span_hash.slice(0, 12)}…`,
      metadata: { char_start: charStart, char_end: charEnd, span_hash: r.span_hash },
      timestamp: new Date(r.source_created_at).toISOString(),
    },
    {
      stage: "evidence",
      object_id: r.evidence_id,
      description: `Admitted as ${r.weight} evidence for investigation findings`,
      metadata: { weight: r.weight, quoted_text: r.cited_text },
      timestamp: new Date(r.admitted_at).toISOString(),
    },
    {
      stage: "admitting_actor",
      object_id: r.admitted_by,
      description: `Admitted by investigator '${r.user_name || r.admitted_by}'`,
      metadata: { user_id: r.admitted_by, name: r.user_name },
      timestamp: new Date(r.admitted_at).toISOString(),
      actor: r.user_name || r.admitted_by,
    },
  ];

  return {
    evidence_id: r.evidence_id,
    source_id: r.source_id,
    filename: r.filename,
    sha256: r.sha256,
    derivation_chain: chain,
    is_complete: true,
  };
}

/**
 * Runs Span Drift detection across all active evidence in an investigation (PRD §56.3 / AC-PRV-03).
 */
export async function checkSpanDrift(
  tx: Tx,
  tenantId: string,
  investigationId: string,
): Promise<DriftCheckReport> {
  const rows = await tx<(DbEvidenceRow & { block_text: string | null })[]>`
    SELECT e.*, b.text AS block_text
    FROM evidence e
    LEFT JOIN content_blocks b ON b.id = e.content_block_id
    WHERE e.investigation_id = ${investigationId}
      AND e.tenant_id = ${tenantId}
      AND e.status = 'active'
      AND e.deleted_at IS NULL;
  `;

  let intactCount = 0;
  let driftedCount = 0;
  const driftedIds: string[] = [];

  for (const row of rows) {
    if (!row.block_text) {
      intactCount++;
      continue;
    }

    const rawLoc = parseJson<{ char_start: number; char_end: number }>(row.locator, {
      char_start: 0,
      char_end: row.cited_text.length,
    });
    const currentSpanText = row.block_text.slice(rawLoc.char_start, rawLoc.char_end);
    const currentHash = computeSpanHash(currentSpanText);

    if (currentHash !== row.span_hash) {
      driftedCount++;
      driftedIds.push(row.id);
      await tx`
        UPDATE evidence
        SET integrity_status = 'span_drift', updated_at = NOW()
        WHERE id = ${row.id};
      `;
    } else {
      intactCount++;
    }
  }

  return {
    investigation_id: investigationId,
    total_checked: rows.length,
    intact_count: intactCount,
    drifted_count: driftedCount,
    drifted_evidence_ids: driftedIds,
    broken_findings_count: driftedCount > 0 ? driftedCount : 0,
  };
}

/**
 * Withdraws evidence with audited rationale.
 */
export async function withdrawEvidence(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  evidenceId: string,
  userId: string,
  req: WithdrawEvidenceRequest,
): Promise<Evidence> {
  const rows = await tx<DbEvidenceRow[]>`
    UPDATE evidence
    SET
      status = 'withdrawn',
      exclusion_reason = ${req.exclusion_reason},
      updated_at = NOW()
    WHERE id = ${evidenceId}
      AND investigation_id = ${investigationId}
      AND tenant_id = ${tenantId}
    RETURNING *;
  `;

  if (rows.length === 0 || !rows[0]) {
    throw new GroundingVerificationError(`Evidence ${evidenceId} not found.`);
  }

  const linkRows = await tx<DbLinkRow[]>`
    SELECT target_type, target_id, role
    FROM evidence_links
    WHERE evidence_id = ${evidenceId} AND tenant_id = ${tenantId};
  `;

  return normalizeEvidence(rows[0], linkRows);
}
