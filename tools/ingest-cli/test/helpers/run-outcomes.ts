import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDbUrl, withTenant, createDbClient, type Tx } from "@casefile/db";
import { bootstrap } from "../../src/bootstrap.js";

/**
 * BIGDATA-4 test helpers: a fresh fake matter, and what a run kept and skipped, written as lines
 * that do not depend on ids, timing or the folder the corpus was copied to, so two runs of the same
 * corpus (1 worker and N workers, or a run stopped and resumed) can be compared line by line.
 */

export interface Matter {
  tenantId: string;
  investigationId: string;
  userId: string;
}

export async function newMatter(label: string, base: string): Promise<Matter> {
  const envDir = join(base, `${label}-env`);
  mkdirSync(envDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const m = await bootstrap({ name: `B4 ${label} ${stamp}`, investigationName: `B4 ${label}`, email: `bigdata4-${label}-${stamp}@casefile.test`, matter: `bigdata4-${label}-${stamp}`, envDir, dbUrl: getDbUrl() });
  return { tenantId: m.tenantId, investigationId: m.investigationId, userId: m.userId };
}

export async function q<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = createDbClient(getDbUrl(), { max: 1 });
  try {
    return await withTenant(tenantId, fn, c);
  } finally {
    await c.end();
  }
}

/** A path relative to the corpus folder, with forward slashes (the part after a '#' unchanged). */
export function relPath(p: string | null | undefined, base: string): string {
  if (!p) return "";
  const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const s = p.replace(/\\/g, "/");
  return s.startsWith(`${b}/`) ? s.slice(b.length + 1) : s;
}

/**
 * Every object the matter's runs reached, one line each, sorted: a source ("kept <status>"), or a
 * skip decision that no include superseded ("<decision> <rule> of <original>"), or a failure
 * (a source.ingest_failed audit row). An ingest-stage skip that supersedes a triage "ingest" replaces it.
 */
export async function keptSkipped(m: Matter, base: string): Promise<string[]> {
  return q(m.tenantId, async (tx) => {
    const sources = await tx<{ path: string | null; status: string }[]>`
      SELECT s.metadata->>'source_path' AS path, s.status FROM sources s
      WHERE s.tenant_id = ${m.tenantId} AND s.investigation_id = ${m.investigationId}`;
    const decisions = await tx<{ id: string; path: string; decision: string; rule: string | null; duplicate_of_path: string | null; stage: string }[]>`
      SELECT d.id, d.path, d.decision, d.rule, d.duplicate_of_path, d.stage FROM ingest_decisions d
      WHERE d.tenant_id = ${m.tenantId} AND d.investigation_id = ${m.investigationId} AND d.decision <> 'ingest'
        AND NOT EXISTS (SELECT 1 FROM ingest_decisions s WHERE s.tenant_id = d.tenant_id AND s.supersedes = d.id AND s.stage = 'include')`;
    const failures = await tx<{ path: string | null; reason: string | null }[]>`
      SELECT after->>'path' AS path, after->>'reason' AS reason FROM audit_events
      WHERE tenant_id = ${m.tenantId} AND action = 'source.ingest_failed'`;
    const lines = [
      ...sources.map((s) => `${relPath(s.path, base)}\tkept ${s.status}`),
      ...decisions.map((d) => `${relPath(d.path, base)}\t${d.decision} ${d.rule ?? ""}${d.duplicate_of_path ? ` of ${relPath(d.duplicate_of_path, base)}` : ""}`),
      ...failures.map((f) => `${relPath(f.path, base)}\tfailed ${f.reason ?? ""}`),
    ];
    return lines.sort();
  });
}

/** Every near-duplicate link: "<document> -> <first document of its group> (<similarity>)", sorted. */
export async function nearDuplicateLinks(m: Matter, base: string): Promise<string[]> {
  return q(m.tenantId, async (tx) => {
    const rows = await tx<{ path: string | null; root: string | null; similarity: string | null }[]>`
      SELECT s.metadata->>'source_path' AS path, r.metadata->>'source_path' AS root, f.similarity::text AS similarity
      FROM document_fingerprints f
      JOIN sources s ON s.id = f.source_id
      LEFT JOIN sources r ON r.id = f.near_duplicate_of
      WHERE f.tenant_id = ${m.tenantId} AND f.investigation_id = ${m.investigationId} AND f.near_duplicate_of IS NOT NULL`;
    return rows.map((r) => `${relPath(r.path, base)} -> ${relPath(r.root, base)} (${r.similarity})`).sort();
  });
}

/** Row counts of everything an ingest writes for the matter, and the bucket objects it stored. */
export async function rowCounts(m: Matter): Promise<Record<string, number>> {
  return q(m.tenantId, async (tx) => {
    const one = async (t: string) => Number((await tx.unsafe(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [m.tenantId]))[0]!.n);
    const out: Record<string, number> = {};
    for (const t of ["sources", "source_instances", "acquisition_records", "artifacts", "content_documents", "content_blocks", "chunks", "ingest_decisions", "document_fingerprints", "audit_events"]) {
      out[t] = await one(t);
    }
    return out;
  });
}
