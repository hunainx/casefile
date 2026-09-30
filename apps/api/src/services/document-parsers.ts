import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import * as XLSX from "xlsx";
import { convert as htmlToText } from "html-to-text";
import { simpleParser } from "mailparser";
import MsgReaderModule from "@kenjiuno/msgreader";
import AdmZip from "adm-zip";

// @kenjiuno/msgreader is CommonJS with `exports.default = MsgReader`. Depending on the
// loader (Node ESM, tsx, vitest), the default import is either the class itself or the
// CJS exports object that wraps it.
type MsgReaderClass = typeof MsgReaderModule;
function isWrappedModule(mod: MsgReaderClass | { default: MsgReaderClass }): mod is { default: MsgReaderClass } {
  return "default" in mod && typeof mod.default === "function";
}
const MsgReader: MsgReaderClass = isWrappedModule(MsgReaderModule) ? MsgReaderModule.default : MsgReaderModule;

export interface ParsedSpan {
  text: string;
  char_start: number;
  char_end: number;
  page: number | null;
}

export interface ParsedBlock {
  sequence: number;
  block_type: "heading" | "paragraph" | "table" | "table_cell" | "list_item" | "email_header";
  section_path: string | null;
  page: number | null;
  char_start: number;
  char_end: number;
  text: string;
}

export interface ParsedDocumentResult {
  fullText: string;
  docType: string;
  pageCount: number | null;
  blocks: ParsedBlock[];
  layout_confidence: number;
  metadata?: Record<string, unknown>;
}

export interface ParsedEmailAttachment {
  filename: string;
  contentType: string;
  byteSize: number;
  content: Buffer;
}

export interface ParsedEmailResult extends ParsedDocumentResult {
  headers: {
    from?: string | undefined;
    to?: string | undefined;
    cc?: string | undefined;
    /** BIGDATA-3B: only when the message carries it (a sender's copy, a PST message); omitted otherwise. */
    bcc?: string | undefined;
    subject?: string | undefined;
    date?: string | undefined;
    messageId?: string | undefined;
  };
  attachments: ParsedEmailAttachment[];
}

export interface ZipGuardOptions {
  maxTotalUncompressedBytes?: number;
  maxFileCount?: number;
  maxDepth?: number;
}

export interface ExtractedZipEntry {
  path: string;
  filename: string;
  byteSize: number;
  content: Buffer;
  depth: number;
  /** The entry's modification time as the zip records it (BIGDATA-3: the file-date filter). */
  modified?: Date | undefined;
}

export interface ExtractedZipResult {
  totalFiles: number;
  totalUncompressedBytes: number;
  entries: ExtractedZipEntry[];
}

export class ZipBombError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipBombError";
  }
}

/**
 * Paragraph blocks whose offsets point at exactly their text in `text` (FIXES-1, DEV-034).
 * `paragraphs` are `text` split on blank lines and trimmed, in order. Until FIXES-1 the offsets of
 * .doc, HTML and RTF blocks were numbered as if the paragraphs were joined by one "\n", while the
 * text keeps its real gaps ("\n\n", trimmed spaces), so from the second block on
 * text.slice(char_start, char_end) was not the block. Each paragraph is now found in the text,
 * from the end of the previous one.
 */
function paragraphBlocks(text: string, paragraphs: readonly string[], sectionPath: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let cursor = 0;
  for (const p of paragraphs) {
    const at = text.indexOf(p, cursor);
    // Always found: p is a trimmed piece of text, taken in order. The guard keeps a wrong offset impossible.
    if (at < 0) throw new Error(`paragraph ${blocks.length + 1} is not in the document text (parser offsets)`);
    blocks.push({
      sequence: blocks.length + 1,
      block_type: "paragraph",
      section_path: sectionPath,
      page: null,
      char_start: at,
      char_end: at + p.length,
      text: p,
    });
    cursor = at + p.length;
  }
  return blocks;
}

/**
 * Parses DOCX (.docx) files using Mammoth.
 * Extracts clean text and structural paragraphs.
 */
export async function parseDocx(buffer: Buffer): Promise<ParsedDocumentResult> {
  const result = await mammoth.extractRawText({ buffer });
  const rawText = result.value || "";
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const blocks: ParsedBlock[] = [];
  let currentChar = 0;

  if (lines.length === 0) {
    return {
      fullText: "",
      docType: "word_document",
      pageCount: null,
      blocks: [],
      layout_confidence: 1.0,
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const charStart = currentChar;
    const charEnd = charStart + line.length;
    currentChar = charEnd + 1;

    blocks.push({
      sequence: i + 1,
      block_type: line.length < 80 && !line.endsWith(".") ? "heading" : "paragraph",
      section_path: "Document Body",
      page: null, // DOCX format has dynamic layout (no fixed pages)
      char_start: charStart,
      char_end: charEnd,
      text: line,
    });
  }

  return {
    fullText: lines.join("\n"),
    docType: "word_document",
    pageCount: null,
    blocks,
    layout_confidence: 1.0,
  };
}

/**
 * Parses binary DOC (.doc) Word 97-2004 files using word-extractor.
 */
export async function parseDoc(buffer: Buffer): Promise<ParsedDocumentResult> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);

  const body = doc.getBody() || "";
  // getHeaders() includes the footers unless told otherwise; they are added separately below.
  const headers = doc.getHeaders({ includeFooters: false }) || "";
  const footers = doc.getFooters() || "";

  const sections: string[] = [];
  if (headers.trim()) sections.push(headers.trim());
  if (body.trim()) sections.push(body.trim());
  if (footers.trim()) sections.push(footers.trim());

  const fullText = sections.join("\n\n");
  const paragraphs = fullText.split(/\r?\n\r?\n/).map((p) => p.trim()).filter(Boolean);

  const blocks: ParsedBlock[] = paragraphBlocks(fullText, paragraphs, "Document Body");

  return {
    fullText,
    docType: "word_legacy_document",
    pageCount: null,
    blocks,
    layout_confidence: 0.95,
  };
}

/**
 * Parses Excel spreadsheets (.xlsx, .xls) using SheetJS.
 * Each sheet is mapped to a discrete page/table block.
 */
export async function parseSpreadsheet(buffer: Buffer, _ext = ".xlsx"): Promise<ParsedDocumentResult> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetNames = workbook.SheetNames || [];

  const blocks: ParsedBlock[] = [];
  const fullTextParts: string[] = [];
  let currentChar = 0;

  for (let sIdx = 0; sIdx < sheetNames.length; sIdx++) {
    const sheetName = sheetNames[sIdx]!;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Convert sheet to clean CSV text
    const csvContent = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (!csvContent) continue;

    const sheetText = `[Sheet: ${sheetName}]\n${csvContent}`;
    fullTextParts.push(sheetText);

    const charStart = currentChar;
    const charEnd = charStart + sheetText.length;
    currentChar = charEnd + 2;

    blocks.push({
      sequence: blocks.length + 1,
      block_type: "table",
      section_path: `Sheet: ${sheetName}`,
      page: sIdx + 1, // Sheet index mapped to page
      char_start: charStart,
      char_end: charEnd,
      text: sheetText,
    });
  }

  const fullText = fullTextParts.join("\n\n");

  return {
    fullText,
    docType: "spreadsheet",
    pageCount: sheetNames.length || 1,
    blocks,
    layout_confidence: 1.0,
  };
}

/**
 * Parses HTML (.html, .htm) files using html-to-text.
 */
export async function parseHtml(buffer: Buffer): Promise<ParsedDocumentResult> {
  const htmlContent = buffer.toString("utf-8");
  const text = htmlToText(htmlContent, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  });

  const cleanText = text.trim();
  const paragraphs = cleanText.split(/\r?\n\r?\n/).map((p) => p.trim()).filter(Boolean);

  const blocks: ParsedBlock[] = paragraphBlocks(cleanText, paragraphs, "HTML Content");

  return {
    fullText: cleanText,
    docType: "html_document",
    pageCount: null,
    blocks,
    layout_confidence: 1.0,
  };
}

/**
 * Parses Rich Text Format (.rtf) files by stripping control words, groups, and font tables.
 */
export async function parseRtf(buffer: Buffer): Promise<ParsedDocumentResult> {
  const rawRtf = buffer.toString("latin1");

  // Remove RTF control destinations such as {\fonttbl...}, {\colortbl...}, {\stylesheet...}, {\info...}, {\*...}
  let text = rawRtf.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|\*)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi, "");

  // Unescape hex sequences \'xx
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Replace RTF linebreaks and paragraphs
  text = text.replace(/\\par\b/gi, "\n");
  text = text.replace(/\\line\b/gi, "\n");
  text = text.replace(/\\tab\b/gi, "\t");

  // Remove remaining control words (\b, \i, \fs24, etc.)
  text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, "");

  // Remove group braces
  text = text.replace(/[{}]/g, "");

  const cleanText = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const paragraphs = cleanText.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  const blocks: ParsedBlock[] = paragraphBlocks(cleanText, paragraphs, "RTF Body");

  return {
    fullText: cleanText,
    docType: "rtf_document",
    pageCount: null,
    blocks,
    layout_confidence: 0.9,
  };
}

const TYPE_EXTENSIONS: Record<string, string> = {
  "message/rfc822": ".eml",
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/calendar": ".ics",
  "application/zip": ".zip",
};

/** The file extension for an attachment's MIME type, for naming an attachment that has no name. */
function extensionForType(contentType: string | undefined): string {
  return TYPE_EXTENSIONS[(contentType ?? "").toLowerCase().split(";")[0]!.trim()] ?? ".bin";
}

/**
 * Parses RFC822 Email files (.eml) using mailparser.
 * Extracts headers, body, and attachments.
 */
export async function parseEml(buffer: Buffer): Promise<ParsedEmailResult> {
  const parsed = await simpleParser(buffer);

  const from = parsed.from?.text || "";
  const to = Array.isArray(parsed.to)
    ? parsed.to.map((t) => t.text).join(", ")
    : parsed.to?.text || "";
  const cc = Array.isArray(parsed.cc)
    ? parsed.cc.map((c) => c.text).join(", ")
    : parsed.cc?.text || "";
  const bcc = Array.isArray(parsed.bcc)
    ? parsed.bcc.map((c) => c.text).join(", ")
    : parsed.bcc?.text || "";
  const subject = parsed.subject || "(No Subject)";
  const dateStr = parsed.date ? parsed.date.toISOString() : "";
  const messageId = parsed.messageId || "";

  const headerLines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Date: ${dateStr}`,
    `Subject: ${subject}`,
    messageId ? `Message-ID: ${messageId}` : null,
  ].filter(Boolean) as string[];

  const headerText = headerLines.join("\n");
  const bodyText = (parsed.text || "").trim();
  const fullText = `${headerText}\n\n${bodyText}`.trim();

  const blocks: ParsedBlock[] = [];

  // Header block
  blocks.push({
    sequence: 1,
    block_type: "email_header",
    section_path: "Email Headers",
    page: null,
    char_start: 0,
    char_end: headerText.length,
    text: headerText,
  });

  // Body block
  if (bodyText) {
    blocks.push({
      sequence: 2,
      block_type: "paragraph",
      section_path: "Email Body",
      page: null,
      char_start: headerText.length + 2,
      char_end: fullText.length,
      text: bodyText,
    });
  }

  const attachments: ParsedEmailAttachment[] = [];
  if (parsed.attachments && Array.isArray(parsed.attachments)) {
    parsed.attachments.forEach((att, i) => {
      if (!att.content) return;
      // BIGDATA-3B: an attachment without a file name (an inline image, a forwarded message/rfc822
      // part) used to be dropped here; it is named by its position and type, as parseMsg does.
      attachments.push({
        filename: att.filename || `attachment_${i + 1}${extensionForType(att.contentType)}`,
        contentType: att.contentType || "application/octet-stream",
        byteSize: att.size || att.content.length,
        content: att.content,
      });
    });
  }

  return {
    fullText,
    docType: "email_message",
    pageCount: null,
    blocks,
    layout_confidence: 1.0,
    headers: {
      from,
      to,
      cc: cc || undefined,
      ...(bcc ? { bcc } : {}),
      subject,
      date: dateStr || undefined,
      messageId: messageId || undefined,
    },
    attachments,
  };
}

/**
 * Parses Outlook Compound Binary Email files (.msg) using @kenjiuno/msgreader.
 */
export async function parseMsg(buffer: Buffer): Promise<ParsedEmailResult> {
  // An exact view over the buffer's bytes: a Node Buffer may be a slice of a larger pool.
  const reader = new MsgReader(new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  const msgInfo = reader.getFileData();

  const from = msgInfo.senderName
    ? `${msgInfo.senderName} <${msgInfo.senderEmail || ""}>`.trim()
    : msgInfo.senderEmail || "";

  // msgreader reports PR_RECIPIENT_TYPE as "to" / "cc" / "bcc" (DEV-019).
  const recipients = msgInfo.recipients ?? [];
  const formatRecipient = (r: { name?: string; email?: string }) => `${r.name || ""} <${r.email || ""}>`.trim();
  const to = recipients
    .filter((r) => r.recipType === undefined || r.recipType === "to")
    .map(formatRecipient)
    .join(", ");
  const cc = recipients
    .filter((r) => r.recipType === "cc")
    .map(formatRecipient)
    .join(", ");
  const bcc = recipients
    .filter((r) => r.recipType === "bcc")
    .map(formatRecipient)
    .join(", ");

  const subject = msgInfo.subject || "(No Subject)";
  const dateStr = msgInfo.clientSubmitTime || msgInfo.messageDeliveryTime || "";
  const messageId = msgInfo.messageId || "";

  const headerLines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    dateStr ? `Date: ${dateStr}` : null,
    `Subject: ${subject}`,
    messageId ? `Message-ID: ${messageId}` : null,
  ].filter(Boolean) as string[];

  const headerText = headerLines.join("\n");
  let bodyText = (msgInfo.body || "").trim();
  if (!bodyText && msgInfo.bodyHtml) {
    bodyText = htmlToText(msgInfo.bodyHtml, { wordwrap: false }).trim();
  }

  const fullText = `${headerText}\n\n${bodyText}`.trim();

  const blocks: ParsedBlock[] = [
    {
      sequence: 1,
      block_type: "email_header",
      section_path: "Email Headers",
      page: null,
      char_start: 0,
      char_end: headerText.length,
      text: headerText,
    },
  ];

  if (bodyText) {
    blocks.push({
      sequence: 2,
      block_type: "paragraph",
      section_path: "Email Body",
      page: null,
      char_start: headerText.length + 2,
      char_end: fullText.length,
      text: bodyText,
    });
  }

  const attachments: ParsedEmailAttachment[] = [];
  if (Array.isArray(msgInfo.attachments)) {
    for (let i = 0; i < msgInfo.attachments.length; i++) {
      const attSummary = msgInfo.attachments[i];
      if (!attSummary) continue;
      try {
        const attData = reader.getAttachment(i);
        const filename = attSummary.fileName || attSummary.name || `attachment_${i + 1}`;
        if (attData && attData.content) {
          const contentBuf = Buffer.from(attData.content);
          attachments.push({
            filename,
            contentType: "application/octet-stream",
            byteSize: contentBuf.length,
            content: contentBuf,
          });
        }
      } catch {
        // Ignore unparseable attachment
      }
    }
  }

  return {
    fullText,
    docType: "email_message",
    pageCount: null,
    blocks,
    layout_confidence: 1.0,
    headers: {
      from,
      to,
      cc: cc || undefined,
      ...(bcc ? { bcc } : {}),
      subject,
      date: dateStr || undefined,
      messageId: messageId || undefined,
    },
    attachments,
  };
}

/**
 * Expands ZIP archives in memory with configurable zip-bomb protection limits.
 * Default limits: max 500 MB uncompressed, max 10,000 files, max depth 3.
 */
export async function extractZipArchive(
  buffer: Buffer,
  options?: ZipGuardOptions,
  currentDepth = 1
): Promise<ExtractedZipResult> {
  const maxBytes = options?.maxTotalUncompressedBytes ?? 500 * 1024 * 1024; // 500 MB
  const maxFiles = options?.maxFileCount ?? 10000;
  const maxDepth = options?.maxDepth ?? 3;

  if (currentDepth > maxDepth) {
    throw new ZipBombError(
      `ZIP bomb protection: nesting depth ${currentDepth} exceeds maximum allowed depth of ${maxDepth}`
    );
  }

  const zip = new AdmZip(buffer);
  const zipEntries = zip.getEntries();

  let totalUncompressedBytes = 0;
  const entries: ExtractedZipEntry[] = [];

  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;

    const uncompressedSize = entry.header.size;
    totalUncompressedBytes += uncompressedSize;

    if (totalUncompressedBytes > maxBytes) {
      throw new ZipBombError(
        `ZIP bomb protection: uncompressed size (${totalUncompressedBytes} bytes) exceeds limit of ${maxBytes} bytes`
      );
    }

    if (entries.length >= maxFiles) {
      throw new ZipBombError(
        `ZIP bomb protection: file count (${entries.length + 1}) exceeds limit of ${maxFiles} files`
      );
    }

    const content = entry.getData();
    const entryPath = entry.entryName;
    const filename = entry.name;

    // Check if inner entry is also a zip archive
    if (filename.toLowerCase().endsWith(".zip") && content.length > 4) {
      const innerResult = await extractZipArchive(content, options, currentDepth + 1);
      totalUncompressedBytes += innerResult.totalUncompressedBytes;
      if (totalUncompressedBytes > maxBytes) {
        throw new ZipBombError(
          `ZIP bomb protection: nested uncompressed size exceeds limit of ${maxBytes} bytes`
        );
      }
      for (const innerEntry of innerResult.entries) {
        entries.push({
          path: `${entryPath}/${innerEntry.path}`,
          filename: innerEntry.filename,
          byteSize: innerEntry.byteSize,
          content: innerEntry.content,
          depth: innerEntry.depth,
          modified: innerEntry.modified,
        });
      }
    } else {
      entries.push({
        path: entryPath,
        filename,
        byteSize: content.length,
        content,
        depth: currentDepth,
        modified: entry.header.time instanceof Date && !Number.isNaN(entry.header.time.getTime()) ? entry.header.time : undefined,
      });
    }
  }

  return {
    totalFiles: entries.length,
    totalUncompressedBytes,
    entries,
  };
}
