import AdmZip from "adm-zip";
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import type { Rng } from "./prng.js";
import { encodePng, scannedPage, wrap } from "./raster.js";
import { BASE_TIME, formatDate, makeDate, paragraph, title, type Person } from "./words.js";

/**
 * Byte builders for each kind of fake file. Every builder is deterministic for a given Rng
 * state and carries the corpus marker where the format has room for it (a header, document
 * property, PNG tEXt chunk or zip comment), so guardrails/no-fake-corpus-in-repo.spec.ts can
 * recognise a generated file anywhere. Timestamps are fixed; nothing reads the clock.
 */

const FIXED = new Date(BASE_TIME);

/** A zip with fixed entry times and the marker as the archive comment. */
export function zipOf(entries: { name: string; data: Buffer }[], marker: string): Buffer {
  const zip = new AdmZip();
  for (const e of entries) {
    const entry = zip.addFile(e.name, e.data);
    entry.header.time = FIXED;
  }
  zip.addZipComment(marker);
  return zip.toBuffer();
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A minimal WordprocessingML document (what mammoth and Word both read). */
export function docx(paragraphs: string[], docTitle: string, marker: string): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join("");
  return zipOf(
    [
      {
        name: "[Content_Types].xml",
        data: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
        ),
      },
      {
        name: "_rels/.rels",
        data: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        ),
      },
      {
        name: "docProps/core.xml",
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(docTitle)}</dc:title><dc:description>${xmlEscape(marker)}</dc:description></cp:coreProperties>`,
        ),
      },
      {
        name: "word/document.xml",
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
        ),
      },
    ],
    marker,
  );
}

/** A minimal SpreadsheetML workbook with one sheet of inline strings and numbers. */
export function xlsx(rows: (string | number)[][], marker: string): Buffer {
  const colName = (i: number) => String.fromCharCode(65 + (i % 26));
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${colName(c)}${r + 1}`;
          return typeof v === "number"
            ? `<c r="${ref}"><v>${v}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rels = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  return zipOf(
    [
      {
        name: "[Content_Types].xml",
        data: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        ),
      },
      {
        name: "_rels/.rels",
        data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${rels}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
      },
      {
        name: "xl/workbook.xml",
        data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${rels}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
      },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${ns}><sheetData>${sheetRows}</sheetData></worksheet>`) },
    ],
    marker,
  );
}

async function finishPdf(pdf: PDFDocument, docTitle: string, marker: string): Promise<Buffer> {
  pdf.setTitle(docTitle);
  pdf.setKeywords([marker]);
  pdf.setProducer("casefile fake-corpus");
  pdf.setCreator("casefile fake-corpus");
  pdf.setCreationDate(FIXED);
  pdf.setModificationDate(FIXED);
  // The metadata setters write UTF-16 hex strings; the marker also goes in as a plain
  // literal string so a byte search finds it.
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of("CasefileFakeCorpus"), PDFString.of(marker));
  // No object streams: the Info dictionary (and the marker) stays readable in the file.
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** A PDF with a real text layer: `pages` pages of prose in Helvetica. */
export async function textPdf(rng: Rng, people: Person[], pages: number, marker: string): Promise<{ bytes: Buffer; text: string; title: string }> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const docTitle = `${title(rng)} - ${formatDate(makeDate(rng))}`;
  const texts: string[] = [];
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(p === 0 ? docTitle : `${docTitle} (continued)`, { x: 56, y: 790, size: 14, font, color: rgb(0, 0, 0) });
    let y = 760;
    while (y > 70) {
      const para = paragraph(rng, people);
      texts.push(para);
      for (const line of wrap(para, 95)) {
        if (y <= 70) break;
        page.drawText(line, { x: 56, y, size: 10, font });
        y -= 14;
      }
      y -= 10;
    }
  }
  return { bytes: await finishPdf(pdf, docTitle, marker), text: texts.join("\n\n"), title: docTitle };
}

/** A PDF of page images only (no text layer): what a scanner produces. Needs OCR. */
export async function scannedPdf(rng: Rng, people: Person[], pages: number, marker: string, text?: string): Promise<{ bytes: Buffer; text: string }> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const all: string[] = [];
  for (let p = 0; p < pages; p++) {
    const pageText = text ?? `${title(rng).toUpperCase()}  ${paragraph(rng, people, 12)} ${paragraph(rng, people, 12)}`;
    all.push(pageText);
    const img = scannedPage(rng, pageText);
    const png = encodePng(img.width, img.height, 1, img.pixels, marker);
    const embedded = await pdf.embedPng(png);
    const page = pdf.addPage([595, 842]);
    page.drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 });
  }
  return { bytes: await finishPdf(pdf, "Scanned document", marker), text: all.join("\n\n") };
}

export interface Attachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** An RFC 5322 message, multipart/mixed when it has attachments, with the marker as a header. */
export function eml(rng: Rng, from: Person, to: Person[], subject: string, body: string, attachments: Attachment[], marker: string, messageId: string): Buffer {
  const date = makeDate(rng).toUTCString().replace("GMT", "+0000");
  const head = [
    `From: ${from.first} ${from.last} <${from.email}>`,
    `To: ${to.map((p) => `${p.first} ${p.last} <${p.email}>`).join(", ")}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    `X-Casefile-Fake-Corpus: ${marker}`,
    "MIME-Version: 1.0",
  ];
  if (attachments.length === 0) {
    return Buffer.from([...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body, ""].join("\r\n"));
  }
  const boundary = `=_fc_${messageId.replace(/[^a-z0-9]/gi, "")}`;
  const parts = [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ];
  for (const a of attachments) {
    parts.push(`--${boundary}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${a.filename}"`, "");
    const b64 = a.data.toString("base64");
    for (let i = 0; i < b64.length; i += 76) parts.push(b64.slice(i, i + 76));
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n"));
}

/** The junk that real exports contain. */
export function junkFile(rng: Rng, kind: "thumbs" | "dsstore" | "desktop" | "tmp" | "lock" | "empty", marker: string): { name: string; data: Buffer } {
  switch (kind) {
    case "thumbs":
      return { name: "Thumbs.db", data: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), rng.fill(Buffer.alloc(rng.int(4, 40) * 1024)), Buffer.from(marker)]) };
    case "dsstore":
      return { name: ".DS_Store", data: Buffer.concat([Buffer.from("\0\0\0\x01Bud1"), rng.fill(Buffer.alloc(rng.int(2, 12) * 1024)), Buffer.from(marker)]) };
    case "desktop":
      return { name: "desktop.ini", data: Buffer.from(`[.ShellClassInfo]\r\nIconResource=C:\\Windows\\System32\\imageres.dll,-3\r\n; ${marker}\r\n`) };
    case "tmp":
      return { name: `~WRL${String(rng.int(0, 9999)).padStart(4, "0")}.tmp`, data: Buffer.concat([rng.fill(Buffer.alloc(rng.int(1, 64) * 1024)), Buffer.from(marker)]) };
    case "lock":
      return { name: `~$${title(rng).slice(0, 10)}.docx`, data: Buffer.concat([Buffer.from([0x0a]), Buffer.from(`owner ${marker}`.padEnd(161, " "))]) };
    case "empty":
      return { name: `${title(rng)} notes.txt`, data: Buffer.alloc(0) };
  }
}

/** A file that claims a format it does not contain. */
export function corruptFile(rng: Rng, kind: "pdf" | "docx" | "zip" | "xlsx", marker: string): { ext: string; data: Buffer } {
  const garbage = rng.fill(Buffer.alloc(rng.int(8, 200) * 1024));
  switch (kind) {
    case "pdf":
      // A PDF header and a truncated body: the parser throws.
      return { ext: ".pdf", data: Buffer.concat([Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\n"), garbage, Buffer.from(`\n% ${marker}\n`)]) };
    case "docx":
    case "xlsx":
      // A zip signature, then noise: not a readable archive.
      return { ext: `.${kind}`, data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), garbage, Buffer.from(marker)]) };
    case "zip":
      return { ext: ".zip", data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), garbage, Buffer.from(marker)]) };
  }
}
