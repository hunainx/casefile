import { describe, it, expect } from "vitest";

/**
 * BIGDATA-3 near-duplicate fingerprints as pure functions (D101): normalised words, 5-word
 * shingles, a 256-value MinHash (128 until the 100 MB run, D101), and LSH in 32 bands of 8 values to find candidates without
 * comparing every pair. Loaded per test, so each fails on its own until it exists.
 */
const nd = () => import("../src/near-duplicates.js");

let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const vocab = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}`);
const words = (n: number) => Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]!);

describe("BIGDATA-3 near-duplicate fingerprints", () => {
  it("normalises text to lower-case words, whatever the punctuation, spacing and Unicode form", async () => {
    const { normaliseWords } = await nd();
    expect(normaliseWords("Hello,   WORLD!\n\tSecond-line: café ﬁne 42")).toEqual(["hello", "world", "second", "line", "café", "fine", "42"]);
    expect(normaliseWords(" \n ,.; ")).toEqual([]);
  });

  it("the signature is 256 values of 32 bits, the same for the same words however they are laid out, and none for no words", async () => {
    const { minhashSignature, SIGNATURE_BYTES } = await nd();
    const ws = words(300);
    const a = minhashSignature(ws.join(" "))!;
    const b = minhashSignature(ws.join("\n\n").toUpperCase() + " ...")!;
    expect(SIGNATURE_BYTES).toBe(1024);
    expect(a.values).toHaveLength(256);
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
    expect(a.shingles).toBe(296);
    expect(minhashSignature("  ,  ")).toBeNull();
    expect(minhashSignature("three short words")!.shingles).toBe(1);
  });

  it("the estimated similarity is within 0.1 of the exact Jaccard similarity of the shingle sets, over 40 pairs from 0 to 1", async () => {
    const { minhashSignature, estimateSimilarity, shingleSet } = await nd();
    const errors: number[] = [];
    for (let i = 0; i < 40; i++) {
      const base = words(400);
      const every = 1 + (i % 20);
      const other = base.map((w, k) => (k % every === 0 && i % 20 !== 0 ? `${w}-changed` : w));
      const A = shingleSet(base.join(" "));
      const B = shingleSet(other.join(" "));
      let inter = 0;
      for (const s of A) if (B.has(s)) inter++;
      const exact = inter / (A.size + B.size - inter);
      const est = estimateSimilarity(minhashSignature(base.join(" "))!.values, minhashSignature(other.join(" "))!.values);
      errors.push(Math.abs(est - exact));
    }
    expect(Math.max(...errors)).toBeLessThanOrEqual(0.1);
  });

  it("LSH: every pair at 0.9 or more is a candidate; unrelated documents are not", async () => {
    const { minhashSignature, NearDuplicateIndex } = await nd();
    const index = new NearDuplicateIndex();
    const bases = Array.from({ length: 50 }, () => words(300));
    bases.forEach((ws, i) => index.add(`doc-${i}`, minhashSignature(ws.join(" "))!.values));
    let found = 0;
    let wrong = 0;
    for (let i = 0; i < 50; i++) {
      const near = bases[i]!.map((w, k) => (k === 150 ? `${w}-edit` : w)); // one word changed: about 0.97
      const cands = index.candidates(minhashSignature(near.join(" "))!.values);
      if (cands.includes(`doc-${i}`)) found++;
      wrong += cands.filter((c) => c !== `doc-${i}`).length;
    }
    expect(found).toBe(50);
    expect(wrong).toBe(0);
  });

  it("best match: the group's first document, at or above 0.9 only; a match's own group is followed to its first", async () => {
    const { minhashSignature, NearDuplicateIndex } = await nd();
    const index = new NearDuplicateIndex();
    const base = words(400);
    index.add("first", minhashSignature(base.join(" "))!.values);
    const later = minhashSignature(base.map((w, k) => (k === 10 ? `${w}-x` : w)).join(" "))!.values;
    const m = index.bestMatch(later, 0.9)!;
    expect(m.id).toBe("first");
    expect(m.similarity).toBeGreaterThanOrEqual(0.9);
    index.add("later", later, "first");
    const third = minhashSignature(base.map((w, k) => (k === 20 ? `${w}-y` : w)).join(" "))!.values;
    expect(index.bestMatch(third, 0.9)!.id).toBe("first");
    expect(index.bestMatch(minhashSignature(words(400).join(" "))!.values, 0.9)).toBeNull();
    index.remove("later");
    expect(index.size).toBe(1);
  });
});
