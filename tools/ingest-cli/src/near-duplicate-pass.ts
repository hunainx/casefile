import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { withTenant, type Tx } from "@casefile/db";
import type { RecordContext } from "./triage.js";
import { RULE_VERSIONS } from "./triage-rules.js";
import { NEAR_DUPLICATE_METHOD, NEAR_DUPLICATE_THRESHOLD, estimateSimilarity, lshBands, signatureFromBytes } from "./near-duplicates.js";
import { insertBatches } from "./batch-insert.js";

/**
 * BIGDATA-4 near-duplicate pass (plan section 16; D101's rule unchanged). The index is in the
 * database: document_lsh holds each fingerprinted document's 32 LSH band keys and its group, and
 * document_lsh_bands the lookup (band key -> groups).
 * Workers write a document's signature with the document (ingest_signatures); this pass then takes
 * the signatures in READING ORDER, for every document before the first item of the run that is not
 * finished, and for each one: the documents that share a band with it (from the database, and from
 * this batch), their groups' first documents, the most similar of those at 0.9 or more (ties: the
 * one indexed first), and writes its document_fingerprints and document_lsh rows. Because the order
 * is the reading order and not the order workers finished in, the groups are the same for any number
 * of workers, and the same as the one-process ingest's.
 *
 * One pass at a time per investigation (an advisory lock), in batches of 500 documents, so a worker
 * holds one batch, never the matter's index. Fingerprints written before migration 0031 get their
 * document_lsh row first, in the order they were written (the order the in-memory index used).
 */

const BATCH = 500;
const lockKey = (investigationId: string) => `casefile-near-duplicates:${investigationId}`;
const backfilled = new Set<string>();
/**
 * A caller's place in the pass: the reading-order place of the last document it saw grouped.
 * Documents are grouped in reading order, so every one before it is done: the caller's next batch
 * is read from there (an index range), not from the run's first document again. Another worker may
 * be further on; the rows between are skipped by the NOT EXISTS check, once. A worker starts with a
 * fresh one (a run whose failed items were retried has documents before any old place).
 */
export interface PassCursor {
  mark: [number, number, number, number];
}
export const newPassCursor = (): PassCursor => ({ mark: [-1, -1, -1, -1] });

interface SignatureRow {
  top_seq: number;
  part_no: number;
  entry_index: number;
  node_index: number;
  run_id: string;
  source_id: string;
  content_document_id: string;
  shingle_count: number;
  signature: Buffer;
}

/**
 * The groups (their first documents) that have one of the batch's band keys: $1 tenant, $2 investigation, $3 keys.
 * Plain bigint equality on document_lsh_bands' primary key, because that is what an index can serve under
 * row-level security (migration 0031 says why an array index cannot); near-duplicate-lookup.integration.test.ts.
 */
export const BAND_LOOKUP = `SELECT band_key::text AS band, root_source_id FROM document_lsh_bands
    WHERE tenant_id = $1 AND investigation_id = $2 AND band_key = ANY($3::bigint[])`;

interface LshRow { tenant_id: string; investigation_id: string; source_id: string; content_document_id: string; root_source_id: string; bands: number[] }

/** A batch's document_lsh rows and their document_lsh_bands rows (one per band key and group), in one transaction. */
async function insertLsh(tx: Tx, rows: LshRow[]): Promise<void> {
  for (const b of insertBatches(rows, () => 400)) {
    await tx`INSERT INTO document_lsh ${tx(b, "tenant_id", "investigation_id", "source_id", "content_document_id", "root_source_id", "bands")} ON CONFLICT (content_document_id) DO NOTHING`;
  }
  const seen = new Set<string>();
  const bands: { tenant_id: string; investigation_id: string; band_key: string; root_source_id: string }[] = [];
  for (const r of rows) {
    for (const k of r.bands) {
      const id = `${r.investigation_id}:${k}:${r.root_source_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      bands.push({ tenant_id: r.tenant_id, investigation_id: r.investigation_id, band_key: String(k), root_source_id: r.root_source_id });
    }
  }
  for (const b of insertBatches(bands, () => 100)) {
    await tx`INSERT INTO document_lsh_bands ${tx(b, "tenant_id", "investigation_id", "band_key", "root_source_id")} ON CONFLICT DO NOTHING`;
  }
}

/** Runs the pass as far as it can go now. Returns how many documents it grouped (or found alone). */
export async function advanceNearDuplicates(db: postgres.Sql, rec: RecordContext, runId: string, cursor: PassCursor = newPassCursor()): Promise<{ documents: number; ms: number }> {
  const t0 = performance.now();
  let documents = 0;
  for (;;) {
    const n = await withTenant(rec.resolvedTenantId, (tx) => passBatch(tx, rec, runId, cursor), db);
    if (n <= 0) break;
    documents += n;
  }
  return { documents, ms: performance.now() - t0 };
}

async function backfillOldFingerprints(tx: Tx, rec: RecordContext): Promise<void> {
  const t = rec.resolvedTenantId;
  for (;;) {
    const old = await tx<{ source_id: string; content_document_id: string; near_duplicate_of: string | null; signature: Buffer }[]>`
      SELECT f.source_id, f.content_document_id, f.near_duplicate_of, f.signature FROM document_fingerprints f
      WHERE f.tenant_id = ${t} AND f.investigation_id = ${rec.investigationId}
        AND NOT EXISTS (SELECT 1 FROM document_lsh l WHERE l.content_document_id = f.content_document_id)
      ORDER BY f.created_at, f.id LIMIT 2000`;
    if (old.length === 0) return;
    const rows = old.map((o) => ({
      tenant_id: t, investigation_id: rec.investigationId, source_id: o.source_id, content_document_id: o.content_document_id,
      root_source_id: o.near_duplicate_of ?? o.source_id, bands: lshBands(signatureFromBytes(o.signature)),
    }));
    await insertLsh(tx, rows);
  }
}

/** One batch; -1 when another pass holds the lock, 0 when there is nothing to do now. */
async function passBatch(tx: Tx, rec: RecordContext, runId: string, cursor: PassCursor): Promise<number> {
  const t = rec.resolvedTenantId;
  const lock = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey(rec.investigationId)}, 0)) AS locked`;
  if (!lock[0]!.locked) return -1;
  // Once per run and process: fingerprints written before migration 0031 get their LSH rows first.
  if (!backfilled.has(runId)) {
    await backfillOldFingerprints(tx, rec);
    backfilled.add(runId);
  }
  // Documents at or after the first item of the run that is not finished wait for it.
  const first = await tx<{ top_seq: number; part_no: number }[]>`
    SELECT top_seq, part_no FROM ingest_work WHERE tenant_id = ${t} AND run_id = ${runId} AND state IN ('pending', 'discovered', 'sequenced')
    ORDER BY top_seq, part_no LIMIT 1`;
  const limit = first[0];
  const w = cursor.mark;
  const batch = await tx<SignatureRow[]>`
    SELECT s.run_id, s.source_id, s.content_document_id, s.shingle_count, s.signature, s.top_seq, s.part_no, s.entry_index, s.node_index
    FROM ingest_signatures s
    WHERE s.tenant_id = ${t} AND s.run_id = ${runId}
      AND (s.top_seq, s.part_no, s.entry_index, s.node_index) > (${w[0]}, ${w[1]}, ${w[2]}, ${w[3]})
      AND (${limit ? limit.top_seq : null}::int IS NULL OR (s.top_seq, s.part_no) < (${limit?.top_seq ?? 0}, ${limit?.part_no ?? 0}))
      AND NOT EXISTS (SELECT 1 FROM document_fingerprints f WHERE f.tenant_id = s.tenant_id AND f.content_document_id = s.content_document_id)
    ORDER BY s.top_seq, s.part_no, s.entry_index, s.node_index
    LIMIT ${BATCH}`;
  if (batch.length === 0) return 0;
  const last = batch[batch.length - 1]!;
  const mark: [number, number, number, number] = [last.top_seq, last.part_no, last.entry_index, last.node_index];

  const docs = batch.map((s) => {
    const values = signatureFromBytes(s.signature);
    return { ...s, values, bands: lshBands(values) };
  });
  const wanted = [...new Set(docs.flatMap((d) => d.bands))];
  const candidates = await tx.unsafe<{ band: string; root_source_id: string }[]>(BAND_LOOKUP, [t, rec.investigationId, wanted]);
  const byBand = new Map<number, string[]>(); // band key -> roots of the documents that have it
  for (const c of candidates) {
    const key = Number(c.band);
    const list = byBand.get(key);
    if (list) list.push(c.root_source_id);
    else byBand.set(key, [c.root_source_id]);
  }
  const rootIds = [...new Set(candidates.map((c) => c.root_source_id))];
  const roots = new Map<string, { values: Uint32Array; order: number }>();
  if (rootIds.length > 0) {
    const rows = await tx<{ source_id: string; signature: Buffer; order_seq: string }[]>`
      SELECT f.source_id, f.signature, l.order_seq::text AS order_seq FROM document_fingerprints f
      JOIN document_lsh l ON l.content_document_id = f.content_document_id AND l.tenant_id = f.tenant_id
      WHERE f.tenant_id = ${t} AND f.investigation_id = ${rec.investigationId} AND f.source_id = ANY(${rootIds})
      ORDER BY l.order_seq`;
    for (const r of rows) if (!roots.has(r.source_id)) roots.set(r.source_id, { values: signatureFromBytes(r.signature), order: Number(r.order_seq) });
  }

  // This batch's documents are indexed after everything in the database, in reading order.
  let localOrder = Number.MAX_SAFE_INTEGER - docs.length - 1;
  const fingerprints = [];
  const lsh = [];
  for (const d of docs) {
    let best: { id: string; similarity: number; order: number } | null = null;
    const tried = new Set<string>();
    for (const b of d.bands) {
      for (const root of byBand.get(b) ?? []) {
        if (tried.has(root)) continue;
        tried.add(root);
        const r = roots.get(root);
        if (!r) continue;
        const s = estimateSimilarity(d.values, r.values);
        if (s >= NEAR_DUPLICATE_THRESHOLD && (!best || s > best.similarity || (s === best.similarity && r.order < best.order))) best = { id: root, similarity: s, order: r.order };
      }
    }
    const group = best?.id ?? null;
    fingerprints.push({
      id: randomUUID(), tenant_id: t, investigation_id: rec.investigationId, run_id: d.run_id, source_id: d.source_id, content_document_id: d.content_document_id,
      method: NEAR_DUPLICATE_METHOD, rule_version: RULE_VERSIONS["near-duplicate"], shingle_count: d.shingle_count, signature: d.signature,
      near_duplicate_of: group, similarity: best ? Math.round(best.similarity * 10000) / 10000 : null,
    });
    lsh.push({ tenant_id: t, investigation_id: rec.investigationId, source_id: d.source_id, content_document_id: d.content_document_id, root_source_id: group ?? d.source_id, bands: d.bands });
    const root = group ?? d.source_id;
    for (const b of d.bands) {
      const list = byBand.get(b);
      if (list) list.push(root);
      else byBand.set(b, [root]);
    }
    if (!group) roots.set(d.source_id, { values: d.values, order: localOrder++ });
  }
  for (const b of insertBatches(fingerprints, () => 1200)) {
    await tx`INSERT INTO document_fingerprints ${tx(b, "id", "tenant_id", "investigation_id", "run_id", "source_id", "content_document_id", "method", "rule_version", "shingle_count", "signature", "near_duplicate_of", "similarity")}
             ON CONFLICT (tenant_id, content_document_id) DO NOTHING`;
  }
  await insertLsh(tx, lsh);
  cursor.mark = mark; // (set before the commit; if the commit fails the worker's next item fails too, and a new worker starts afresh)
  return docs.length;
}

/** How many of a run's documents were grouped under a first document (the run's near_duplicates counter). */
export async function countNearDuplicates(tx: Tx, rec: RecordContext, runId: string, topSeq?: number): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM document_fingerprints f
    WHERE f.tenant_id = ${rec.resolvedTenantId} AND f.run_id = ${runId} AND f.near_duplicate_of IS NOT NULL
      AND (${topSeq ?? null}::int IS NULL OR EXISTS (SELECT 1 FROM ingest_signatures s WHERE s.content_document_id = f.content_document_id AND s.top_seq = ${topSeq ?? null}::int))`;
  return rows[0]?.n ?? 0;
}
