/**
 * GCS Bucket Inventory & PDF Text-Layer Assessment Tool
 * Invoked: pnpm tsx scripts/bucket-inventory.ts <bucket-name> [--prefix=<prefix>] [--sample=<max-samples>]
 * Scans an external GCS matter bucket, reports file extension breakdown, nesting depth, and samples PDFs for text layer availability.
 */

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Storage } from "@google-cloud/storage";
import { getGcsStorageClient } from "../packages/storage/src/gcs.js";
import { parsePdfStructure } from "../apps/api/src/services/pdf-parser.js";

EventEmitter.defaultMaxListeners = 100;

// Load .env if present
function loadEnv(envPath = ".env"): void {
  const fullPath = path.resolve(process.cwd(), envPath);
  if (!fs.existsSync(fullPath)) return;
  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore load errors
  }
}

loadEnv();

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export interface InventoryOptions {
  bucket: string;
  prefix?: string;
  maxPdfSamples?: number;
}

export interface ExtensionStats {
  extension: string;
  count: number;
  totalBytes: number;
}

export interface PdfSampleDetail {
  path: string;
  bytes: number;
  status: "has_text" | "no_text" | "errored";
  charCount: number;
  pageCount?: number;
  blockCount?: number;
  errorMessage?: string;
}

export interface PdfTextStats {
  totalPdfs: number;
  sampledCount: number;
  withTextLayer: number;
  withoutTextLayer: number;
  errored: number;
  withTextRatio: number;
  withoutTextRatio: number;
  erroredRatio: number;
  sampleDetails: PdfSampleDetail[];
}

export interface InventoryResult {
  bucket: string;
  prefix?: string | undefined;
  totalObjects: number;
  totalBytes: number;
  extensionBreakdown: ExtensionStats[];
  noExtensionCount: number;
  noExtensionBytes: number;
  pdfStats?: PdfTextStats | undefined;
  deepestNesting: number;
  examplePathsByDepth: { depth: number; path: string }[];
  examplePaths: string[];
}

export async function runBucketInventory(options: InventoryOptions): Promise<InventoryResult> {
  let bucketName = options.bucket.trim();
  if (bucketName.startsWith("gs://")) {
    bucketName = bucketName.slice(5);
  }
  if (bucketName.endsWith("/")) {
    bucketName = bucketName.slice(0, -1);
  }

  const prefix = options.prefix || "";
  const maxPdfSamples = options.maxPdfSamples ?? 200;

  let storage: Storage;
  try {
    const candidate = await getGcsStorageClient();
    await candidate.bucket(bucketName).getFiles({ maxResults: 1, prefix });
    storage = candidate;
  } catch {
    // Fallback to direct ADC Storage client
    storage = new Storage();
  }
  const bucket = storage.bucket(bucketName);

  const [files] = await bucket.getFiles({ prefix });

  let totalBytes = 0;
  const extMap = new Map<string, { count: number; totalBytes: number }>();
  let noExtCount = 0;
  let noExtBytes = 0;

  const pdfFiles: Array<{ name: string; size: number }> = [];
  const pathsByDepth = new Map<number, string[]>();
  let maxDepth = 0;

  for (const file of files) {
    const size = parseInt(String(file.metadata.size || "0"), 10);
    totalBytes += size;

    const filePath = file.name;
    const parts = filePath.split("/").filter(Boolean);
    const depth = parts.length;
    if (depth > maxDepth) {
      maxDepth = depth;
    }
    if (!pathsByDepth.has(depth)) {
      pathsByDepth.set(depth, []);
    }
    const listAtDepth = pathsByDepth.get(depth)!;
    if (listAtDepth.length < 5) {
      listAtDepth.push(filePath);
    }

    const baseName = path.basename(filePath);
    const extMatch = baseName.match(/\.([0-9a-z_#-]+)$/i);

    if (extMatch && extMatch[1]) {
      const ext = "." + extMatch[1].toLowerCase();
      const existing = extMap.get(ext) || { count: 0, totalBytes: 0 };
      existing.count += 1;
      existing.totalBytes += size;
      extMap.set(ext, existing);

      if (ext === ".pdf") {
        pdfFiles.push({ name: filePath, size });
      }
    } else {
      noExtCount += 1;
      noExtBytes += size;
      const existing = extMap.get("(no extension)") || { count: 0, totalBytes: 0 };
      existing.count += 1;
      existing.totalBytes += size;
      extMap.set("(no extension)", existing);
    }
  }

  // Sort extensions by count descending
  const extensionBreakdown: ExtensionStats[] = Array.from(extMap.entries())
    .map(([extension, data]) => ({
      extension,
      count: data.count,
      totalBytes: data.totalBytes,
    }))
    .sort((a, b) => b.count - a.count);

  // PDF Text Layer Sampling using pipeline's parsePdfStructure
  let pdfStats: PdfTextStats | undefined;
  if (pdfFiles.length > 0) {
    const sampleSize = Math.min(maxPdfSamples, pdfFiles.length);
    const step = pdfFiles.length / sampleSize;
    const sampledPdfs: Array<{ name: string; size: number }> = [];
    for (let i = 0; i < sampleSize; i++) {
      const idx = Math.min(Math.floor(i * step), pdfFiles.length - 1);
      sampledPdfs.push(pdfFiles[idx]!);
    }

    let withText = 0;
    let withoutText = 0;
    let errored = 0;
    const sampleDetails: PdfSampleDetail[] = [];

    const batchSize = 10;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < sampledPdfs.length; i += batchSize) {
        const batch = sampledPdfs.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (item) => {
            try {
              const [buffer] = await bucket.file(item.name).download();
              const parsed = await parsePdfStructure(buffer);
              const trimmedText = (parsed.fullText || "").trim();
              const charCount = trimmedText.length;
              const hasTextLayer = charCount > 20 && parsed.blocks.length > 0;

              if (hasTextLayer) {
                withText++;
                sampleDetails.push({
                  path: item.name,
                  bytes: item.size,
                  status: "has_text",
                  charCount,
                  pageCount: parsed.pageCount,
                  blockCount: parsed.blocks.length,
                });
              } else {
                withoutText++;
                sampleDetails.push({
                  path: item.name,
                  bytes: item.size,
                  status: "no_text",
                  charCount,
                  pageCount: parsed.pageCount,
                  blockCount: parsed.blocks.length,
                });
              }
            } catch (err: unknown) {
              errored++;
              const errorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
              sampleDetails.push({
                path: item.name,
                bytes: item.size,
                status: "errored",
                charCount: 0,
                errorMessage: errorMsg,
              });
            }
          })
        );
      }
    } finally {
      console.warn = originalWarn;
    }

    pdfStats = {
      totalPdfs: pdfFiles.length,
      sampledCount: sampleSize,
      withTextLayer: withText,
      withoutTextLayer: withoutText,
      errored,
      withTextRatio: sampleSize > 0 ? withText / sampleSize : 0,
      withoutTextRatio: sampleSize > 0 ? withoutText / sampleSize : 0,
      erroredRatio: sampleSize > 0 ? errored / sampleSize : 0,
      sampleDetails,
    };
  }

  // Example paths by depth
  const examplePathsByDepth: { depth: number; path: string }[] = [];
  for (let d = 1; d <= maxDepth; d++) {
    const list = pathsByDepth.get(d);
    if (list && list.length > 0) {
      examplePathsByDepth.push({ depth: d, path: list[0]! });
    }
  }

  const examplePaths = files.slice(0, 10).map((f) => f.name);

  return {
    bucket: bucketName,
    ...(prefix ? { prefix } : {}),
    totalObjects: files.length,
    totalBytes,
    extensionBreakdown,
    noExtensionCount: noExtCount,
    noExtensionBytes: noExtBytes,
    pdfStats,
    deepestNesting: maxDepth,
    examplePathsByDepth,
    examplePaths,
  };
}

export function printInventoryReport(res: InventoryResult): void {
  console.log("================================================================================");
  console.log(`BUCKET INVENTORY REPORT: gs://${res.bucket}${res.prefix ? ` (prefix: ${res.prefix})` : ""}`);
  console.log("================================================================================");
  console.log(`Total Objects : ${res.totalObjects.toLocaleString()}`);
  console.log(`Total Size    : ${formatBytes(res.totalBytes)} (${res.totalBytes.toLocaleString()} bytes)`);
  console.log(`Deepest Depth : ${res.deepestNesting} levels`);
  console.log("");

  console.log("--- EXTENSION BREAKDOWN (sorted by count) ---");
  console.log(
    "Extension".padEnd(20) +
      "Count".padStart(10) +
      "% Objects".padStart(12) +
      "Total Bytes".padStart(16) +
      "% Bytes".padStart(12)
  );
  console.log("-".repeat(70));

  for (const item of res.extensionBreakdown) {
    const pctCount = ((item.count / (res.totalObjects || 1)) * 100).toFixed(2) + "%";
    const pctBytes = ((item.totalBytes / (res.totalBytes || 1)) * 100).toFixed(2) + "%";
    console.log(
      item.extension.padEnd(20) +
        item.count.toLocaleString().padStart(10) +
        pctCount.padStart(12) +
        formatBytes(item.totalBytes).padStart(16) +
        pctBytes.padStart(12)
    );
  }

  if (res.noExtensionCount > 0) {
    console.log("");
    console.log(`Objects with no extension: ${res.noExtensionCount.toLocaleString()} (${formatBytes(res.noExtensionBytes)})`);
  }

  if (res.pdfStats) {
    console.log("");
    console.log("--- PDF TEXT LAYER ANALYSIS (parsePdfStructure) ---");
    console.log(`Total PDF Objects in Bucket : ${res.pdfStats.totalPdfs.toLocaleString()}`);
    console.log(`Sampled PDFs                : ${res.pdfStats.sampledCount.toLocaleString()}`);
    console.log(
      `PDFs WITH extractable text  : ${res.pdfStats.withTextLayer.toLocaleString()} (${(
        res.pdfStats.withTextRatio * 100
      ).toFixed(2)}%)`
    );
    console.log(
      `PDFs WITHOUT text (scanned) : ${res.pdfStats.withoutTextLayer.toLocaleString()} (${(
        res.pdfStats.withoutTextRatio * 100
      ).toFixed(2)}%)`
    );
    console.log(
      `PDFs ERRORED (failed read)  : ${res.pdfStats.errored.toLocaleString()} (${(
        res.pdfStats.erroredRatio * 100
      ).toFixed(2)}%)`
    );

    console.log("");
    console.log("--- PDF SAMPLE EXAMPLES (spanning both ends) ---");
    const sorted = [...res.pdfStats.sampleDetails].sort((a, b) => b.charCount - a.charCount);
    const topExamples = sorted.slice(0, 5);
    const bottomExamples = sorted.slice(-5);
    const combinedExamples = [...topExamples];
    for (const ex of bottomExamples) {
      if (!combinedExamples.some((e) => e.path === ex.path)) {
        combinedExamples.push(ex);
      }
    }

    console.log(
      "Status".padEnd(12) +
        "Pages".padStart(8) +
        "Blocks".padStart(8) +
        "Chars".padStart(10) +
        "Size".padStart(12) +
        "  Path"
    );
    console.log("-".repeat(80));
    for (const ex of combinedExamples) {
      const statusStr = ex.status === "has_text" ? "HAS_TEXT" : ex.status === "no_text" ? "NO_TEXT" : "ERRORED";
      const pagesStr = ex.pageCount !== undefined ? String(ex.pageCount) : "-";
      const blocksStr = ex.blockCount !== undefined ? String(ex.blockCount) : "-";
      console.log(
        statusStr.padEnd(12) +
          pagesStr.padStart(8) +
          blocksStr.padStart(8) +
          ex.charCount.toLocaleString().padStart(10) +
          formatBytes(ex.bytes).padStart(12) +
          `  ${ex.path}`
      );
      if (ex.errorMessage) {
        console.log(`    Error: ${ex.errorMessage}`);
      }
    }
  }

  console.log("");
  console.log("--- FOLDER STRUCTURE & EXAMPLE PATHS ---");
  console.log(`Deepest Folder Nesting Level: ${res.deepestNesting}`);
  console.log("Representative paths across folder depths:");
  for (const p of res.examplePathsByDepth) {
    console.log(`  [Depth ${p.depth}]: ${p.path}`);
  }

  console.log("");
  console.log("Initial 5 object paths in bucket:");
  for (const p of res.examplePaths.slice(0, 5)) {
    console.log(`  - ${p}`);
  }
  console.log("================================================================================");
}

// CLI Execution
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: tsx scripts/bucket-inventory.ts <bucket-name> [--prefix=<prefix>] [--sample=<max-pdf-samples>]");
    console.log("Example: tsx scripts/bucket-inventory.ts example-matter-sources");
    console.log("Example: tsx scripts/bucket-inventory.ts gs://example-matter-sources --sample=200");
    process.exit(1);
  }

  let bucketArg = "";
  let prefix = "";
  let maxPdfSamples = 200;

  for (const arg of args) {
    if (arg.startsWith("--prefix=")) {
      prefix = arg.slice("--prefix=".length);
    } else if (arg.startsWith("--sample=")) {
      maxPdfSamples = parseInt(arg.slice("--sample=".length), 10);
    } else if (!arg.startsWith("-") && !bucketArg) {
      bucketArg = arg;
    }
  }

  if (!bucketArg) {
    console.error("Error: Bucket name is required.");
    process.exit(1);
  }

  try {
    const result = await runBucketInventory({
      bucket: bucketArg,
      prefix,
      maxPdfSamples,
    });
    printInventoryReport(result);
  } catch (err: unknown) {
    console.error("Inventory failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("bucket-inventory.ts") || process.argv[1].endsWith("bucket-inventory.js"))) {
  main();
}
