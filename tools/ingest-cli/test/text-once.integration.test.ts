import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { ensureEmulatorBucket, listBucketObjects } from "@casefile/storage";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory } from "../src/ingest.js";
import { rebuildDocumentText } from "../../../apps/api/src/services/document-text.js";
import { parseDocx, parseDoc, parseSpreadsheet, parseHtml, parseRtf, parseEml, parseMsg } from "../../../apps/api/src/services/document-parsers.js";
import { parsePdfStructure } from "../../../apps/api/src/services/pdf-parser.js";

/**
 * BIGDATA-2B, what the ingest writes (D94, D95; docs/PLAN-BIG-DATA.md section 12):
 * - every chunk is one block and stores no text of its own (chunks.text NULL);
 * - a document whose text the blocks give back exactly stores no full_text (NULL), and the
 *   rebuilt text is exactly what the parser produced; since FIXES-1 (DEV-034 fixed) that holds for
 *   .doc, .html and .rtf too, whose block offsets now point at their text;
 * - no byte-identical artifact copy: the artifact points at the source object, and the ingest
 *   writes nothing to the artifacts bucket.
 */
const TEST_DIR = join(process.cwd(), ".tmp-test-fixtures", `text_once_${Date.now()}`);
const ENV_DIR = `${TEST_DIR}-env`;
const FIX = join(process.cwd(), "test-corpus");
const FILES: Record<string, (b: Buffer) => Promise<{ fullText: string }>> = {
  "summary.docx": (b) => parseDocx(b),
  "text-transcript.pdf": (b) => parsePdfStructure(b),
  "workbook.xlsx": (b) => parseSpreadsheet(b, ".xlsx"),
  "message.eml": (b) => parseEml(b),
  "message.msg": (b) => parseMsg(b),
  "legacy.doc": (b) => parseDoc(b),
  "page.html": (b) => parseHtml(b),
  "document.rtf": (b) => parseRtf(b),
};
// FIXES-1 (DEV-034): no fixture format keeps full_text any more; .doc, .html and .rtf did in BIGDATA-2B.
const KEEPS_FULL_TEXT = new Set<string>();

describe("tools/ingest-cli — text stored once and no byte-identical artifact copy (BIGDATA-2B)", () => {
  let tenantId: string;
  let investigationId: string;
  type Row = { filename: string; source_uri: string; artifact_uri: string | null; full_text: string | null; doc_id: string | null };
  let rows: Row[];
  const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(ENV_DIR, { recursive: true });
    for (const f of Object.keys(FILES)) copyFileSync(join(FIX, f), join(TEST_DIR, f));
    copyFileSync(join(FIX, "archive.zip"), join(TEST_DIR, "archive.zip"));
    writeFileSync(join(TEST_DIR, "note.txt"), "Fake plain note, one line.\nAnd a second line.");
    const boot = await bootstrap({
      name: `Text once WS ${Date.now()}`,
      investigationName: "Text once",
      email: `text-once-cli-${Date.now()}@casefile.test`,
      matter: `text-once-${Date.now()}`,
      envDir: ENV_DIR,
      dbUrl: getDbUrl(),
    });
    tenantId = boot.tenantId;
    investigationId = boot.investigationId;
    const summary = await ingestDirectory({ dir: TEST_DIR, investigationId, tenantId, dbUrl: getDbUrl() });
    expect(summary.failed).toBe(0);
    rows = await q((tx) => tx<Row[]>`
      SELECT s.filename, s.storage_uri AS source_uri, a.storage_uri AS artifact_uri, cd.full_text, cd.id AS doc_id
      FROM sources s
      LEFT JOIN artifacts a ON a.source_id = s.id AND a.kind = 'primary'
      LEFT JOIN content_documents cd ON cd.artifact_id = a.id
      WHERE s.investigation_id = ${investigationId}`);
  }, 120_000);

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(ENV_DIR, { recursive: true, force: true });
  });

  it("every chunk is one block and stores no text of its own", async () => {
    const [c] = await q((tx) => tx<{ n: number; with_text: number; not_one_block: number }[]>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE text IS NOT NULL)::int AS with_text,
             count(*) FILTER (WHERE cardinality(block_ids) <> 1)::int AS not_one_block
      FROM chunks WHERE investigation_id = ${investigationId}`);
    expect(c!.n).toBeGreaterThan(100);
    expect([c!.with_text, c!.not_one_block]).toEqual([0, 0]);
  });

  it("full_text is NULL where the blocks give it back exactly, and the rebuilt text is the parser's text", async () => {
    for (const [f, parse] of Object.entries(FILES)) {
      const r = rows.find((x) => x.filename === f);
      expect(r, f).toBeDefined();
      const parsed = await parse(readFileSync(join(FIX, f)));
      if (KEEPS_FULL_TEXT.has(f)) {
        expect(r!.full_text, `${f} keeps full_text`).toBe(parsed.fullText);
      } else {
        expect(r!.full_text, `${f} stores no full_text`).toBeNull();
        const blocks = await q((tx) => tx<{ char_start: number; char_end: number; text: string }[]>`
          SELECT char_start, char_end, text FROM content_blocks WHERE content_document_id = ${r!.doc_id} ORDER BY sequence`);
        expect(rebuildDocumentText(blocks), f).toBe(parsed.fullText);
      }
    }
    expect(rows.find((x) => x.filename === "note.txt")!.full_text).toBeNull();
  });

  it("FIXES-1 (DEV-034): every block's char_start / char_end point at exactly its text in the parser's fullText, for all 8 fixture formats", async () => {
    const wrong: string[] = [];
    for (const [f, parse] of Object.entries(FILES)) {
      const parsed = (await parse(readFileSync(join(FIX, f)))) as { fullText: string; blocks: Array<{ char_start: number; char_end: number; text: string }> };
      expect(parsed.blocks.length, f).toBeGreaterThan(0);
      for (const b of parsed.blocks) {
        if (parsed.fullText.slice(b.char_start, b.char_end) !== b.text) wrong.push(`${f} block at ${b.char_start}-${b.char_end}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every artifact points at its source object; nothing is written to the artifacts bucket", async () => {
    const withArtifact = rows.filter((r) => r.artifact_uri !== null);
    expect(withArtifact.length).toBeGreaterThanOrEqual(Object.keys(FILES).length + 2);
    for (const r of withArtifact) expect(r.artifact_uri, r.filename).toBe(r.source_uri);
    // Nothing writes to the artifacts bucket any more, so on a wiped stack it may not exist yet.
    await ensureEmulatorBucket(process.env.GCS_BUCKET_ARTIFACTS!);
    const objects = await listBucketObjects(process.env.GCS_BUCKET_ARTIFACTS!, `${tenantId}/`);
    expect(objects).toEqual([]);
  });
});
