import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { generateCorpus, parseSize, TARGET_SHARES, type GenerateSummary, type Kind } from "../src/generate.js";
import { MANIFEST_FILE, MARKER_FILE, MARKER_PREFIX, REPO_ROOT, SUMMARY_FILE, defaultOutDir, isInsideRepo } from "../src/marker.js";
import { parsePdfStructure } from "../../../apps/api/src/services/pdf-parser.js";
import { parseDocx, parseEml, parseSpreadsheet, extractZipArchive } from "../../../apps/api/src/services/document-parsers.js";

/**
 * The fake-corpus generator (BIGDATA-1): invented files, deterministic per seed, a realistic mix,
 * a manifest that says which files are duplicates of which, and never inside the repository.
 * Corpora are written to the OS temp folder, outside the repository.
 */

type Row = Record<string, string>;

function readManifest(out: string): Row[] {
  const text = readFileSync(join(out, MANIFEST_FILE), "utf8");
  const lines = text.trimEnd().split("\n");
  const header = lines[0]!.split(",");
  const parse = (line: string) => {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  };
  return lines.slice(1).map(parse);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const stable = (s: GenerateSummary) => ({ ...s, elapsed_ms: 0, peak_rss_bytes: 0 });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("fake-corpus generator", () => {
  const base = mkdtempSync(join(tmpdir(), "casefile-fake-corpus-test-"));
  const size = parseSize("15MB");
  let a: GenerateSummary;
  let b: GenerateSummary;
  let rows: Row[];
  const outA = join(base, "a");
  const outB = join(base, "b");
  const outC = join(base, "c");

  beforeAll(async () => {
    a = await generateCorpus({ sizeBytes: size, seed: 42, outDir: outA });
    b = await generateCorpus({ sizeBytes: size, seed: 42, outDir: outB });
    rows = readManifest(outA);
  }, 240_000);

  it("the same seed gives the same files, byte for byte, and the same manifest", async () => {
    expect(readFileSync(join(outA, MANIFEST_FILE))).toEqual(readFileSync(join(outB, MANIFEST_FILE)));
    expect(stable(a)).toEqual(stable(b));
    const fa = filesUnder(join(outA, "corpus"));
    const fb = filesUnder(join(outB, "corpus"));
    expect(fa.map((f) => relative(outA, f))).toEqual(fb.map((f) => relative(outB, f)));
    for (let i = 0; i < fa.length; i++) expect(sha(readFileSync(fa[i]!)), fa[i]).toBe(sha(readFileSync(fb[i]!)));
  });

  it("a different seed gives a different corpus", async () => {
    const c = await generateCorpus({ sizeBytes: parseSize("2MB"), seed: 43, outDir: outC });
    const ca = await generateCorpus({ sizeBytes: parseSize("2MB"), seed: 42, outDir: join(base, "c42") });
    expect(readFileSync(join(outC, MANIFEST_FILE))).not.toEqual(readFileSync(join(base, "c42", MANIFEST_FILE)));
    expect(c.total_files).toBeGreaterThan(0);
    expect(ca.total_files).toBeGreaterThan(0);
  }, 120_000);

  it("writes about the size asked for, with every kind, and the manifest lists every file on disk", () => {
    expect(a.total_bytes).toBeGreaterThanOrEqual(size);
    expect(a.total_bytes).toBeLessThan(size * 1.5);
    for (const k of Object.keys(TARGET_SHARES) as Kind[]) expect(a.by_kind[k].files, k).toBeGreaterThan(0);
    const onDisk = filesUnder(join(outA, "corpus")).map((f) => relative(join(outA, "corpus"), f).replace(/\\/g, "/")).sort();
    const top = rows.filter((r) => !r.container).map((r) => r.path).sort();
    expect(top).toEqual(onDisk);
    for (const r of rows.filter((x) => !x.container)) {
      const buf = readFileSync(join(outA, "corpus", r.path!));
      expect(buf.length, r.path).toBe(Number(r.bytes));
      expect(sha(buf), r.path).toBe(r.sha256);
    }
  });

  it("shares of each kind are close to the target and add up", () => {
    let files = 0;
    let bytes = 0;
    for (const k of Object.keys(TARGET_SHARES) as Kind[]) {
      files += a.by_kind[k].files;
      bytes += a.by_kind[k].bytes;
      expect(Math.abs(a.by_kind[k].share_of_files - TARGET_SHARES[k]), k).toBeLessThan(0.03);
    }
    expect(files).toBe(a.total_files);
    expect(bytes).toBe(a.total_bytes);
  });

  it("the manifest records exact duplicates (same bytes) and near-duplicates (same text, different bytes)", () => {
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const dups = rows.filter((r) => r.duplicate_of);
    const nears = rows.filter((r) => r.near_duplicate_of);
    expect(dups.length).toBeGreaterThan(0);
    expect(nears.length).toBeGreaterThan(0);
    for (const d of dups) expect(d.sha256, d.path).toBe(byPath.get(d.duplicate_of!)!.sha256);
    for (const n of nears) expect(n.sha256, n.path).not.toBe(byPath.get(n.near_duplicate_of!)!.sha256);
  });

  it("files are what the manifest says: text PDFs have text, scans have none, emails and zips hold what is listed", async () => {
    const first = (pred: (r: Row) => boolean) => rows.find(pred)!;
    const read = (r: Row) => readFileSync(join(outA, "corpus", r.path!));

    const textPdf = first((r) => r.kind === "pdf_text");
    expect((await parsePdfStructure(read(textPdf))).fullText.trim().length).toBeGreaterThan(200);
    const scan = first((r) => r.kind === "pdf_scanned");
    expect(scan.needs_ocr).toBe("true");
    expect((await parsePdfStructure(read(scan))).fullText.trim()).toBe("");

    expect((await parseDocx(read(first((r) => r.kind === "word")))).fullText.length).toBeGreaterThan(200);
    expect((await parseSpreadsheet(read(first((r) => r.kind === "excel")), ".xlsx")).fullText).toContain("INV-");

    const withAtt = first((r) => r.kind === "email" && r.note!.includes("attachment"));
    const listed = rows.filter((r) => r.container === withAtt.path && r.kind === "attachment");
    expect((await parseEml(read(withAtt))).attachments.map((x) => x.filename).sort()).toEqual(listed.map((r) => r.path!.split("#attachment:")[1]).sort());

    const zip = first((r) => r.kind === "zip");
    const leaves = rows.filter((r) => r.container === zip.path && r.format !== "zip");
    expect((await extractZipArchive(read(zip))).entries.length).toBe(leaves.length);

    const corrupt = first((r) => r.kind === "corrupt" && r.format === "pdf");
    if (corrupt) await expect(parsePdfStructure(read(corrupt))).rejects.toThrow();
    expect(rows.some((r) => r.junk === "true" && r.bytes === "0")).toBe(true);
    expect(rows.some((r) => r.path!.endsWith("/Thumbs.db") || r.path!.endsWith("/desktop.ini") || r.path!.endsWith("/.DS_Store"))).toBe(true);
  });

  it("marks what it writes: the marker file, and the marker inside every non-empty file", () => {
    expect(readFileSync(join(outA, MARKER_FILE), "utf8")).toContain(MARKER_PREFIX);
    expect(readFileSync(join(outA, SUMMARY_FILE), "utf8")).toContain('"seed": 42');
    for (const f of filesUnder(join(outA, "corpus"))) {
      const buf = readFileSync(f);
      if (buf.length === 0) continue;
      expect(buf.includes(MARKER_PREFIX), f).toBe(true);
    }
  });

  it("refuses to write inside the repository, or into a folder that is not empty", async () => {
    expect(isInsideRepo(REPO_ROOT)).toBe(true);
    expect(isInsideRepo(join(REPO_ROOT, "sandbox", "corpus"))).toBe(true);
    expect(isInsideRepo(base)).toBe(false);
    expect(isInsideRepo(defaultOutDir("1GB", 42))).toBe(false);
    await expect(generateCorpus({ sizeBytes: 1024, seed: 1, outDir: join(REPO_ROOT, "sandbox", "fake-corpus-must-not-exist") })).rejects.toThrow(/inside the repository/);
    expect(() => statSync(join(REPO_ROOT, "sandbox", "fake-corpus-must-not-exist"))).toThrow();
    const full = join(base, "full");
    mkdirSync(full);
    writeFileSync(join(full, "keep.txt"), "already here");
    await expect(generateCorpus({ sizeBytes: 1024, seed: 1, outDir: full })).rejects.toThrow(/not empty/);
    expect(readFileSync(join(full, "keep.txt"), "utf8")).toBe("already here");
  });

  it("parses sizes in binary units", () => {
    expect(parseSize("100MB")).toBe(100 * 1024 * 1024);
    expect(parseSize("1GB")).toBe(1024 ** 3);
    expect(parseSize("10gb")).toBe(10 * 1024 ** 3);
    expect(() => parseSize("lots")).toThrow();
  });
});
