import { getDocumentProxy } from "unpdf";

export interface ParsedPdfSpan {
  text: string;
  char_start: number;
  char_end: number;
  page: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    page: number;
  };
}

export interface ParsedPdfBlock {
  sequence: number;
  page: number;
  block_type: "heading" | "paragraph" | "table" | "table_cell" | "list_item";
  section_path: string | null;
  char_start: number;
  char_end: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    page: number;
    spans: ParsedPdfSpan[];
  };
  text: string;
  spans: ParsedPdfSpan[];
}

export interface ParsedPdfResult {
  fullText: string;
  pageCount: number;
  blocks: ParsedPdfBlock[];
  layout_confidence: number;
}

interface RawTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees?: number;
}

/**
 * Structure-aware PDF text layer extractor (PRD §10.2, §5.2 Stage 3 Normalization).
 * Extracts text page-by-page, groups text into structural blocks (headings, paragraphs, tables, multi-column),
 * and computes precise page-, block-, and span-level bounding box locators.
 */
export async function parsePdfStructure(pdfBuffer: Uint8Array | Buffer): Promise<ParsedPdfResult> {
  try {
    const proxy = await getDocumentProxy(new Uint8Array(pdfBuffer));
    const pageCount = proxy.numPages;

    const blocks: ParsedPdfBlock[] = [];
    let fullText = "";
    let currentSequence = 1;
    let currentSectionPath = "Document Root";
    let hasComplexOrRotatedLayout = false;

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await proxy.getPage(pageNum);
      const textContent = await page.getTextContent();

      const rawItems: RawTextItem[] = [];
      for (const item of textContent.items) {
        if ("str" in item && typeof item.str === "string" && item.str.trim().length > 0) {
          const transform = item.transform || [1, 0, 0, 1, 0, 0];
          const a = transform[0] ?? 1;
          const b = transform[1] ?? 0;
          const c = transform[2] ?? 0;
          const d = transform[3] ?? 1;
          const e = transform[4] ?? 0;
          const f = transform[5] ?? 0;

          // Detect rotation
          if (b !== 0 || c !== 0) {
            hasComplexOrRotatedLayout = true;
          }

          const width = item.width || Math.hypot(a, b);
          const height = item.height || Math.hypot(c, d) || 12;

          // Compute 4 corner points transformed
          const x0 = e;
          const y0 = f;
          const x1 = e + a * (width / Math.max(1, Math.hypot(a, b)));
          const y1 = f + d * (height / Math.max(1, Math.hypot(c, d)));

          rawItems.push({
            str: item.str,
            x: Math.min(x0, x1),
            y: Math.min(y0, y1),
            width: Math.abs(x1 - x0) || width,
            height: Math.abs(y1 - y0) || height,
          });
        }
      }

      if (rawItems.length === 0) {
        continue;
      }

      // Detect multi-column layout by checking distinct X clusters
      const xPositions = rawItems.map((i) => i.x);
      const minX = Math.min(...xPositions);
      const maxX = Math.max(...xPositions);
      const isMultiColumn = maxX - minX >= 200 && xPositions.some((x) => x >= minX + 180);
      if (isMultiColumn) {
        hasComplexOrRotatedLayout = true;
      }

      // Group items: if multi-column, group by column first (X buckets) then by Y
      const columns: RawTextItem[][] = [];
      if (isMultiColumn) {
        const midPoint = (minX + maxX) / 2;
        const leftCol = rawItems.filter((i) => i.x < midPoint);
        const rightCol = rawItems.filter((i) => i.x >= midPoint);
        if (leftCol.length > 0) columns.push(leftCol);
        if (rightCol.length > 0) columns.push(rightCol);
      } else {
        columns.push(rawItems);
      }

      for (const colItems of columns) {
        colItems.sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));

        const lines: { items: RawTextItem[]; text: string; x0: number; y0: number; x1: number; y1: number }[] = [];
        let currentLineItems: RawTextItem[] = [];

        for (const item of colItems) {
          if (currentLineItems.length === 0) {
            currentLineItems.push(item);
          } else {
            const last = currentLineItems[0]!;
            if (Math.abs(item.y - last.y) <= 4) {
              currentLineItems.push(item);
            } else {
              currentLineItems.sort((a, b) => a.x - b.x);
              const lineStr = currentLineItems.map((i) => i.str).join(" ");
              const lx0 = Math.min(...currentLineItems.map((i) => i.x));
              const ly0 = Math.min(...currentLineItems.map((i) => i.y));
              const lx1 = Math.max(...currentLineItems.map((i) => i.x + i.width));
              const ly1 = Math.max(...currentLineItems.map((i) => i.y + i.height));
              lines.push({ items: currentLineItems, text: lineStr, x0: lx0, y0: ly0, x1: lx1, y1: ly1 });
              currentLineItems = [item];
            }
          }
        }

        if (currentLineItems.length > 0) {
          currentLineItems.sort((a, b) => a.x - b.x);
          const lineStr = currentLineItems.map((i) => i.str).join(" ");
          const lx0 = Math.min(...currentLineItems.map((i) => i.x));
          const ly0 = Math.min(...currentLineItems.map((i) => i.y));
          const lx1 = Math.max(...currentLineItems.map((i) => i.x + i.width));
          const ly1 = Math.max(...currentLineItems.map((i) => i.y + i.height));
          lines.push({ items: currentLineItems, text: lineStr, x0: lx0, y0: ly0, x1: lx1, y1: ly1 });
        }

        for (const line of lines) {
          const isHeading =
            line.text.toUpperCase() === line.text && line.text.length < 80 && line.text.trim().length > 3;

          const isTable = line.text.includes("|") || line.items.length >= 3;

          if (isHeading) {
            currentSectionPath = line.text.trim();
          }

          const blockType: "heading" | "paragraph" | "table" = isHeading
            ? "heading"
            : isTable
            ? "table"
            : "paragraph";

          const blockCharStart = fullText.length > 0 ? fullText.length + 1 : 0;
          if (fullText.length > 0) {
            fullText += "\n";
          }
          const blockTextStartOffset = fullText.length;
          fullText += line.text;
          const blockCharEnd = fullText.length;

          // Build exact span-level locators for every text item within this block
          const spans: ParsedPdfSpan[] = [];
          let runningOffset = blockTextStartOffset;

          for (const item of line.items) {
            const itemText = item.str;
            const spanStart = runningOffset;
            const spanEnd = spanStart + itemText.length;
            runningOffset = spanEnd + 1; // +1 for the joining space

            spans.push({
              text: itemText,
              char_start: spanStart,
              char_end: spanEnd,
              page: pageNum,
              bbox: {
                x0: Math.round(item.x * 100) / 100,
                y0: Math.round(item.y * 100) / 100,
                x1: Math.round((item.x + item.width) * 100) / 100,
                y1: Math.round((item.y + item.height) * 100) / 100,
                page: pageNum,
              },
            });
          }

          const blockBbox = {
            x0: Math.round(line.x0 * 100) / 100,
            y0: Math.round(line.y0 * 100) / 100,
            x1: Math.round(line.x1 * 100) / 100,
            y1: Math.round(line.y1 * 100) / 100,
            page: pageNum,
            spans,
          };

          blocks.push({
            sequence: currentSequence++,
            page: pageNum,
            block_type: blockType,
            section_path: currentSectionPath,
            char_start: blockCharStart,
            char_end: blockCharEnd,
            bbox: blockBbox,
            text: line.text,
            spans,
          });
        }
      }
    }

    return {
      fullText,
      pageCount,
      blocks,
      layout_confidence: hasComplexOrRotatedLayout ? 0.85 : 1.0,
    };
  } catch (err) {
    // No fallback. Until 2026-09-04 this branch returned the raw PDF bytes decoded as
    // UTF-8 as "text", pageCount 1, layout_confidence 0.7 and an invented bounding box,
    // and ingest then indexed the result as evidence. A PDF the parser cannot read is a
    // failure the caller must see: ingest marks the source 'unprocessable'.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`PDF parse failed: ${message}`, { cause: err });
  }
}
