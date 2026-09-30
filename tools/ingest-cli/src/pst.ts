import { createHash } from "node:crypto";
import Long from "long";
import { PSTFile, type PSTAttachment, type PSTFolder, type PSTMessage } from "pst-extractor";
import { PSTNodeInputStream } from "pst-extractor/dist/PSTNodeInputStream.class.js";
import { PSTTableBC } from "pst-extractor/dist/PSTTableBC.class.js";
import { PSTUtil } from "pst-extractor/dist/PSTUtil.class.js";
import { attachedMessageFileName } from "./mailbox-paths.js";

/**
 * Outlook PST and OST files, read message by message (BIGDATA-3B, D109).
 *
 * Reader: pst-extractor 1.12.0 (MIT; a port of java-libpst; last release January 2026), patched
 * (patches/pst-extractor@1.12.0.patch, D110). It opens the file and reads the blocks it needs
 * through the file handle; it never loads the file. What it holds at once: the name-to-id map, the
 * contents table of the folder being read (its rows, not its messages) and the current message.
 * It reads ANSI and Unicode PSTs and the 4 KB-page format of Outlook 2013 and later (used by OSTs);
 * it refuses "high" (cyclic) encryption. OST files are read the same way; no real OST was
 * available to test with (they are made by Outlook syncing an Exchange or Microsoft 365 account).
 *
 * A PST has no per-message original bytes (a message is a set of properties), so each message is
 * rendered to an RFC 5322 .eml built from its properties (renderPstMessage): that rendering is the
 * message source's stored object, marked as a rendering in its metadata. The PST itself is stored
 * whole and never changed; the node id in the message's path finds the message in it.
 */

export class PstUnreadableError extends Error {
  constructor(message: string, readonly code: "encrypted" | "password" | "not-a-pst" | "corrupt") {
    super(message);
    this.name = "PstUnreadableError";
  }
}

const NID_MESSAGE_STORE = 0x21;
const PR_IPM_SUBTREE_ENTRYID = 0x35e0;
const PR_PST_PASSWORD = 0x67ff;
const NID_TYPE_SEARCH_FOLDER = 0x03;
const ATTACH_BY_VALUE = 1;
const ATTACH_EMBEDDED_MSG = 5;
const MAX_EMBED_DEPTH = 4;

export interface PstOpenInfo {
  storeName: string;
  fileType: "ansi" | "unicode" | "unicode-4k";
  passwordProtected: boolean;
}

/** The message store's table (node 0x21): its display name, IPM subtree and password. */
function storeTable(file: PSTFile) {
  const node = file.getDescriptorIndexNode(Long.fromNumber(NID_MESSAGE_STORE));
  return new PSTTableBC(new PSTNodeInputStream(file, file.getOffsetIndexNode(node.dataOffsetIndexIdentifier))).getItems();
}

/**
 * Opens a PST/OST for reading, or throws PstUnreadableError with the reason: not a PST, high
 * (cyclic) encryption, or damage that stops the file from opening. A password (PidTagPstPassword)
 * is only a check Outlook makes, not encryption: the case owner decided (BIGDATA-4, answer 1) that
 * such a mailbox is read, and `passwordProtected` says it had one, so the mailbox and every message
 * of it are marked. Nothing is ever cracked: high encryption stays unreadable.
 */
export function openPst(path: string): { file: PSTFile; info: PstOpenInfo } {
  let file: PSTFile;
  try {
    file = new PSTFile(path);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypted/i.test(msg)) throw new PstUnreadableError("high (cyclic) encryption: this reader cannot read it", "encrypted");
    if (/Invalid file header|Unrecognised PST File version/i.test(msg)) throw new PstUnreadableError(`not a PST or OST file (${msg.split("\n")[0]})`, "not-a-pst");
    throw new PstUnreadableError(`the file could not be opened: ${msg.split("\n")[0]}`, "corrupt");
  }
  try {
    const items = storeTable(file);
    const password = items.get(PR_PST_PASSWORD)?.entryValueReference ?? 0;
    const info: PstOpenInfo = {
      storeName: file.getMessageStore().displayName,
      fileType: file.pstFileType === PSTFile.PST_TYPE_ANSI ? "ansi" : file.pstFileType === PSTFile.PST_TYPE_2013_UNICODE ? "unicode-4k" : "unicode",
      passwordProtected: password !== 0,
    };
    return { file, info };
  } catch (err: unknown) {
    if (err instanceof PstUnreadableError) throw err;
    file.close();
    throw new PstUnreadableError(`the message store could not be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, "corrupt");
  }
}

export type PstEntry =
  | { kind: "message"; folder: string[]; nid: number; message: PSTMessage }
  | { kind: "error"; folder: string[]; nid: number | null; reason: string }
  | { kind: "folder-skipped"; folder: string[]; reason: string };

/** Errors pst-extractor (patched) recorded on a folder while listing its messages. */
export function childErrors(folder: PSTFolder): { index: number; nodeId: number | null; error: string }[] {
  const v: unknown = Reflect.get(folder, "childErrors");
  if (!Array.isArray(v)) return [];
  return v.map((e: unknown) => {
    const index = Number(Reflect.get(Object(e), "index"));
    const nodeId = Reflect.get(Object(e), "nodeId");
    return { index, nodeId: typeof nodeId === "number" ? nodeId : null, error: String(Reflect.get(Object(e), "error")) };
  });
}

/**
 * Every message of the file, folder by folder: a folder's messages (in its contents table's
 * order), then its sub-folders (in its hierarchy table's order). Folder paths start below the top
 * of the mailbox (Inbox/Projects/...); a folder outside it keeps its own name. Search folders hold
 * links to messages in other folders, so they are listed as skipped, not read. A message or a folder
 * that cannot be read is an "error" entry, and reading goes on with the next one.
 */
export function* walkPst(file: PSTFile): Generator<PstEntry> {
  const ipmNid = ipmSubtreeNid(file);
  const root = file.getRootFolder();

  function* walk(folder: PSTFolder, path: string[]): Generator<PstEntry> {
    const nid = folder.descriptorNodeId.toNumber();
    if ((nid & 0x1f) === NID_TYPE_SEARCH_FOLDER) {
      yield { kind: "folder-skipped", folder: path, reason: "search folder: its items are links to messages in other folders" };
      return;
    }
    if (folder.contentCount > 0) {
      let seen = 0;
      for (;;) {
        let child: unknown;
        try {
          child = folder.getNextChild();
        } catch (err: unknown) {
          yield { kind: "error", folder: path, nid: null, reason: `the folder's messages could not be listed after ${seen}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
          break;
        }
        const errs = childErrors(folder);
        for (; seen < errs.length; seen++) {
          const e = errs[seen]!;
          yield { kind: "error", folder: path, nid: e.nodeId, reason: `message ${e.index + 1} of ${folder.contentCount} could not be read: ${e.error.split("\n")[0]}` };
        }
        if (child === null || child === undefined) break;
        if (isPstMessage(child)) yield { kind: "message", folder: path, nid: child.descriptorNodeId.toNumber(), message: child };
      }
    }
    let subs: PSTFolder[] = [];
    try {
      subs = folder.hasSubfolders ? folder.getSubFolders() : [];
    } catch (err: unknown) {
      yield { kind: "error", folder: path, nid: null, reason: `the sub-folders could not be listed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
    }
    for (const sub of subs) {
      const subNid = sub.descriptorNodeId.toNumber();
      yield* walk(sub, subNid === ipmNid ? [] : [...path, sub.displayName]);
    }
  }
  yield* walk(root, []);
}

/**
 * The node id of the top of the mailbox (the IPM subtree): folder paths start below it (Inbox/...),
 * so the folder itself has no name in a path. -1 when the store does not record one.
 */
export function ipmSubtreeNid(file: PSTFile): number {
  try {
    const entryId = storeTable(file).get(PR_IPM_SUBTREE_ENTRYID)?.data;
    if (entryId && entryId.length >= 24) return entryId.readUInt32LE(20);
  } catch {
    // No IPM subtree recorded: every folder keeps its own name.
  }
  return -1;
}

export function isPstMessage(o: unknown): o is PSTMessage {
  return typeof o === "object" && o !== null && "subject" in o && "numberOfAttachments" in o && "descriptorNodeId" in o;
}

export function isPstFolder(o: unknown): o is PSTFolder {
  return typeof o === "object" && o !== null && "contentCount" in o && "getNextChild" in o && "moveChildCursorTo" in o && "descriptorNodeId" in o;
}

/** A PST message by node id (for `pnpm ingest:include`), or null. */
export function pstMessageByNid(file: PSTFile, nid: number): PSTMessage | null {
  const o: unknown = PSTUtil.detectAndLoadPSTObject(file, Long.fromNumber(nid));
  return isPstMessage(o) ? o : null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const clean = (s: string) => s.replace(/[\r\n\0]+/g, " ").trim();
/** An RFC 2047 encoded word when the text is not plain ASCII. */
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
const rfcDate = (d: Date) =>
  `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;

function mailbox(name: string, address: string): string {
  const n = clean(name);
  const a = clean(address);
  if (!a) return n ? word(n) : "";
  if (!n || n === a) return `<${a}>`;
  return /^[\x20-\x7e]*$/.test(n) && !/[",;<>@()[\]:\\]/.test(n) ? `${n} <${a}>` : /^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/["\\]/g, "\\$&")}" <${a}>` : `${word(n)} <${a}>`;
}

/** "Name <a@b>; Other <c@d>" or "Name; Other" (the display strings of a message without a recipient table). */
function fromDisplay(s: string): string[] {
  return s.split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(x);
    return m ? mailbox(m[1]!, m[2]!) : word(clean(x));
  });
}

function recipients(m: PSTMessage): { to: string[]; cc: string[]; bcc: string[] } {
  const out = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  let n: number;
  try {
    n = m.numberOfRecipients;
  } catch {
    n = 0; // no readable recipient table: the display strings below
  }
  for (let i = 0; i < n; i++) {
    const r = m.getRecipient(i);
    if (!r) continue;
    const a = mailbox(r.displayName, r.smtpAddress || r.emailAddress);
    if (r.recipientType === 2) out.cc.push(a);
    else if (r.recipientType === 3) out.bcc.push(a);
    else out.to.push(a);
  }
  if (n === 0) {
    out.to = fromDisplay(m.displayTo ?? "");
    out.cc = fromDisplay(m.displayCC ?? "");
    out.bcc = fromDisplay(m.displayBCC ?? "");
  }
  return out;
}

export interface RenderNotes {
  /** Attachments whose content is not in the rendering, and why (a reference, an OLE object, too large ...). */
  attachmentsNotRead: { name: string; reason: string }[];
}

function attachmentName(a: PSTAttachment, i: number): string {
  return clean(a.longFilename || a.filename || a.displayName || "") || `attachment-${i + 1}`;
}

/**
 * The file name the message's attachment table gives attachment `i` (its long file name, file name
 * or display name columns), for an attachment whose own properties cannot be read (a damaged
 * block): the name then still says what is missing. pst-extractor keeps the table private, so it
 * is read through Reflect, checked at each step; null when the table has no readable name.
 */
function attachmentNameFromTable(m: PSTMessage, i: number): string | null {
  try {
    const table: unknown = Reflect.get(m, "attachmentTable");
    const getItems: unknown = table ? Reflect.get(Object(table), "getItems") : undefined;
    if (typeof getItems !== "function") return null;
    const rows: unknown = Reflect.apply(getItems, table, []);
    const row: unknown = Array.isArray(rows) ? rows[i] : undefined;
    if (!(row instanceof Map)) return null;
    for (const id of [0x3707, 0x3704, 0x3001]) {
      const item: unknown = row.get(id);
      const getString: unknown = item ? Reflect.get(Object(item), "getStringValue") : undefined;
      if (typeof getString !== "function") continue;
      const v: unknown = Reflect.apply(getString, item, []);
      if (typeof v === "string" && clean(v)) return clean(v);
    }
  } catch {
    // the table itself is damaged too: no name
  }
  return null;
}

function dispositionName(name: string): string {
  return /^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;
}

function wrap76(b64: string, eol: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(eol);
}

/**
 * The message as RFC 5322 bytes (CRLF), built from its properties: From (the sender), To, Cc and
 * Bcc (the recipient table; the display strings when a message has none, as embedded messages
 * often do), Date (the client submit time, else the delivery time, else the creation time),
 * Subject, Message-ID, the plain-text body (else the HTML body), and every attachment: a file as
 * a base64 part, an embedded message as a message/rfc822 part rendered the same way. The same
 * message always renders to the same bytes (the MIME boundary comes from the node id).
 * `X-Casefile-Rendering` says that these are not the message's original bytes.
 */
export function renderPstMessage(m: PSTMessage, notes: RenderNotes, opts: { maxAttachmentBytes: number; depth?: number }): Buffer {
  const eol = "\r\n";
  const depth = opts.depth ?? 0;
  const rc = recipients(m);
  const date = m.clientSubmitTime ?? m.messageDeliveryTime ?? m.creationTime;
  const head: string[] = [];
  const from = mailbox(m.senderName ?? "", m.senderEmailAddress ?? "") || mailbox(m.sentRepresentingName ?? "", m.sentRepresentingEmailAddress ?? "");
  if (from) head.push(`From: ${from}`);
  if (rc.to.length) head.push(`To: ${rc.to.join(", ")}`);
  if (rc.cc.length) head.push(`Cc: ${rc.cc.join(", ")}`);
  if (rc.bcc.length) head.push(`Bcc: ${rc.bcc.join(", ")}`);
  if (date) head.push(`Date: ${rfcDate(date)}`);
  head.push(`Subject: ${word(clean(m.subject ?? ""))}`);
  const mid = clean(m.internetMessageId ?? "");
  if (mid) head.push(`Message-ID: ${mid}`);
  head.push("X-Casefile-Rendering: rendered from the properties of a PST/OST message (not the original bytes)", "MIME-Version: 1.0");

  const plain = (m.body ?? "").replace(/\r?\n/g, eol);
  const html = plain ? "" : (m.bodyHTML ?? "");
  const bodyPart = html
    ? ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(html, "utf8").toString("base64"), eol)]
    : ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(plain, "utf8").toString("base64"), eol)];

  const parts: string[][] = [];
  let count = 0;
  try {
    count = m.numberOfAttachments;
  } catch (err: unknown) {
    notes.attachmentsNotRead.push({ name: "(the attachment table)", reason: `could not be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
  }
  for (let i = 0; i < count; i++) {
    let a: PSTAttachment;
    try {
      a = m.getAttachment(i);
    } catch (err: unknown) {
      notes.attachmentsNotRead.push({ name: attachmentNameFromTable(m, i) ?? `attachment ${i + 1}`, reason: `could not be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
      continue;
    }
    const name = attachmentName(a, i);
    try {
      if (a.attachMethod === ATTACH_EMBEDDED_MSG) {
        const inner = depth < MAX_EMBED_DEPTH ? a.embeddedPSTMessage : null;
        if (!inner) {
          notes.attachmentsNotRead.push({ name, reason: depth < MAX_EMBED_DEPTH ? "embedded message could not be read" : `embedded more than ${MAX_EMBED_DEPTH} levels deep` });
          continue;
        }
        const innerName = attachedMessageFileName(inner.subject ?? name);
        parts.push([`Content-Type: message/rfc822; name="${innerName.replace(/"/g, "")}"`, `Content-Disposition: attachment; ${dispositionName(innerName)}`, "", renderPstMessage(inner, notes, { ...opts, depth: depth + 1 }).toString("utf8")]);
        continue;
      }
      if (a.attachMethod !== ATTACH_BY_VALUE) {
        notes.attachmentsNotRead.push({ name, reason: `attach method ${a.attachMethod} (a reference or an OLE object): no file content in the PST` });
        continue;
      }
      const size = a.filesize;
      if (size > opts.maxAttachmentBytes) {
        notes.attachmentsNotRead.push({ name, reason: `too large to read in this version (${size.toLocaleString("en-US")} bytes)` });
        continue;
      }
      const stream = a.fileInputStream;
      const data = Buffer.alloc(size);
      if (stream && size > 0) stream.readCompletely(data);
      const type = clean(a.mimeTag || "") || "application/octet-stream";
      parts.push([`Content-Type: ${type}; name="${name.replace(/"/g, "")}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; ${dispositionName(name)}`, "", wrap76(data.toString("base64"), eol)]);
    } catch (err: unknown) {
      notes.attachmentsNotRead.push({ name, reason: `could not be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
    }
  }
  if (parts.length === 0) return Buffer.from([...head, ...bodyPart, ""].join(eol), "utf8");
  const boundary = `=_casefile_${createHash("sha1").update(`${m.descriptorNodeId.toString()}:${depth}:${m.subject}`).digest("hex").slice(0, 24)}`;
  const out = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...bodyPart];
  for (const p of parts) out.push(`--${boundary}`, ...p);
  out.push(`--${boundary}--`, "");
  return Buffer.from(out.join(eol), "utf8");
}
