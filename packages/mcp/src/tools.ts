import { z } from "zod";
import { readJsonb, type Tx } from "@casefile/db";
import { getObjectStore, createSourceStorageKey, type TenantScopedKey } from "@casefile/storage";

export interface MatterContext {
  tenantId: string;
  investigationId: string;
  userId: string;
  roles: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 1: matter_status
// ─────────────────────────────────────────────────────────────────────────────
export const MatterStatusSchema = z.object({}).strict();

export async function handleMatterStatus(tx: Tx, ctx: MatterContext) {
  const [invRows, countRows] = await Promise.all([
    tx<{
      id: string;
      name: string;
      objective: string | null;
      stage: string;
      sensitivity: string;
    }[]>`
      SELECT id, name, objective, stage, sensitivity
      FROM investigations
      WHERE id = ${ctx.investigationId}
        AND tenant_id = ${ctx.tenantId}
        AND deleted_at IS NULL;
    `,
    tx<{ status: string; count: string | number }[]>`
      SELECT status, count(*)::int as count
      FROM sources
      WHERE investigation_id = ${ctx.investigationId}
        AND tenant_id = ${ctx.tenantId}
        AND deleted_at IS NULL
      GROUP BY status
      -- FINAL (DEV-045): a fixed order for by_status (without it, the order the aggregate returned).
      ORDER BY status;
    `,
  ]);
  // FIXES-1 (DEV-024): a wall that names a group is not applied (there is no group membership).
  // New ones are refused; one that exists already is reported here, so nobody relies on it.
  const groupWalls = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ethical_walls w
    JOIN investigations i ON i.id = ${ctx.investigationId} AND i.tenant_id = ${ctx.tenantId}
    WHERE w.tenant_id = ${ctx.tenantId} AND w.subject_type = 'group'
      AND (w.investigation_id = i.id OR (w.workspace_id = i.workspace_id AND w.investigation_id IS NULL));
  `;
  const unappliedGroupWalls = Number(groupWalls[0]?.n ?? 0);
  const ingestRun = await latestIngestRun(tx, ctx);

  const byStatus: Record<string, number> = {};
  let totalSources = 0;
  for (const r of countRows) {
    const c = Number(r.count);
    byStatus[r.status] = c;
    totalSources += c;
  }

  const investigation = invRows[0] || {
    id: ctx.investigationId,
    name: "Default Investigation",
    objective: null,
    stage: "active",
    sensitivity: "internal",
  };

  const storage = getObjectStore();
  let downloadLinksAvailable = false;
  try {
    await storage.signedUrl("probe-capability" as TenantScopedKey, 1);
    downloadLinksAvailable = true;
  } catch {
    // signedUrl capability unavailable in current deployment
  }

  return {
    investigation: {
      id: investigation.id,
      name: investigation.name,
      objective: investigation.objective,
      stage: investigation.stage,
      sensitivity: investigation.sensitivity,
    },
    sources: {
      total: totalSources,
      by_status: byStatus,
    },
    storage_capabilities: {
      driver: storage.constructor.name === "GcsObjectStore" ? "gcs" : "memory",
      download_links_available: downloadLinksAvailable,
    },
    search_capabilities: {
      retrieval_mode: "lexical_and_fuzzy",
      vector_retrieval_available: false,
      cross_encoder_reranking_available: false,
      computed_signals: ["lexical_match", "source_quality"],
      uncomputed_signals: [
        "cross_encoder_relevance",
        "entity_overlap",
        "recency_or_period_fit",
        "question_alignment",
        "novelty",
        "interaction_signal",
        "near_duplicate_collapsing",
      ],
    },
    // BIGDATA-4: the latest ingest run, in short, while it is unfinished or has failed items
    // (pnpm ingest:status --run <id> gives all of it). Nothing for a run that finished cleanly.
    ...(ingestRun ? { ingest_run: ingestRun } : {}),
    ...(unappliedGroupWalls > 0
      ? {
          warnings: [
            {
              kind: "unapplied_group_ethical_walls",
              count: unappliedGroupWalls,
              message:
                `${unappliedGroupWalls} ethical wall(s) of this matter name a group and are NOT applied: there is no group ` +
                "membership, so they screen nobody (DEV-024). Replace each with a wall per person.",
            },
          ],
        }
      : {}),
  };
}

/**
 * BIGDATA-4 (plan section 16, E): the investigation's latest ingest run, in short: its state, the
 * top-level objects done and left, and its failed items; null when it finished with no failure.
 * A top-level object is a file, or a mailbox (done once its parts and its summary are written).
 */
async function latestIngestRun(tx: Tx, ctx: MatterContext): Promise<Record<string, unknown> | null> {
  const rows = await tx<{ id: string; triaged: boolean; queued: boolean; finished: boolean; total: number; done: number; failed_top: number; failed: number; alive: number }[]>`
    SELECT r.id, r.triaged_at IS NOT NULL AS triaged, r.queued_at IS NOT NULL AS queued, r.finished_at IS NOT NULL AS finished,
      (SELECT count(*)::int FROM ingest_work w WHERE w.tenant_id = r.tenant_id AND w.run_id = r.id AND w.part_no = 0) AS total,
      (SELECT count(*)::int FROM ingest_work h WHERE h.tenant_id = r.tenant_id AND h.run_id = r.id AND h.part_no = 0 AND h.state = 'done'
         AND (h.kind = 'file' OR COALESCE(h.result->>'status', '') <> 'processing'
              OR EXISTS (SELECT 1 FROM ingest_work f WHERE f.tenant_id = h.tenant_id AND f.run_id = h.run_id AND f.top_seq = h.top_seq AND f.kind = 'mailbox-finish' AND f.state = 'done'))) AS done,
      (SELECT count(DISTINCT w.top_seq)::int FROM ingest_work w WHERE w.tenant_id = r.tenant_id AND w.run_id = r.id AND w.state = 'failed'
         AND (w.part_no = 0 OR w.kind = 'mailbox-finish')) AS failed_top,
      (SELECT count(*)::int FROM ingest_work w WHERE w.tenant_id = r.tenant_id AND w.run_id = r.id AND w.state = 'failed') AS failed,
      (SELECT count(*)::int FROM ingest_workers k WHERE k.tenant_id = r.tenant_id AND k.run_id = r.id AND k.stopped_at IS NULL
         AND k.heartbeat_at > NOW() - interval '30 seconds') AS alive
    FROM ingest_runs r
    WHERE r.tenant_id = ${ctx.tenantId} AND r.investigation_id = ${ctx.investigationId} AND r.kind = 'ingest'
    ORDER BY r.started_at DESC, r.id DESC LIMIT 1`;
  const r = rows[0];
  if (!r || (r.finished && r.failed === 0)) return null;
  const state = r.finished ? "finished-with-failures" : !r.triaged || !r.queued ? "not-queued" : r.alive > 0 ? "running" : "stopped";
  return {
    run_id: r.id,
    state,
    done: r.done,
    left: Math.max(0, r.total - r.done - r.failed_top),
    failed: r.failed,
    detail: `pnpm ingest:status --run ${r.id}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2: list_investigations
// ─────────────────────────────────────────────────────────────────────────────
export const ListInvestigationsSchema = z.object({}).strict();

/**
 * One deployment serves one matter (plan answer 6): only MATTER_INVESTIGATION_ID is ever
 * returned, whatever else the tenant holds (DEV-026, D79). Access was decided for that
 * investigation alone, so any other one could be behind an ethical wall.
 */
export async function handleListInvestigations(tx: Tx, ctx: MatterContext) {
  const rows = await tx<{
    id: string;
    name: string;
    objective: string | null;
    stage: string;
    sensitivity: string;
    created_at: Date;
  }[]>`
    SELECT id, name, objective, stage, sensitivity, created_at
    FROM investigations
    WHERE id = ${ctx.investigationId}
      AND tenant_id = ${ctx.tenantId}
      AND deleted_at IS NULL
    ORDER BY created_at ASC;
  `;

  return {
    investigations: rows.map((r) => ({
      id: r.id,
      name: r.name,
      objective: r.objective,
      stage: r.stage,
      sensitivity: r.sensitivity,
      created_at: r.created_at.toISOString(),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3: get_investigation
// ─────────────────────────────────────────────────────────────────────────────
export const GetInvestigationSchema = z.object({
  investigation_id: z.string().uuid().optional().describe("Investigation UUID (defaults to deployment investigation)"),
}).strict();

export async function handleGetInvestigation(
  tx: Tx,
  ctx: MatterContext,
  args: z.infer<typeof GetInvestigationSchema>,
) {
  const targetId = args.investigation_id || ctx.investigationId;
  // Any investigation but the matter's answers exactly as an unknown ID does (DEV-026, D79).
  if (targetId !== ctx.investigationId) {
    throw new Error(`Investigation ${targetId} not found.`);
  }
  const rows = await tx<{
    id: string;
    name: string;
    objective: string | null;
    stage: string;
    sensitivity: string;
    legal_hold: boolean;
    created_at: Date;
  }[]>`
    SELECT id, name, objective, stage, sensitivity, legal_hold, created_at
    FROM investigations
    WHERE id = ${targetId}
      AND tenant_id = ${ctx.tenantId}
      AND deleted_at IS NULL;
  `;

  if (rows.length === 0 || !rows[0]) {
    throw new Error(`Investigation ${targetId} not found.`);
  }

  const r = rows[0];
  return {
    investigation: {
      id: r.id,
      name: r.name,
      objective: r.objective,
      stage: r.stage,
      sensitivity: r.sensitivity,
      legal_hold: r.legal_hold,
      created_at: r.created_at.toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4: list_documents
// ─────────────────────────────────────────────────────────────────────────────
export const ListDocumentsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(50).describe("Maximum documents to return"),
  cursor: z.string().optional().describe("Pagination cursor"),
}).strict();

export async function handleListDocuments(
  tx: Tx,
  ctx: MatterContext,
  args: z.infer<typeof ListDocumentsSchema>,
) {
  const rows = await tx<{
    id: string;
    filename: string;
    source_class: string | null;
    status: string;
    mime_type: string | null;
    byte_size: string | number | null;
    created_at: Date;
  }[]>`
    SELECT id, filename, source_class, status, mime_type, byte_size, created_at
    FROM sources
    WHERE investigation_id = ${ctx.investigationId}
      AND tenant_id = ${ctx.tenantId}
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${args.limit};
  `;

  return {
    documents: rows.map((s) => ({
      id: s.id,
      filename: s.filename,
      source_class: s.source_class,
      status: s.status,
      mime_type: s.mime_type,
      byte_size: Number(s.byte_size || 0),
      created_at: s.created_at.toISOString(),
    })),
    next_cursor: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 5: get_source
// ─────────────────────────────────────────────────────────────────────────────
export const GetSourceSchema = z.object({
  source_id: z.string().uuid().describe("The unique UUID of the source document"),
}).strict();

export async function handleGetSource(
  tx: Tx,
  ctx: MatterContext,
  args: z.infer<typeof GetSourceSchema>,
) {
  const [sourceRows, docRows, blockRows] = await Promise.all([
    tx<{
      id: string;
      filename: string;
      source_class: string | null;
      status: string;
      mime_type: string | null;
      byte_size: string | number | null;
      storage_uri: string | null;
      created_at: Date;
      metadata: unknown;
    }[]>`
      SELECT id, filename, source_class, status, mime_type, byte_size, storage_uri, created_at, metadata
      FROM sources
      WHERE id = ${args.source_id}
        AND investigation_id = ${ctx.investigationId}
        AND tenant_id = ${ctx.tenantId}
        AND deleted_at IS NULL;
    `,
    tx<{
      id: string;
      doc_type: string | null;
    }[]>`
      SELECT cd.id, cd.doc_type
      FROM content_documents cd
      JOIN artifacts a ON a.id = cd.artifact_id
      WHERE a.source_id = ${args.source_id}
        AND cd.tenant_id = ${ctx.tenantId};
    `,
    tx<{
      id: string;
      sequence: number;
      block_type: string;
      text: string;
      page: number | null;
    }[]>`
      SELECT b.id, b.sequence, b.block_type, b.text, b.page
      FROM content_blocks b
      JOIN content_documents cd ON cd.id = b.content_document_id
      JOIN artifacts a ON a.id = cd.artifact_id
      WHERE a.source_id = ${args.source_id}
        AND b.tenant_id = ${ctx.tenantId}
      ORDER BY b.sequence ASC
      LIMIT 100;
    `,
  ]);

  if (sourceRows.length === 0 || !sourceRows[0]) {
    throw new Error(`Source ${args.source_id} not found.`);
  }

  const s = sourceRows[0];
  const mailbox = mailboxOf(s.metadata);
  const mailboxFile = mailboxFileOf(s.metadata);
  return {
    source: {
      id: s.id,
      filename: s.filename,
      source_class: s.source_class,
      status: s.status,
      mime_type: s.mime_type,
      byte_size: Number(s.byte_size || 0),
      storage_uri: s.storage_uri,
      created_at: s.created_at.toISOString(),
      // BIGDATA-3B: only for a message read out of a mailbox file (PST, OST, MBOX).
      ...(mailbox ? { mailbox } : {}),
      // BIGDATA-4 (answer 1): only for a mailbox file whose store had a password (it was read).
      ...(mailboxFile ? { mailbox_file: mailboxFile } : {}),
    },
    document: docRows[0] || null,
    content_blocks: blockRows.map((b) => ({
      id: b.id,
      sequence: b.sequence,
      block_type: b.block_type,
      text: b.text,
      page: b.page,
    })),
  };
}

/**
 * BIGDATA-3B: where a message came from, for a source that is a message of a mailbox file: the
 * mailbox, the folder path inside it (Inbox/Projects/...), the message's locator there, and its
 * From, To, Cc, Bcc, Date, Subject and Message-ID. Null for every other source.
 */
function mailboxOf(metadata: unknown): Record<string, unknown> | null {
  const m = typeof metadata === "string" ? JSON.parse(metadata) : metadata; // rows written before FIXES-1 hold the JSON as text (DEV-031)
  if (!m || typeof m !== "object" || typeof Reflect.get(m, "message_hash") !== "string" || typeof Reflect.get(m, "mailbox_path") !== "string") return null;
  const get = (k: string) => Reflect.get(m, k);
  return {
    mailbox_file: get("mailbox_file") ?? null,
    mailbox_format: get("mailbox_format") ?? null,
    mailbox_source_id: get("mailbox_source_id") ?? null,
    folder_path: get("folder_path") ?? "",
    message_locator: get("message_locator") ?? null,
    headers: get("headers") ?? null,
    ...(get("rendered") ? { rendered: get("rendered") } : {}),
    ...(get("truncated") ? { truncated: true } : {}),
    // BIGDATA-4 (answer 1): the PST it came from had a password; it was read anyway.
    ...(get("mailbox_password_protected") ? { mailbox_had_password: true } : {}),
  };
}

/** BIGDATA-4 (answer 1): a mailbox file (PST/OST) whose store had a password: it was read, and says so. */
function mailboxFileOf(metadata: unknown): Record<string, unknown> | null {
  const m = typeof metadata === "string" ? JSON.parse(metadata) : metadata; // rows written before FIXES-1 hold the JSON as text (DEV-031)
  if (!m || typeof m !== "object" || typeof Reflect.get(m, "mailbox_format") !== "string" || typeof Reflect.get(m, "message_hash") === "string") return null;
  if (Reflect.get(m, "password_protected") !== true) return null;
  return { format: Reflect.get(m, "mailbox_format"), had_password: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 6: get_document_page
// ─────────────────────────────────────────────────────────────────────────────
export const GetDocumentPageSchema = z.object({
  document_id: z.string().uuid().describe("Content Document UUID or Source UUID"),
  page: z.number().int().min(1).describe("1-indexed page number"),
}).strict();

/**
 * The page is read through its source, which must belong to MATTER_INVESTIGATION_ID: a
 * content document or source ID of another investigation in the tenant answers exactly as an
 * unknown ID does (DEV-029, D82; the same rule as DEV-026, D79).
 */
export async function handleGetDocumentPage(
  tx: Tx,
  ctx: MatterContext,
  args: z.infer<typeof GetDocumentPageSchema>,
) {
  const blocks = await tx<{
    id: string;
    sequence: number;
    block_type: string;
    text: string;
    char_start: number;
    char_end: number;
    bbox: unknown;
    page: number;
  }[]>`
    SELECT b.id, b.sequence, b.block_type, b.text, b.char_start, b.char_end, b.bbox, b.page
    FROM content_blocks b
    JOIN content_documents cd ON cd.id = b.content_document_id
    JOIN artifacts a ON a.id = cd.artifact_id
    JOIN sources s ON s.id = a.source_id
    WHERE (b.content_document_id = ${args.document_id} OR a.source_id = ${args.document_id})
      AND b.page = ${args.page}
      AND b.tenant_id = ${ctx.tenantId}
      AND s.tenant_id = ${ctx.tenantId}
      AND s.investigation_id = ${ctx.investigationId}
      AND s.deleted_at IS NULL
    ORDER BY b.sequence ASC;
  `;

  if (blocks.length === 0) {
    throw new Error(`Page ${args.page} not found for document ${args.document_id}.`);
  }

  return {
    document_id: args.document_id,
    page: args.page,
    blocks: blocks.map((b) => ({
      id: b.id,
      sequence: b.sequence,
      block_type: b.block_type,
      text: b.text,
      char_start: b.char_start,
      char_end: b.char_end,
      // An object for new rows, JSON text for rows written before FIXES-1 (DEV-031).
      bbox: readJsonb(b.bbox),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 7: get_download_link
// ─────────────────────────────────────────────────────────────────────────────
export const GetDownloadLinkSchema = z.object({
  document_id: z.string().uuid().describe("Source document UUID"),
}).strict();

export async function handleGetDownloadLink(
  tx: Tx,
  ctx: MatterContext,
  args: z.infer<typeof GetDownloadLinkSchema>,
) {
  const rows = await tx<{
    id: string;
    filename: string;
    storage_uri: string | null;
    sha256: string;
  }[]>`
    SELECT id, filename, storage_uri, sha256
    FROM sources
    WHERE id = ${args.document_id}
      AND investigation_id = ${ctx.investigationId}
      AND tenant_id = ${ctx.tenantId}
      AND deleted_at IS NULL;
  `;

  if (rows.length === 0 || !rows[0]) {
    throw new Error(`Document ${args.document_id} not found.`);
  }

  const s = rows[0];
  const storage = getObjectStore();
  const ttlSeconds = 900;

  let key: TenantScopedKey;
  if (s.storage_uri && (s.storage_uri.startsWith("gs://") || s.storage_uri.startsWith("gcs://"))) {
    const withoutPrefix = s.storage_uri.replace(/^(?:gs|gcs):\/\/[^/]+\//, "");
    key = withoutPrefix as TenantScopedKey;
  } else {
    key = createSourceStorageKey(ctx.tenantId, ctx.investigationId, s.sha256);
  }

  const signedUrl = await storage.signedUrl(key, ttlSeconds);

  return {
    document_id: s.id,
    filename: s.filename,
    download_url: signedUrl,
    expires_in_seconds: ttlSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 8: get_evidence
// ─────────────────────────────────────────────────────────────────────────────
export const GetEvidenceSchema = z.object({
  evidence_id: z.string().uuid().describe("The unique UUID of the evidence record"),
}).strict();

export async function handleGetEvidence(
  tx: Tx,
  ctx: MatterContext,
  args: z.infer<typeof GetEvidenceSchema>,
) {
  const rows = await tx<{
    id: string;
    source_id: string;
    content_block_id: string | null;
    locator: unknown;
    cited_text: string;
    span_hash: string;
    context_before: string;
    context_after: string;
    evidence_type: string;
    weight: string;
    weight_rationale: string | null;
    integrity_status: string;
    status: string;
    version: number;
    admitted_at: Date;
  }[]>`
    SELECT
      id, source_id, content_block_id, locator, cited_text, span_hash,
      context_before, context_after, evidence_type, weight, weight_rationale,
      integrity_status, status, version, admitted_at
    FROM evidence
    WHERE id = ${args.evidence_id}
      AND investigation_id = ${ctx.investigationId}
      AND tenant_id = ${ctx.tenantId}
      AND deleted_at IS NULL;
  `;

  if (rows.length === 0 || !rows[0]) {
    throw new Error(`Evidence record ${args.evidence_id} not found.`);
  }

  const e = rows[0];
  return {
    evidence: {
      id: e.id,
      source_id: e.source_id,
      content_block_id: e.content_block_id,
      locator: e.locator,
      cited_text: e.cited_text,
      span_hash: e.span_hash,
      context_before: e.context_before,
      context_after: e.context_after,
      evidence_type: e.evidence_type,
      weight: e.weight,
      weight_rationale: e.weight_rationale,
      integrity_status: e.integrity_status,
      status: e.status,
      version: e.version,
      admitted_at: e.admitted_at.toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 9: search
// ─────────────────────────────────────────────────────────────────────────────
export const SearchToolSchema = z.object({
  query: z.string().min(1).describe("Search query string (keywords, phrases in quotes, or entity:Name)"),
  mode: z.enum(["keyword", "exact", "entity", "hybrid"]).optional().default("keyword"),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  filters: z.object({
    source_id: z.string().uuid().optional(),
    document_type: z.string().optional(),
    custodian: z.string().optional(),
  }).optional().default({}),
}).strict();

export async function handleSearch(
  tx: Tx,
  ctx: MatterContext,
  args: z.infer<typeof SearchToolSchema>,
) {
  const queryStr = args.query.trim().toLowerCase();
  const chunkRows = await tx<{
    chunk_id: string;
    source_id: string;
    source_filename: string;
    source_class: string | null;
    status: string;
    text: string;
    created_at: Date;
  }[]>`
    SELECT
      c.id AS chunk_id,
      s.id AS source_id,
      s.filename AS source_filename,
      s.source_class,
      s.status,
      COALESCE(c.text, cb.text) AS text,
      c.created_at
    FROM chunks c
    JOIN content_documents cd ON cd.id = c.content_document_id
    JOIN artifacts a ON a.id = cd.artifact_id
    JOIN sources s ON s.id = a.source_id
    -- Text stored once (D94): a chunk with no text of its own is its one block.
    LEFT JOIN content_blocks cb ON c.text IS NULL AND cb.id = c.block_ids[1] AND cb.tenant_id = c.tenant_id
    WHERE c.investigation_id = ${ctx.investigationId}
      AND c.tenant_id = ${ctx.tenantId}
      AND s.status IN ('admitted', 'indexed', 'ready')
      AND s.withdrawn_at IS NULL
    -- c.id breaks ties (D97): every chunk of one file shares created_at, and with parallel workers
    -- their order changed between calls, so offset paging repeated and skipped hits (DEV-032).
    ORDER BY c.created_at DESC, c.id;
  `;

  const queryTokens = queryStr.replace(/[^\w\s~]/g, " ").split(/\s+/).filter(Boolean);
  const items: unknown[] = [];

  for (const row of chunkRows) {
    const textLower = row.text.toLowerCase();
    const matchedTerms: string[] = [];
    for (const t of queryTokens) {
      if (textLower.includes(t)) {
        matchedTerms.push(t);
      }
    }

    if (matchedTerms.length > 0) {
      const lexicalScore = matchedTerms.length / Math.max(1, queryTokens.length);
      const sourceQuality = row.source_class === "primary_record" ? 1.0 : 0.8;
      const combinedScore = Number((0.7 * lexicalScore + 0.3 * sourceQuality).toFixed(4));

      items.push({
        chunk_id: row.chunk_id,
        source_id: row.source_id,
        source_filename: row.source_filename,
        text: row.text,
        score: combinedScore,
        explanation: {
          retrieval_path: "lexical",
          requested_mode: args.mode,
          matched_terms: matchedTerms,
          matched_alias: null,
          signals: [
            { signal: "lexical_match", weight: 0.7, score: lexicalScore, contribution: Number((0.7 * lexicalScore).toFixed(4)) },
            { signal: "source_quality", weight: 0.3, score: sourceQuality, contribution: Number((0.3 * sourceQuality).toFixed(4)) },
          ],
          signals_not_computed: [
            "cross_encoder_relevance",
            "entity_overlap",
            "recency_or_period_fit",
            "question_alignment",
            "novelty",
            "interaction_signal",
            "near_duplicate_collapsing",
          ],
          raw_lexical_rank: items.length + 1,
          score_basis: "lexical_match + source_quality",
        },
      });
    }
  }

  return {
    query: args.query,
    mode: args.mode,
    total_hits: items.length,
    score_basis: "lexical_match + source_quality",
    weights_version: "wt_lex0.70_sq0.30",
    items: items.slice(args.offset, args.offset + args.limit),
  };
}
