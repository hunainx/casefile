import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Rng } from "./prng.js";
import { makeCompany, makePerson, paragraph, title, longFolderName, safeFileStem, formatDate, makeDate, FOLDER_NAMES, type Person, amount } from "./words.js";
import { docx, xlsx, textPdf, scannedPdf, eml, zipOf, junkFile, corruptFile, type Attachment } from "./formats.js";
import { photo } from "./raster.js";
import { MANIFEST_FILE, MARKER_FILE, SUMMARY_FILE, isInsideRepo, markerFor } from "./marker.js";

/**
 * Generates an invented evidence corpus of about `sizeBytes` bytes (docs/PLAN-BIG-DATA.md).
 *
 * Files are generated and written one at a time; nothing but the current file, the last few
 * texts (for near-duplicates) and a bounded list of paths (for exact duplicates) is held in
 * memory, so 100 MB, 1 GB and 10 GB runs use the same memory. The manifest is streamed to disk.
 *
 * Layout:  <out>/corpus/...                   the files to ingest
 *          <out>/fake-corpus-manifest.csv     one row per file (and per file inside a zip or email)
 *          <out>/fake-corpus-summary.json     counts, bytes and shares per kind
 *          <out>/.casefile-fake-corpus        marker
 */

export const GENERATOR_VERSION = "1.0.0";

export type Kind =
  | "email"
  | "pdf_text"
  | "pdf_scanned"
  | "word"
  | "excel"
  | "image"
  | "zip"
  | "duplicate"
  | "near_duplicate"
  | "junk"
  | "corrupt";

/**
 * Target share of the corpus by number of files, roughly what a mixed custodian export looks
 * like (emails dominate by count; scans and photos dominate by bytes). The byte shares follow
 * from the sizes and are printed at the end.
 */
export const TARGET_SHARES: Record<Kind, number> = {
  email: 0.34,
  pdf_text: 0.14,
  pdf_scanned: 0.08,
  word: 0.14,
  excel: 0.06,
  image: 0.03,
  zip: 0.03,
  duplicate: 0.07,
  near_duplicate: 0.03,
  junk: 0.07,
  corrupt: 0.01,
};

export interface ManifestRow {
  path: string;
  kind: Kind | "attachment" | "archive_entry";
  format: string;
  bytes: number;
  sha256: string;
  duplicate_of: string;
  near_duplicate_of: string;
  container: string;
  needs_ocr: boolean;
  junk: boolean;
  corrupt: boolean;
  note: string;
}

export interface GenerateOptions {
  sizeBytes: number;
  seed: number;
  outDir: string;
  /** Called after each top-level file is written. */
  onProgress?: (writtenBytes: number, files: number) => void;
}

export interface KindTotals {
  files: number;
  bytes: number;
}

export interface GenerateSummary {
  generator_version: string;
  seed: number;
  target_bytes: number;
  total_bytes: number;
  total_files: number;
  manifest_rows: number;
  by_kind: Record<Kind, KindTotals & { share_of_files: number; share_of_bytes: number }>;
  inner_entries: { archive_entries: number; email_attachments: number };
  longest_path_chars: number;
  paths_over_260_chars: number;
  max_zip_nesting: number;
  elapsed_ms: number;
  peak_rss_bytes: number;
}

const CSV_COLUMNS: (keyof ManifestRow)[] = ["path", "kind", "format", "bytes", "sha256", "duplicate_of", "near_duplicate_of", "container", "needs_ocr", "junk", "corrupt", "note"];

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Parses 100MB, 1GB, 10GB, 500KB (binary units: 1 MB = 1024 * 1024 bytes). */
export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|B)?$/i.exec(s.trim());
  if (!m) throw new Error(`Cannot read size "${s}" (use for example 100MB, 1GB, 10GB)`);
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(Number(m[1]) * units[(m[2] ?? "B").toUpperCase()]!);
}

interface TextMemory {
  kind: "word" | "pdf_scanned" | "email" | "pdf_text";
  path: string;
  paragraphs: string[];
  title: string;
  from?: Person;
  to?: Person[];
  subject?: string;
}

export async function generateCorpus(opts: GenerateOptions): Promise<GenerateSummary> {
  const started = Date.now();
  if (isInsideRepo(opts.outDir)) {
    throw new Error(`Refusing to write a fake corpus inside the repository (${opts.outDir}). Choose a folder outside it.`);
  }
  if (existsSync(opts.outDir) && readdirSync(opts.outDir).length > 0) {
    throw new Error(`${opts.outDir} already exists and is not empty. Nothing was written; choose a new folder.`);
  }
  const corpusDir = join(opts.outDir, "corpus");
  mkdirSync(corpusDir, { recursive: true });
  const marker = markerFor(opts.seed);
  writeFileSync(join(opts.outDir, MARKER_FILE), `${marker}\ngenerator ${GENERATOR_VERSION}\n`);
  const manifestFd = openSync(join(opts.outDir, MANIFEST_FILE), "w");
  writeSync(manifestFd, CSV_COLUMNS.join(",") + "\n");

  const rng = new Rng(opts.seed);
  const companies = Array.from({ length: 12 }, () => makeCompany(rng));
  const people = Array.from({ length: 60 }, () => makePerson(rng, rng.pick(companies)));

  // A folder tree: custodians, then department folders, some deep and with long names.
  const folders: string[] = [];
  for (const custodian of people.slice(0, 8)) {
    const top = `Custodian - ${custodian.first} ${custodian.last}`;
    for (let i = 0; i < 6; i++) {
      // Mostly shallow; about one folder in ten is deep (4 to 7 levels).
      const depth = rng.chance(0.1) ? rng.int(4, 7) : rng.int(1, 3);
      const parts = [top];
      for (let d = 0; d < depth; d++) parts.push(rng.chance(0.06) ? longFolderName(rng, rng.pick(companies)) : rng.pick(FOLDER_NAMES));
      folders.push(parts.join("/"));
    }
  }
  const madeDirs = new Set<string>();
  const ensureDir = (rel: string) => {
    if (!madeDirs.has(rel)) {
      mkdirSync(join(corpusDir, rel), { recursive: true });
      madeDirs.add(rel);
    }
  };

  const totals = Object.fromEntries(Object.keys(TARGET_SHARES).map((k) => [k, { files: 0, bytes: 0 }])) as Record<Kind, KindTotals>;
  let totalBytes = 0;
  let totalFiles = 0;
  let manifestRows = 0;
  let longest = 0;
  let over260 = 0;
  let maxNesting = 0;
  let archiveEntries = 0;
  let emailAttachments = 0;
  let peakRss = process.memoryUsage().rss;
  const usedNames = new Set<string>();
  const dupPool: { path: string; kind: Kind }[] = [];
  const texts: TextMemory[] = [];
  let seq = 0;

  const row = (r: Partial<ManifestRow> & Pick<ManifestRow, "path" | "kind" | "format" | "bytes" | "sha256">) => {
    const full: ManifestRow = { duplicate_of: "", near_duplicate_of: "", container: "", needs_ocr: false, junk: false, corrupt: false, note: "", ...r };
    writeSync(manifestFd, CSV_COLUMNS.map((c) => csvCell(full[c])).join(",") + "\n");
    manifestRows++;
  };

  const uniquePath = (folder: string, stem: string, ext: string) => {
    let name = `${safeFileStem(stem) || "document"}${ext}`;
    let n = 1;
    while (usedNames.has(`${folder}/${name}`.toLowerCase())) name = `${safeFileStem(stem)} (${++n})${ext}`;
    usedNames.add(`${folder}/${name}`.toLowerCase());
    return `${folder}/${name}`;
  };

  const writeTop = (rel: string, kind: Kind, data: Buffer, extra: Partial<ManifestRow> = {}, format = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()) => {
    const folder = rel.slice(0, rel.lastIndexOf("/"));
    ensureDir(folder);
    const abs = join(corpusDir, rel);
    writeFileSync(abs, data);
    const len = abs.length;
    longest = Math.max(longest, len);
    if (len > 260) over260++;
    totals[kind].files++;
    totals[kind].bytes += data.length;
    totalBytes += data.length;
    totalFiles++;
    row({ path: rel, kind, format, bytes: data.length, sha256: sha(data), ...extra });
    if (!extra.junk && !extra.corrupt && kind !== "duplicate") {
      if (dupPool.length < 5000) dupPool.push({ path: rel, kind });
      else dupPool[rng.int(0, dupPool.length - 1)] = { path: rel, kind };
    }
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };

  const remember = (t: TextMemory) => {
    texts.push(t);
    if (texts.length > 40) texts.shift();
  };

  const smallAttachment = async (r: Rng): Promise<Attachment> => {
    switch (r.int(0, 3)) {
      case 0: {
        const p = await textPdf(r, people, r.int(1, 3), marker);
        return { filename: `${safeFileStem(p.title)}.pdf`, contentType: "application/pdf", data: p.bytes };
      }
      case 1:
        return { filename: `${safeFileStem(title(r))}.docx`, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: docx([paragraph(r, people), paragraph(r, people)], title(r), marker) };
      case 2:
        return { filename: `ledger-${r.int(100, 999)}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: xlsx(ledger(r, r.int(10, 60)), marker) };
      default:
        return { filename: `IMG_${r.int(1000, 9999)}.png`, contentType: "image/png", data: photo(r, r.int(320, 800), r.int(240, 600), marker) };
    }
  };

  const ledger = (r: Rng, rows: number): (string | number)[][] => {
    const out: (string | number)[][] = [["Date", "Reference", "Counterparty", "Description", "Amount", "Currency"]];
    for (let i = 0; i < rows; i++) {
      const p = r.pick(people);
      out.push([formatDate(makeDate(r)), `INV-${r.int(10000, 99999)}`, p.company.name, title(r), r.int(100, 950000), amount(r).split(" ")[1]!]);
    }
    return out;
  };

  /** Entries for a zip; sometimes with a nested zip (depth <= 3, the ingest limit). */
  const zipEntries = async (r: Rng, depth: number, prefix: string, container: string): Promise<{ name: string; data: Buffer }[]> => {
    maxNesting = Math.max(maxNesting, depth);
    const entries: { name: string; data: Buffer }[] = [];
    const n = r.int(3, 14);
    for (let i = 0; i < n; i++) {
      const sub = r.chance(0.3) ? `${r.pick(FOLDER_NAMES)}/` : "";
      let e: { name: string; data: Buffer; kind: ManifestRow["kind"]; format: string; ocr?: boolean };
      switch (r.int(0, 4)) {
        case 0: {
          const p = await textPdf(r, people, r.int(1, 6), marker);
          e = { name: `${sub}${safeFileStem(p.title)}.pdf`, data: p.bytes, kind: "archive_entry", format: "pdf" };
          break;
        }
        case 1:
          e = { name: `${sub}${safeFileStem(title(r))} ${r.int(1, 99)}.docx`, data: docx(Array.from({ length: r.int(3, 20) }, () => paragraph(r, people)), title(r), marker), kind: "archive_entry", format: "docx" };
          break;
        case 2:
          e = { name: `${sub}ledger-${r.int(1000, 9999)}.xlsx`, data: xlsx(ledger(r, r.int(20, 400)), marker), kind: "archive_entry", format: "xlsx" };
          break;
        case 3: {
          const from = r.pick(people);
          e = { name: `${sub}message-${r.int(10000, 99999)}.eml`, data: eml(r, from, [r.pick(people)], title(r), paragraph(r, people), [], marker, `${r.u32().toString(16)}.${seq++}@${from.company.domain}`), kind: "archive_entry", format: "eml" };
          break;
        }
        default: {
          const s = await scannedPdf(r, people, r.int(1, 2), marker);
          e = { name: `${sub}scan-${r.int(1000, 9999)}.pdf`, data: s.bytes, kind: "archive_entry", format: "pdf", ocr: true };
        }
      }
      entries.push(e);
      archiveEntries++;
      row({ path: `${container}#${prefix}${e.name}`, kind: e.kind, format: e.format, bytes: e.data.length, sha256: sha(e.data), container, needs_ocr: Boolean(e.ocr), note: `zip depth ${depth}` });
    }
    if (depth < 3 && r.chance(depth === 1 ? 0.35 : 0.25)) {
      const innerName = `nested-${r.int(100, 999)}.zip`;
      const inner = zipOf(await zipEntries(r, depth + 1, `${prefix}${innerName}/`, container), marker);
      entries.push({ name: innerName, data: inner });
      row({ path: `${container}#${prefix}${innerName}`, kind: "archive_entry", format: "zip", bytes: inner.length, sha256: sha(inner), container, note: `nested zip, depth ${depth + 1}` });
    }
    return entries;
  };

  const kinds = Object.keys(TARGET_SHARES) as Kind[];
  while (totalBytes < opts.sizeBytes) {
    // Deficit scheduling on file counts: the kind furthest below its share goes next, with a
    // little seeded jitter so the order is not a fixed cycle.
    let kind: Kind = kinds[0]!;
    let worst = -Infinity;
    for (const k of kinds) {
      const deficit = TARGET_SHARES[k] * (totalFiles + 1) - totals[k].files + rng.next() * 0.5;
      if (deficit > worst) {
        worst = deficit;
        kind = k;
      }
    }
    if (kind === "duplicate" && dupPool.length === 0) kind = "pdf_text";
    if (kind === "near_duplicate" && texts.length === 0) kind = "word";
    const r = rng.fork();
    const folder = r.pick(folders);

    switch (kind) {
      case "email": {
        const from = r.pick(people);
        const to = [r.pick(people), ...(r.chance(0.3) ? [r.pick(people)] : [])];
        const subject = `${r.chance(0.3) ? "RE: " : ""}${title(r)} - ${formatDate(makeDate(r))}`;
        const paras = Array.from({ length: r.int(2, 8) }, () => paragraph(r, people));
        const attachments: Attachment[] = [];
        if (r.chance(0.4)) for (let i = r.int(1, 3); i > 0; i--) attachments.push(await smallAttachment(r));
        const rel = uniquePath(`${folder}/Email Exports`, `${subject.slice(0, 50)} ${r.int(1, 9999)}`, ".eml");
        const data = eml(r, from, to, subject, paras.join("\n\n"), attachments, marker, `${r.u32().toString(16)}.${seq++}@${from.company.domain}`);
        writeTop(rel, "email", data, { note: attachments.length ? `${attachments.length} attachment(s)` : "" });
        for (const a of attachments) {
          emailAttachments++;
          row({ path: `${rel}#attachment:${a.filename}`, kind: "attachment", format: a.filename.split(".").pop()!, bytes: a.data.length, sha256: sha(a.data), container: rel });
        }
        remember({ kind: "email", path: rel, paragraphs: paras, title: subject, from, to, subject });
        break;
      }
      case "pdf_text": {
        const p = await textPdf(r, people, r.int(1, 40), marker);
        const rel = uniquePath(folder, p.title, ".pdf");
        writeTop(rel, "pdf_text", p.bytes);
        remember({ kind: "pdf_text", path: rel, paragraphs: p.text.split("\n\n"), title: p.title });
        break;
      }
      case "pdf_scanned": {
        const s = await scannedPdf(r, people, r.int(1, 6), marker);
        const rel = uniquePath(`${folder}/Scans`, `SCAN_${String(r.int(0, 99999)).padStart(5, "0")}`, ".pdf");
        writeTop(rel, "pdf_scanned", s.bytes, { needs_ocr: true });
        remember({ kind: "pdf_scanned", path: rel, paragraphs: s.text.split("\n\n"), title: "scan" });
        break;
      }
      case "word": {
        const t = title(r);
        const paras = Array.from({ length: r.int(5, 120) }, () => paragraph(r, people));
        const rel = uniquePath(folder, `${t} v${r.int(1, 9)}`, ".docx");
        writeTop(rel, "word", docx(paras, t, marker));
        remember({ kind: "word", path: rel, paragraphs: paras, title: t });
        break;
      }
      case "excel": {
        const rel = uniquePath(folder, `${title(r)} ledger ${r.int(2019, 2023)}`, ".xlsx");
        writeTop(rel, "excel", xlsx(ledger(r, r.int(20, 3000)), marker));
        break;
      }
      case "image": {
        const w = r.int(480, 1280);
        const h = Math.round((w * r.int(60, 80)) / 100);
        const rel = uniquePath(`${folder}/Photos`, `IMG_${r.int(1000, 9999)}`, ".png");
        writeTop(rel, "image", photo(r, w, h, marker));
        break;
      }
      case "zip": {
        const rel = uniquePath(folder, `${title(r)} export ${r.int(1, 99)}`, ".zip");
        const data = zipOf(await zipEntries(r, 1, "", rel), marker);
        writeTop(rel, "zip", data);
        break;
      }
      case "duplicate": {
        const src = r.pick(dupPool);
        const base = src.path.slice(src.path.lastIndexOf("/") + 1);
        const dot = base.lastIndexOf(".");
        const stem = r.chance(0.5) ? `Copy of ${base.slice(0, dot)}` : `${base.slice(0, dot)} - backup`;
        const rel = uniquePath(r.pick(folders), stem, base.slice(dot));
        ensureDir(rel.slice(0, rel.lastIndexOf("/")));
        copyFileSync(join(corpusDir, src.path), join(corpusDir, rel));
        // Read back so the manifest's hash is of the bytes on disk (equal to the original's).
        const bytes = readFileSync(join(corpusDir, rel));
        totals.duplicate.files++;
        totals.duplicate.bytes += bytes.length;
        totalBytes += bytes.length;
        totalFiles++;
        const len = join(corpusDir, rel).length;
        longest = Math.max(longest, len);
        if (len > 260) over260++;
        row({ path: rel, kind: "duplicate", format: base.slice(dot + 1).toLowerCase(), bytes: bytes.length, sha256: sha(bytes), duplicate_of: src.path, needs_ocr: src.kind === "pdf_scanned", note: `exact copy of a ${src.kind}` });
        break;
      }
      case "near_duplicate": {
        const src = r.pick(texts);
        let data: Buffer;
        let rel: string;
        let ocr = false;
        if (src.kind === "email" && src.from && src.to && src.subject) {
          // Same message, sent again: new Message-ID and date, identical text.
          rel = uniquePath(`${r.pick(folders)}/Email Exports`, `${src.subject.slice(0, 50)} resent`, ".eml");
          data = eml(r, src.from, src.to, src.subject, src.paragraphs.join("\n\n"), [], marker, `${r.u32().toString(16)}.${seq++}@${src.from.company.domain}`);
        } else if (src.kind === "pdf_scanned") {
          // The same page scanned again: same text, different specks and offset.
          const s = await scannedPdf(r, people, 1, marker, src.paragraphs[0]);
          rel = uniquePath(`${r.pick(folders)}/Scans`, `SCAN_${String(r.int(0, 99999)).padStart(5, "0")} rescan`, ".pdf");
          data = s.bytes;
          ocr = true;
        } else {
          // The same text saved again as a Word file with a different title.
          rel = uniquePath(r.pick(folders), `${src.title.slice(0, 40)} (final)`, ".docx");
          data = docx(src.paragraphs, `${src.title} (final)`, marker);
        }
        writeTop(rel, "near_duplicate", data, { near_duplicate_of: src.path, needs_ocr: ocr, note: `same text as a ${src.kind}` });
        break;
      }
      case "junk": {
        const jk = r.pick(["thumbs", "dsstore", "desktop", "tmp", "lock", "empty"] as const);
        const j = junkFile(r, jk, marker);
        const rel = `${folder}/${j.name}`;
        if (usedNames.has(rel.toLowerCase())) {
          const alt = uniquePath(folder, `${title(r)} empty`, ".txt");
          writeTop(alt, "junk", Buffer.alloc(0), { junk: true, note: "empty file" }, "txt");
        } else {
          usedNames.add(rel.toLowerCase());
          writeTop(rel, "junk", j.data, { junk: true, note: jk }, jk === "empty" ? "txt" : j.name.split(".").pop()!.toLowerCase());
        }
        break;
      }
      case "corrupt": {
        const ck = r.pick(["pdf", "docx", "zip", "xlsx"] as const);
        const c = corruptFile(r, ck, marker);
        const rel = uniquePath(folder, `${title(r)} ${r.int(1, 99)}`, c.ext);
        writeTop(rel, "corrupt", c.data, { corrupt: true, note: `not a readable ${ck}` });
        break;
      }
    }
    opts.onProgress?.(totalBytes, totalFiles);
  }

  closeSync(manifestFd);
  const byKind = Object.fromEntries(
    kinds.map((k) => [k, { ...totals[k], share_of_files: totals[k].files / totalFiles, share_of_bytes: totals[k].bytes / totalBytes }]),
  ) as GenerateSummary["by_kind"];
  const summary: GenerateSummary = {
    generator_version: GENERATOR_VERSION,
    seed: opts.seed,
    target_bytes: opts.sizeBytes,
    total_bytes: totalBytes,
    total_files: totalFiles,
    manifest_rows: manifestRows,
    by_kind: byKind,
    inner_entries: { archive_entries: archiveEntries, email_attachments: emailAttachments },
    longest_path_chars: longest,
    paths_over_260_chars: over260,
    max_zip_nesting: maxNesting,
    elapsed_ms: Date.now() - started,
    peak_rss_bytes: peakRss,
  };
  // The summary without the timing and memory fields is what the determinism test compares.
  writeFileSync(join(opts.outDir, SUMMARY_FILE), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

export function formatSummary(s: GenerateSummary, outDir: string): string {
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);
  const lines = [
    `Fake corpus written to ${outDir}`,
    `  seed ${s.seed}, target ${mb(s.target_bytes)}, written ${mb(s.total_bytes)} in ${s.total_files} files (${s.manifest_rows} manifest rows)`,
    `  inside zips: ${s.inner_entries.archive_entries} entries (deepest nesting ${s.max_zip_nesting}); email attachments: ${s.inner_entries.email_attachments}`,
    `  longest path ${s.longest_path_chars} characters; ${s.paths_over_260_chars} paths over 260`,
    `  ${(s.elapsed_ms / 1000).toFixed(1)} s, peak memory ${mb(s.peak_rss_bytes)}`,
    "",
    "  kind             files   share    bytes        share",
  ];
  for (const [k, v] of Object.entries(s.by_kind)) {
    lines.push(`  ${k.padEnd(15)} ${String(v.files).padStart(6)}  ${pct(v.share_of_files)}  ${mb(v.bytes).padStart(10)}  ${pct(v.share_of_bytes)}`);
  }
  return lines.join("\n");
}
