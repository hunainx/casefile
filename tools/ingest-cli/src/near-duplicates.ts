/**
 * BIGDATA-3 near-duplicates (answer 4; D101; docs/PLAN-BIG-DATA.md section 14), as pure functions.
 *
 *   text -> normalised words -> 5-word shingles -> MinHash signature (256 values of 32 bits)
 *
 * Two documents' estimated similarity is the share of the 256 positions where their signatures
 * agree: an unbiased estimate of the Jaccard similarity of their shingle sets (standard error
 * about 0.019 at 0.9). 256, not 128: with 128 values the 100 MB run missed 3 of 16 near-duplicates
 * whose exact similarity was 0.925-0.936 (estimated 0.875-0.898); the estimator is not biased
 * (mean error +0.003 over 400 pairs), it is noise, which 256 values roughly halve at 0.93
 * (captures/bigdata3/near-dup-missed-probe-100MB.txt, minhash-bias-probe.txt).
 * A document is a near-duplicate when that estimate is at least 0.9 against
 * the FIRST document of a group; groups are stars around their first document, so no chain of
 * small edits can drift a group away from it.
 *
 * Fast at 10 GB (about 90,000 documents): no pair-by-pair comparison. LSH cuts each signature into
 * 32 bands of 8 values; two documents are compared only if at least one band is identical. At a
 * true similarity s, the chance of that is 1 - (1 - s^8)^32: above 0.99999 at 0.9, 0.97 at 0.75,
 * 0.42 at 0.6, 0.002 at 0.4. So every pair at 0.9 or more is compared, and few others are.
 * The measured cost is in docs/PLAN-BIG-DATA.md section 14.
 */

import { normaliseWords, shingleSet, SHINGLE_WORDS } from "../../../apps/api/src/services/text-similarity.js";

// The word and shingle rules live in one place, shared with the REST diff route (FIXES-1, DEV-035).
export { normaliseWords, shingleSet, SHINGLE_WORDS };

export const NEAR_DUPLICATE_METHOD = "minhash-w5-k256";
export const SIGNATURE_VALUES = 256;
export const SIGNATURE_BYTES = SIGNATURE_VALUES * 4;
export const LSH_BANDS = 32;
export const LSH_ROWS = 8;
export const NEAR_DUPLICATE_THRESHOLD = 0.9;

/** FNV-1a, 32 bits, over the string's UTF-16 code units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** MurmurHash3's 32-bit finaliser: a bijection that mixes every input bit into every output bit. */
function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface Signature {
  values: Uint32Array;
  /** The number of distinct shingles the signature was built from. */
  shingles: number;
}

/**
 * The MinHash signature of a text, or null when it has no words. Value i is the minimum over the
 * shingles of fmix32(h1 + i * h2), with h1 the shingle's FNV-1a hash and h2 an odd second hash of
 * it: 256 hash functions from two hashes per shingle (double hashing, then a full mix).
 */
export function minhashSignature(text: string): Signature | null {
  const hashes = new Set<number>();
  for (const s of shingleSet(text)) hashes.add(fnv1a(s));
  if (hashes.size === 0) return null;
  const values = new Uint32Array(SIGNATURE_VALUES).fill(0xffffffff);
  for (const h1 of hashes) {
    const h2 = (fmix32(h1 ^ 0x9e3779b9) | 1) >>> 0;
    for (let i = 0; i < SIGNATURE_VALUES; i++) {
      const v = fmix32((h1 + Math.imul(i, h2)) >>> 0);
      if (v < values[i]!) values[i] = v;
    }
  }
  return { values, shingles: hashes.size };
}

/** The share of positions where two signatures agree. */
export function estimateSimilarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < SIGNATURE_VALUES; i++) if (a[i] === b[i]) same++;
  return same / SIGNATURE_VALUES;
}

/** A signature as the 1,024 bytes stored in document_fingerprints.signature (big-endian). */
export function signatureToBytes(values: Uint32Array): Buffer {
  const b = Buffer.alloc(SIGNATURE_BYTES);
  for (let i = 0; i < SIGNATURE_VALUES; i++) b.writeUInt32BE(values[i]!, i * 4);
  return b;
}

export function signatureFromBytes(b: Uint8Array): Uint32Array {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const v = new Uint32Array(SIGNATURE_VALUES);
  for (let i = 0; i < SIGNATURE_VALUES; i++) v[i] = buf.readUInt32BE(i * 4);
  return v;
}

/**
 * The text a document is fingerprinted on: its blocks, in order. For an email, the Date and
 * Message-ID header lines are left out: they say when a message was sent, not what it says, so a
 * message sent again is the same message.
 */
export function fingerprintText(blocks: ReadonlyArray<{ block_type: string; text: string }>): string {
  return blocks
    .map((b) => (b.block_type === "email_header" ? b.text.split("\n").filter((l) => !/^(date|message-id):/i.test(l.trim())).join("\n") : b.text))
    .join("\n");
}

export function bandKey(values: Uint32Array, band: number): number {
  let h = 0x811c9dc5;
  for (let r = 0; r < LSH_ROWS; r++) {
    h ^= values[band * LSH_ROWS + r]!;
    h = Math.imul(h, 0x01000193);
    h = fmix32(h);
  }
  return h >>> 0;
}

/**
 * BIGDATA-4: a signature's 32 LSH band keys as stored in document_lsh.bands (bigint[]): the band
 * number in the high bits, so equal keys of different bands never match (band * 2^32 + key < 2^37).
 */
export function lshBands(values: Uint32Array): number[] {
  return Array.from({ length: LSH_BANDS }, (_, b) => b * 2 ** 32 + bandKey(values, b));
}

interface Entry {
  values: Uint32Array;
  /** The first document of the group this one belongs to, or null if it is a first document. */
  group: string | null;
  order: number;
}

/**
 * A set of fingerprinted documents with an LSH table per band, in memory. BIGDATA-3 kept the whole
 * matter's index here (about 5 KB per document: 376 MB of RSS for 71,834 fingerprints at 10 GB,
 * captures/bigdata3/near-dup-index-memory-probe.txt). Since BIGDATA-4 the index is in the database
 * (document_lsh) and this class holds only one batch of the near-duplicate pass (500 documents).
 */
export class NearDuplicateIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly bands: Array<Map<number, string[]>> = Array.from({ length: LSH_BANDS }, () => new Map());
  private counter = 0;

  get size(): number {
    return this.entries.size;
  }

  add(id: string, values: Uint32Array, group: string | null = null): void {
    this.entries.set(id, { values, group, order: this.counter++ });
    for (let b = 0; b < LSH_BANDS; b++) {
      const key = bandKey(values, b);
      const list = this.bands[b]!.get(key);
      if (list) list.push(id);
      else this.bands[b]!.set(key, [id]);
    }
  }

  /** Takes a document out again (its transaction rolled back). */
  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    for (let b = 0; b < LSH_BANDS; b++) {
      const key = bandKey(e.values, b);
      const list = this.bands[b]!.get(key);
      if (!list) continue;
      const rest = list.filter((x) => x !== id);
      if (rest.length) this.bands[b]!.set(key, rest);
      else this.bands[b]!.delete(key);
    }
    this.entries.delete(id);
  }

  /** Every document that shares at least one band with the signature. */
  candidates(values: Uint32Array): string[] {
    const seen = new Set<string>();
    for (let b = 0; b < LSH_BANDS; b++) for (const id of this.bands[b]!.get(bandKey(values, b)) ?? []) seen.add(id);
    return [...seen];
  }

  /**
   * The group this signature joins: among the candidates' groups, the first document with the
   * highest similarity at or above the threshold (ties: the earliest added), or null.
   */
  bestMatch(values: Uint32Array, threshold = NEAR_DUPLICATE_THRESHOLD): { id: string; similarity: number } | null {
    let best: { id: string; similarity: number; order: number } | null = null;
    const tried = new Set<string>();
    for (const c of this.candidates(values)) {
      const root = this.entries.get(c)!.group ?? c;
      if (tried.has(root)) continue;
      tried.add(root);
      const r = this.entries.get(root);
      if (!r) continue;
      const s = estimateSimilarity(values, r.values);
      if (s >= threshold && (!best || s > best.similarity || (s === best.similarity && r.order < best.order))) best = { id: root, similarity: s, order: r.order };
    }
    return best ? { id: best.id, similarity: best.similarity } : null;
  }
}
