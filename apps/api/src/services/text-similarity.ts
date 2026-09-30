/**
 * Text similarity shared by the ingest's near-duplicate rule (tools/ingest-cli/src/near-duplicates.ts,
 * D101, which ESTIMATES it with MinHash for every document) and the REST diff route (FIXES-1,
 * DEV-035, which computes it EXACTLY for the two documents asked about).
 *
 *   text -> normalised words -> 5-word shingles -> Jaccard similarity of the two shingle sets
 */

export const SHINGLE_WORDS = 5;

/** Lower-case words, split on anything that is not a letter or a digit, after Unicode NFKC. */
export function normaliseWords(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** The distinct shingles of a text: every run of 5 consecutive words (all the words if fewer). */
export function shingleSet(text: string): Set<string> {
  const words = normaliseWords(text);
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length < SHINGLE_WORDS) {
    out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  return out;
}

/** The exact Jaccard similarity of two texts' shingle sets: 1 for the same words, 0 for nothing shared. */
export function textSimilarity(a: string, b: string): number {
  const A = shingleSet(a);
  const B = shingleSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface LineDiff {
  /** Lines of the second text that the first does not have, in the second's order. */
  added_lines: string[];
  /** Lines of the first text that the second does not have, in the first's order. */
  removed_lines: string[];
  /** "line N" for every position both texts have where the lines differ. */
  changed_clauses: string[];
}

/** A plain line comparison (lines trimmed, empty lines ignored); nothing is inferred about clauses. */
export function lineDiff(a: string, b: string): LineDiff {
  const la = a.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lb = b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const inA = new Set(la);
  const inB = new Set(lb);
  const changed: string[] = [];
  for (let i = 0; i < Math.min(la.length, lb.length); i++) if (la[i] !== lb[i]) changed.push(`line ${i + 1}`);
  return { added_lines: lb.filter((l) => !inA.has(l)), removed_lines: la.filter((l) => !inB.has(l)), changed_clauses: changed };
}
