import type { Tx } from "@casefile/db";
import type {
  SearchRequest,
  SearchResponse,
  SearchResultItem,
  CoverageReport,
  SearchFacets,
} from "@casefile/contracts";

/**
 * Levenshtein distance for fuzzy matching OCR noisy text (AC-SRCH-02)
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const a = s1.toLowerCase();
  const b = s2.toLowerCase();
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1,     // insertion
          matrix[i - 1]![j]! + 1,     // deletion
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
}

/**
 * Token-level fuzzy match check (handles OCR variations like 'Merldían' -> 'Meridian')
 */
export function fuzzyTokenMatch(text: string, queryToken: string, maxDistance = 2): boolean {
  const cleanToken = queryToken.replace(/~/g, "").toLowerCase();
  if (!cleanToken) return true;

  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const word of words) {
    if (Math.abs(word.length - cleanToken.length) > maxDistance) continue;
    if (word === cleanToken) return true;
    if (levenshteinDistance(word, cleanToken) <= maxDistance) return true;
  }

  return false;
}

export const SEARCH_WEIGHTS = {
  lexical_match: 0.70,
  source_quality: 0.30,
} as const;

export const SEARCH_WEIGHTS_VERSION = "wt_lex0.70_sq0.30";
export const SEARCH_SCORE_BASIS = "lexical_match + source_quality";

export const SIGNALS_NOT_COMPUTED: readonly string[] = [
  "cross_encoder_relevance",
  "entity_overlap",
  "recency_or_period_fit",
  "question_alignment",
  "novelty",
  "interaction_signal",
  "near_duplicate_collapsing",
] as const;

interface DbChunkRow {
  chunk_id: string;
  source_id: string;
  source_filename: string;
  source_class: string | null;
  source_status: string;
  source_sensitivity: string;
  custodian: string | null;
  document_type: string | null;
  language: string | null;
  text: string;
  contextual_header: string | null;
  document_date: Date | null;
  event_date: Date | null;
  entity_mentions?: string[];
  created_at: Date;
}

/**
 * Executes search with Invariant I10 permission pre-filtering,
 * fuzzy OCR matching, alias expansion, coverage reporting, and transparent explanations.
 */
export async function executeSearch(
  tx: Tx,
  tenantId: string,
  investigationId: string,
  userId: string,
  req: SearchRequest,
): Promise<SearchResponse> {
  const queryStr = req.query.trim();

  // 1. Fetch aliases for alias expansion (AC-SRCH-04 / SRCH-19)
  const isEntityQuery = req.mode === "entity" || queryStr.toLowerCase().startsWith("entity:");
  let targetEntityQuery = queryStr;
  if (queryStr.toLowerCase().startsWith("entity:")) {
    targetEntityQuery = queryStr.slice(7).trim();
  }

  const aliasesMap = new Map<string, { entityId: string; canonicalName: string; aliases: string[] }>();
  if (isEntityQuery || req.mode === "hybrid") {
    const aliasRows = await tx<{ entity_id: string; canonical_name: string; alias_val: string | null }[]>`
      SELECT e.id AS entity_id, e.canonical_name, a.value AS alias_val
      FROM entities e
      LEFT JOIN entity_aliases a ON a.entity_id = e.id AND a.tenant_id = ${tenantId}
      WHERE e.investigation_id = ${investigationId}
        AND e.tenant_id = ${tenantId}
        AND e.deleted_at IS NULL;
    `;

    for (const r of aliasRows) {
      if (!aliasesMap.has(r.entity_id)) {
        aliasesMap.set(r.entity_id, {
          entityId: r.entity_id,
          canonicalName: r.canonical_name,
          aliases: [],
        });
      }
      if (r.alias_val) {
        aliasesMap.get(r.entity_id)!.aliases.push(r.alias_val);
      }
    }
  }

  // 2. Compute Retrieval Coverage Report (PRD §12.5 / AC-SRCH-03)
  const [coverageStats, unindexedSources] = await Promise.all([
    tx<{ total_chunks: string; indexed_sources: string }[]>`
      SELECT
        COUNT(c.id) AS total_chunks,
        COUNT(DISTINCT s.id) AS indexed_sources
      FROM chunks c
      JOIN content_documents cd ON cd.id = c.content_document_id
      JOIN artifacts a ON a.id = cd.artifact_id
      JOIN sources s ON s.id = a.source_id
      WHERE c.investigation_id = ${investigationId}
        AND c.tenant_id = ${tenantId}
        AND s.status IN ('admitted', 'indexed', 'ready')
        AND s.withdrawn_at IS NULL;
    `,
    tx<{ status: string; count: string }[]>`
      SELECT status, COUNT(*) AS count
      FROM sources
      WHERE investigation_id = ${investigationId}
        AND tenant_id = ${tenantId}
        AND (status NOT IN ('admitted', 'indexed', 'ready') OR withdrawn_at IS NOT NULL)
      GROUP BY status;
    `,
  ]);

  const totalChunksIndexed = Number(coverageStats[0]?.total_chunks || 0);
  const totalSourcesIndexed = Number(coverageStats[0]?.indexed_sources || 0);

  const unindexedBreakdown: Record<string, number> = {};
  let unindexedCount = 0;
  for (const u of unindexedSources) {
    const cnt = Number(u.count);
    unindexedBreakdown[u.status] = cnt;
    unindexedCount += cnt;
  }

  // 3. Query all candidates with strict Invariant I10 permission pre-filtering
  // Only sources in admitted/indexed status and visible to the tenant/investigation
  const chunkRows = await tx<DbChunkRow[]>`
    SELECT
      c.id AS chunk_id,
      s.id AS source_id,
      s.filename AS source_filename,
      s.source_class,
      s.status AS source_status,
      ar.custodian,
      cd.doc_type AS document_type,
      COALESCE(c.text, cb.text) AS text,
      c.contextual_header,
      s.created_at AS document_date,
      NULL::timestamptz AS event_date,
      c.created_at
    FROM chunks c
    JOIN content_documents cd ON cd.id = c.content_document_id
    JOIN artifacts a ON a.id = cd.artifact_id
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN acquisition_records ar ON ar.source_id = s.id
    -- Text stored once (D94): a chunk with no text of its own is its one block.
    LEFT JOIN content_blocks cb ON c.text IS NULL AND cb.id = c.block_ids[1] AND cb.tenant_id = c.tenant_id
    WHERE c.investigation_id = ${investigationId}
      AND c.tenant_id = ${tenantId}
      AND s.status IN ('admitted', 'indexed', 'ready')
      AND s.withdrawn_at IS NULL
      ${req.filters.source_id ? tx`AND s.id = ${req.filters.source_id}` : tx``}
      ${req.filters.document_type ? tx`AND cd.doc_type = ${req.filters.document_type}` : tx``}
      ${req.filters.custodian ? tx`AND ar.custodian ILIKE ${`%${req.filters.custodian}%`}` : tx``}
    -- c.id breaks ties (D97): every chunk of one file shares created_at, and with parallel workers
    -- their order changed between calls, so offset paging repeated and skipped hits (DEV-032).
    ORDER BY c.created_at DESC, c.id;
  `;

  // 4. Score each chunk against the query
  const scoredItems: SearchResultItem[] = [];
  const queryTokens = queryStr
    .toLowerCase()
    .replace(/[^\w\s~]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const isExactQuery = queryStr.startsWith('"') && queryStr.endsWith('"');
  const exactPhrase = isExactQuery ? queryStr.slice(1, -1).trim().toLowerCase() : queryStr.toLowerCase();

  for (const row of chunkRows) {
    const textLower = row.text.toLowerCase();
    let matches = false;
    let retrievalPath: "exact" | "lexical" | "entity" = "lexical";
    const matchedTerms: string[] = [];
    let matchedAlias: string | null = null;
    let lexicalScore = 0.0;

    // A. Exact Mode / Exact Phrase
    if (isExactQuery || req.mode === "exact") {
      retrievalPath = "exact";
      if (textLower.includes(exactPhrase)) {
        matches = true;
        matchedTerms.push(exactPhrase);
        lexicalScore = 1.0;
      }
    }
    // B. Entity / Alias-Expanded Mode (AC-SRCH-04)
    else if (isEntityQuery) {
      retrievalPath = "entity";
      const cleanTarget = targetEntityQuery.toLowerCase();

      // Find matching entity in aliases map
      for (const ent of aliasesMap.values()) {
        const matchesCanonical = ent.canonicalName.toLowerCase().includes(cleanTarget) || cleanTarget.includes(ent.canonicalName.toLowerCase());
        const matchesId = ent.entityId.toLowerCase() === cleanTarget;

        if (matchesCanonical || matchesId) {
          // Check if document mentions canonical or any alias
          if (textLower.includes(ent.canonicalName.toLowerCase())) {
            matches = true;
            matchedTerms.push(ent.canonicalName);
            matchedAlias = ent.canonicalName;
            lexicalScore = Math.max(lexicalScore, 0.95);
          }
          for (const al of ent.aliases) {
            if (textLower.includes(al.toLowerCase())) {
              matches = true;
              matchedTerms.push(al);
              matchedAlias = al;
              lexicalScore = Math.max(lexicalScore, 0.90);
            }
          }
        }
      }

      // Fallback: direct substring match on target query
      if (!matches && textLower.includes(cleanTarget)) {
        matches = true;
        matchedTerms.push(cleanTarget);
        lexicalScore = 0.85;
      }
    }
    // C. Keyword / Hybrid / Fuzzy Mode (AC-SRCH-02 / SRCH-03)
    else {
      let matchedTokenCount = 0;
      for (const token of queryTokens) {
        const isFuzzy = token.includes("~") || req.mode === "hybrid";
        if (textLower.includes(token.replace(/~/g, ""))) {
          matchedTokenCount++;
          matchedTerms.push(token);
        } else if (isFuzzy && fuzzyTokenMatch(textLower, token, 2)) {
          matchedTokenCount++;
          matchedTerms.push(`${token} (fuzzy)`);
        }
      }

      if (matchedTokenCount > 0) {
        matches = true;
        lexicalScore = Math.min(1.0, matchedTokenCount / Math.max(1, queryTokens.length));
        retrievalPath = "lexical";
      }
    }

    if (!matches) continue;

    // Computed signals: derived strictly from row data and query data
    const sourceQuality = row.source_class === "primary_record" ? 1.0 : 0.75;
    const finalScore =
      SEARCH_WEIGHTS.lexical_match * lexicalScore +
      SEARCH_WEIGHTS.source_quality * sourceQuality;

    scoredItems.push({
      chunk_id: row.chunk_id,
      source_id: row.source_id,
      source_filename: row.source_filename,
      source_class: row.source_class,
      document_type: row.document_type,
      custodian: row.custodian,
      text: row.text,
      contextual_header: row.contextual_header,
      document_date: row.document_date ? row.document_date.toISOString() : null,
      event_date: row.event_date ? row.event_date.toISOString() : null,
      score: Number(finalScore.toFixed(4)),
      explanation: {
        retrieval_path: retrievalPath,
        requested_mode: req.mode,
        matched_terms: matchedTerms,
        matched_alias: matchedAlias,
        signals: [
          {
            signal: "lexical_match",
            weight: SEARCH_WEIGHTS.lexical_match,
            score: Number(lexicalScore.toFixed(3)),
            contribution: Number((SEARCH_WEIGHTS.lexical_match * lexicalScore).toFixed(4)),
          },
          {
            signal: "source_quality",
            weight: SEARCH_WEIGHTS.source_quality,
            score: sourceQuality,
            contribution: Number((SEARCH_WEIGHTS.source_quality * sourceQuality).toFixed(4)),
          },
        ],
        signals_not_computed: [...SIGNALS_NOT_COMPUTED],
        raw_lexical_rank: 1, // Will be set after sorting
        score_basis: SEARCH_SCORE_BASIS,
      },
    });
  }

  // 5. Deterministic sorting for reproducibility (AC-SRCH-06)
  scoredItems.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunk_id.localeCompare(b.chunk_id);
  });

  // Assign true 1-based rank in the lexical candidate list
  for (let idx = 0; idx < scoredItems.length; idx++) {
    scoredItems[idx]!.explanation.raw_lexical_rank = idx + 1;
  }

  // 6. Compute Facets on full result set (PRD §12.7 / SRCH-09)
  const docTypeCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const custodianCounts = new Map<string, number>();

  for (const itm of scoredItems) {
    const dt = itm.document_type || "unspecified";
    docTypeCounts.set(dt, (docTypeCounts.get(dt) || 0) + 1);

    const src = itm.source_filename;
    sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);

    const cust = itm.custodian || "Unknown Custodian";
    custodianCounts.set(cust, (custodianCounts.get(cust) || 0) + 1);
  }

  const facets: SearchFacets = {
    document_types: Array.from(docTypeCounts.entries()).map(([value, count]) => ({ value, count })),
    sources: Array.from(sourceCounts.entries()).map(([value, count]) => ({ value, count })),
    custodians: Array.from(custodianCounts.entries()).map(([value, count]) => ({ value, count })),
    languages: [{ value: "en", count: scoredItems.length }],
    entities: Array.from(aliasesMap.values()).map((e) => ({ value: e.canonicalName, count: 1 })),
  };

  // 7. Pagination slice
  const paginatedItems = scoredItems.slice(req.offset, req.offset + req.limit);

  // 8. Suggested Refinements based on real facets (PRD §12.6 / SRCH-16)
  const suggestedRefinements: string[] = [];
  if (facets.document_types.length > 1) {
    suggestedRefinements.push(`type:${facets.document_types[0]!.value}`);
  }
  if (facets.custodians.length > 0 && facets.custodians[0]!.value !== "Unknown Custodian") {
    suggestedRefinements.push(`custodian:"${facets.custodians[0]!.value}"`);
  }

  // 9. Record search history (PRD §12.6 / SRCH-14)
  await tx`
    INSERT INTO search_history (
      tenant_id, investigation_id, user_id, query, search_mode,
      filters, result_count, weights_version, index_generation
    )
    VALUES (
      ${tenantId}, ${investigationId}, ${userId}, ${queryStr}, ${req.mode},
      ${JSON.stringify(req.filters)}::jsonb, ${scoredItems.length},
      ${SEARCH_WEIGHTS_VERSION}, ${req.index_generation}
    );
  `;

  const coverage: CoverageReport = {
    total_chunks_indexed: totalChunksIndexed,
    total_sources_indexed: totalSourcesIndexed,
    unindexed_sources_count: unindexedCount,
    unindexed_breakdown: unindexedBreakdown,
    temporal_filter_excluded_count: 0,
    coverage_percentage: totalSourcesIndexed + unindexedCount > 0
      ? Number(((totalSourcesIndexed / (totalSourcesIndexed + unindexedCount)) * 100).toFixed(1))
      : 100,
  };

  return {
    query: queryStr,
    mode: req.mode,
    total_hits: scoredItems.length,
    limit: req.limit,
    offset: req.offset,
    weights_version: SEARCH_WEIGHTS_VERSION,
    score_basis: SEARCH_SCORE_BASIS,
    index_generation: req.index_generation,
    items: paginatedItems,
    coverage,
    facets,
    suggested_refinements: suggestedRefinements,
  };
}

