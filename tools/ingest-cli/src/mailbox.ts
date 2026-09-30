import { createHash } from "node:crypto";
import { createReadStream, openSync, readSync, closeSync } from "node:fs";
import { extname } from "node:path";
import { parseEml, type ParsedEmailResult } from "../../../apps/api/src/services/document-parsers.js";
import { mboxLocator, pstLocator } from "./mailbox-paths.js";
import { readMbox, NotAnMboxError, looksLikeMbox, type MboxMessage } from "./mbox.js";
import { openPst, walkPst, renderPstMessage, pstMessageByNid, PstUnreadableError, type RenderNotes, type PstEntry } from "./pst.js";
import type { MessageLocator } from "./mailbox-paths.js";

/**
 * Mailbox files (BIGDATA-3B, D108-D112): PST, OST and MBOX, read message by message so memory
 * stays flat whatever the file's size. The mailbox file itself is stored whole and never changed;
 * each message becomes its own source under it (mailbox-ingest.ts).
 */

export type MailboxFormat = "pst" | "ost" | "mbox";

const MAILBOX_EXTENSIONS: Record<string, MailboxFormat> = { ".pst": "pst", ".ost": "ost", ".mbox": "mbox", ".mbx": "mbox" };

/** The mailbox format of a file by its name: .pst, .ost, .mbox or .mbx. */
export function mailboxFormatByName(fileName: string): MailboxFormat | null {
  return MAILBOX_EXTENSIONS[extname(fileName).toLowerCase()] ?? null;
}

/**
 * The mailbox format of a file on disk: by its name, or, for a file with no extension (as
 * Thunderbird keeps its folders: "Inbox", "Sent"), by its first line being an mbox "From " line.
 */
export function mailboxFormatOfFile(path: string, fileName: string): MailboxFormat | null {
  const byName = mailboxFormatByName(fileName);
  if (byName) return byName;
  if (extname(fileName) !== "") return null;
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(1024);
    const n = readSync(fd, head, 0, head.length, 0);
    return looksLikeMbox(head.subarray(0, n)) ? "mbox" : null;
  } finally {
    closeSync(fd);
  }
}

export const MAILBOX_MIME: Record<MailboxFormat, string> = {
  pst: "application/vnd.ms-outlook-pst",
  ost: "application/vnd.ms-outlook-ost",
  mbox: "application/mbox",
};

/** A mailbox that is stored and listed but not read, and why. */
export class MailboxUnreadableError extends Error {
  constructor(message: string, readonly code: "password" | "encrypted" | "not-a-mailbox" | "corrupt") {
    super(message);
    this.name = "MailboxUnreadableError";
  }
}

export type MailboxEntry =
  | {
      kind: "message";
      folder: string[];
      locator: string;
      /** The message's stored object: the MBOX message's own bytes, or a PST message's rendering. */
      bytes: Buffer;
      rendered: boolean;
      /** What the mailbox says about the message beyond its headers (offset, node id, transport headers ...). */
      meta: Record<string, unknown>;
    }
  | { kind: "error"; folder: string[]; locator: string | null; reason: string }
  | { kind: "folder-skipped"; folder: string[]; reason: string };

export interface MailboxReadOptions {
  /** A message (MBOX) or an attachment (PST) above this size is listed, not read. */
  maxMessageBytes: number;
}

/** An MBOX message as a mailbox entry (a message above the size limit is listed, not read). */
export function mboxEntry(m: MboxMessage, maxMessageBytes: number): MailboxEntry {
  const meta = { mbox_offset: m.offset, mbox_length: m.length, mbox_from_line: m.fromLine, ...(m.truncated ? { truncated: true } : {}) };
  if (m.tooLarge) return { kind: "error", folder: [], locator: mboxLocator(m.offset), reason: `message too large to read in this version (${m.length.toLocaleString("en-US")} bytes; the limit is ${maxMessageBytes.toLocaleString("en-US")})` };
  return { kind: "message", folder: [], locator: mboxLocator(m.offset), bytes: m.bytes, rendered: false, meta };
}

/**
 * A PST walk entry as a mailbox entry: a message is rendered to .eml bytes (D112). BIGDATA-4: a
 * message of a password-protected PST says so (`mailbox_password_protected`, the owner's answer 1).
 */
export function pstEntry(e: PstEntry, maxAttachmentBytes: number, passwordProtected: boolean): MailboxEntry {
  if (e.kind === "folder-skipped") return e;
  if (e.kind === "error") return { kind: "error", folder: e.folder, locator: e.nid !== null ? pstLocator(e.nid) : null, reason: e.reason };
  const notes: RenderNotes = { attachmentsNotRead: [] };
  let bytes: Buffer;
  try {
    bytes = renderPstMessage(e.message, notes, { maxAttachmentBytes });
  } catch (err: unknown) {
    return { kind: "error", folder: e.folder, locator: pstLocator(e.nid), reason: `the message could not be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  const transport = e.message.transportMessageHeaders ?? "";
  return {
    kind: "message",
    folder: e.folder,
    locator: pstLocator(e.nid),
    bytes,
    rendered: true,
    meta: {
      pst_node_id: e.nid,
      message_class: e.message.messageClass,
      ...(transport ? { transport_headers: transport.length > 65536 ? `${transport.slice(0, 65536)}\n[cut at 65,536 characters]` : transport } : {}),
      ...(notes.attachmentsNotRead.length ? { attachments_not_read: notes.attachmentsNotRead } : {}),
      ...(passwordProtected ? { mailbox_password_protected: true } : {}),
    },
  };
}

/**
 * Opens a mailbox (throws MailboxUnreadableError before any message when it cannot be read) and
 * returns its description and its entries, in file order (MBOX) or folder order (PST).
 * `source` is a file on disk, or for MBOX any byte stream (a bucket object read as a stream).
 */
export async function openMailbox(
  format: MailboxFormat,
  source: { path: string } | { stream: () => AsyncIterable<Buffer> },
  opts: MailboxReadOptions,
): Promise<{ description: Record<string, unknown>; entries: AsyncGenerator<MailboxEntry>; close: () => void }> {
  if (format === "mbox") {
    const open = () => ("path" in source ? createReadStream(source.path, { highWaterMark: 1 << 20 }) : source.stream());
    // The first message is read here, so a file that is not an mbox is refused before anything is recorded.
    const it = readMbox(open(), { maxMessageBytes: opts.maxMessageBytes });
    let first: IteratorResult<Awaited<ReturnType<typeof it.next>>["value"]>;
    try {
      first = await it.next();
    } catch (err: unknown) {
      if (err instanceof NotAnMboxError) throw new MailboxUnreadableError(err.message, "not-a-mailbox");
      throw err;
    }
    async function* entries(): AsyncGenerator<MailboxEntry> {
      let r = first;
      while (!r.done) {
        yield mboxEntry(r.value, opts.maxMessageBytes);
        r = await it.next();
      }
    }
    return { description: { format: "mbox" }, entries: entries(), close: () => {} };
  }
  if (!("path" in source)) throw new Error("a PST or OST is read from a file on disk");
  let opened;
  try {
    opened = openPst(source.path);
  } catch (err: unknown) {
    if (err instanceof PstUnreadableError) throw new MailboxUnreadableError(err.message, err.code === "not-a-pst" ? "not-a-mailbox" : err.code);
    throw err;
  }
  const { file, info } = opened;
  async function* entries(): AsyncGenerator<MailboxEntry> {
    for (const e of walkPst(file)) yield pstEntry(e, opts.maxMessageBytes, info.passwordProtected);
  }
  return {
    description: { format, store_name: info.storeName, pst_file_type: info.fileType, ...(info.passwordProtected ? { password_protected: true } : {}) },
    entries: entries(),
    close: () => file.close(),
  };
}

/**
 * One message of a mailbox by its locator (`pnpm ingest:include`): an MBOX message read from its
 * offset, or a PST message by its node id, rendered as the ingest renders it. `source` is the file
 * on disk, or for MBOX a stream that starts at the offset.
 */
export async function readOneMessage(
  format: MailboxFormat,
  source: { path: string } | { streamFromOffset: () => AsyncIterable<Buffer> },
  locator: MessageLocator,
  opts: MailboxReadOptions,
): Promise<{ bytes: Buffer; rendered: boolean; meta: Record<string, unknown> }> {
  if (format === "mbox") {
    if (locator.kind !== "offset") throw new Error("an MBOX message is found by its offset");
    const stream = "path" in source ? createReadStream(source.path, { start: locator.offset, highWaterMark: 1 << 20 }) : source.streamFromOffset();
    for await (const m of readMbox(stream, { maxMessageBytes: opts.maxMessageBytes })) {
      if (m.tooLarge) throw new Error(`the message at offset ${locator.offset} is too large to read in this version`);
      return { bytes: m.bytes, rendered: false, meta: { mbox_offset: locator.offset, mbox_length: m.length, mbox_from_line: m.fromLine, ...(m.truncated ? { truncated: true } : {}) } };
    }
    throw new Error(`no message starts at offset ${locator.offset}`);
  }
  if (locator.kind !== "nid" || !("path" in source)) throw new Error("a PST message is found by its node id, in a file on disk");
  let opened;
  try {
    opened = openPst(source.path);
  } catch (err: unknown) {
    if (err instanceof PstUnreadableError) throw new MailboxUnreadableError(err.message, err.code === "not-a-pst" ? "not-a-mailbox" : err.code);
    throw err;
  }
  try {
    const m = pstMessageByNid(opened.file, locator.nid);
    if (!m) throw new Error(`no message with node id 0x${locator.nid.toString(16)} in the file`);
    const notes: RenderNotes = { attachmentsNotRead: [] };
    const bytes = renderPstMessage(m, notes, { maxAttachmentBytes: opts.maxMessageBytes });
    return {
      bytes,
      rendered: true,
      meta: {
        pst_node_id: locator.nid,
        message_class: m.messageClass,
        ...(notes.attachmentsNotRead.length ? { attachments_not_read: notes.attachmentsNotRead } : {}),
        ...(opened.info.passwordProtected ? { mailbox_password_protected: true } : {}),
      },
    };
  } finally {
    opened.file.close();
  }
}

// ── Message identity (exact duplicates) ──────────────────────────────────────

export interface MessageHeaders {
  from?: string | undefined;
  to?: string | undefined;
  cc?: string | undefined;
  bcc?: string | undefined;
  date?: string | undefined;
  subject?: string | undefined;
  messageId?: string | undefined;
}

const ADDRESS = /[^\s<>,;"'()[\]]+@[^\s<>,;"'()[\]]+/g;
/** The addresses in a header value, lower case, sorted: "Name <A@b>, c@d" -> ["a@b", "c@d"]. */
export function addressesOf(v: string | undefined): string[] {
  return [...new Set((v ?? "").toLowerCase().match(ADDRESS) ?? [])].sort();
}

const normBody = (s: string) => s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").trim();

export const MESSAGE_HASH_VERSION = 1;

/**
 * The identity of a message (D111): SHA-256 over its Message-ID, Date (to the second), the From,
 * To, Cc and Bcc addresses, Subject, body text, and its attachments (each by its SHA-256; an
 * attached email by its own identity). Two copies are the same message when all of these are
 * equal: the transport headers are left out, since they differ between two custodians' copies of
 * one message (Received lines, the mailbox's status headers), and a PST message has none of the
 * original bytes to compare. Message-ID alone is not enough: drafts and some exports have none,
 * clients reuse IDs, and two copies with one ID can differ (the sender's copy has the Bcc, a
 * gateway strips an attachment); calling those the same would hide evidence.
 */
export async function messageIdentity(p: Pick<ParsedEmailResult, "headers" | "blocks" | "attachments"> & { headers: MessageHeaders }, depth = 0): Promise<string> {
  const h = p.headers;
  const t = h.date ? Date.parse(h.date) : NaN;
  const body = p.blocks.filter((b) => b.section_path === "Email Body").map((b) => b.text).join("\n");
  const attachments: string[] = [];
  for (const a of p.attachments) {
    if (depth < 4 && (a.contentType === "message/rfc822" || a.filename.toLowerCase().endsWith(".eml"))) {
      try {
        attachments.push(`message:${await messageIdentity(await parseEml(a.content), depth + 1)}`);
        continue;
      } catch {
        // not readable as an email: compared by its bytes
      }
    }
    attachments.push(`sha256:${createHash("sha256").update(a.content).digest("hex")}`);
  }
  const canonical = JSON.stringify({
    v: MESSAGE_HASH_VERSION,
    message_id: (h.messageId ?? "").trim(),
    date: Number.isNaN(t) ? "" : new Date(Math.floor(t / 1000) * 1000).toISOString(),
    from: addressesOf(h.from),
    to: addressesOf(h.to),
    cc: addressesOf(h.cc),
    bcc: addressesOf(h.bcc),
    subject: (h.subject ?? "").replace(/\s+/g, " ").trim(),
    body: normBody(body),
    attachments: attachments.sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
