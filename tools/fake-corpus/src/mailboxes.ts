import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Rng } from "./prng.js";
import { makeCompany, makePerson, paragraph, title, formatDate, makeDate, type Person } from "./words.js";
import { docx, xlsx, textPdf, zipOf, type Attachment } from "./formats.js";
import { photo } from "./raster.js";
import { MARKER_FILE, isInsideRepo, markerFor } from "./marker.js";
import { writePst, type PstMessageSpec, type PstRecipient } from "./pst-writer.js";
import { messagePath, mboxLocator, pstLocator, attachedMessageFileName } from "../../ingest-cli/src/mailbox-paths.js";

/**
 * Fake mailboxes (BIGDATA-3B): MBOX files and Outlook PST files made of invented messages, with a
 * manifest of every mailbox, message and attachment, and of which messages are copies of which.
 *
 *   pnpm fake-corpus --kind mailboxes [--seed 42]        the standard set (MAILBOX_SET below)
 *   pnpm fake-corpus --kind mbox --size 1GB [--seed 42]  one MBOX of about that size
 *   pnpm fake-corpus --kind pst --size 1GB [--seed 42]   one PST of about that size (Windows only)
 *
 * The folder layout: <out>/corpus/... (the mailboxes), <out>/fake-mailbox-manifest.csv,
 * <out>/fake-mailbox-summary.json, <out>/.casefile-fake-corpus (marker), <out>/work/ (the PST
 * writer's input specs and node maps, kept). The regular corpus (`--size` without `--kind`) is
 * unchanged: same seed, same bytes.
 *
 * Ground truth for the ingest's checks, per message copy:
 *   - group: copies of one message share a group (same From, To, Cc, Bcc, Date, Subject,
 *     Message-ID, body and attachments). Only the transport headers differ between copies
 *     (Received, Status, the mailbox that holds them), as between two custodians' mailboxes.
 *     A group of n copies should give 1 indexed message and n-1 exact duplicates.
 *   - near_duplicate_of: a message sent again (new Message-ID and date, same subject and text).
 *   - same_message_id_as: a different message that carries the same Message-ID (why Message-ID
 *     alone cannot decide a duplicate): both must be indexed.
 * MBOX bytes are deterministic for a seed. PST bytes are not (the PST library writes random GUIDs
 * and the current time), but their folders, messages and attachments are.
 */

export const MAILBOX_MANIFEST_FILE = "fake-mailbox-manifest.csv";
export const MAILBOX_SUMMARY_FILE = "fake-mailbox-summary.json";

export type MailboxKind = "mailboxes" | "mbox" | "pst";

export interface MailboxOptions {
  kind: MailboxKind;
  seed: number;
  outDir: string;
  /** For --kind mbox / pst: the size to reach. */
  sizeBytes?: number;
  log?: (s: string) => void;
}

interface Embedded {
  subject: string;
  body: string;
  from: Person;
  to: Person[];
  date: Date;
  messageId: string;
}

interface Msg {
  key: string;
  group: string;
  from: Person;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  date: Date;
  subject: string;
  messageId: string | null;
  body: string;
  atts: Attachment[];
  emb: Embedded[];
  nearOf?: string;
  sameIdAs?: string;
}

export interface MailboxManifestRow {
  path: string;
  kind: "mailbox" | "message" | "attachment" | "attached_message" | "archive_entry";
  mailbox: string;
  folder: string;
  key: string;
  group: string;
  message_id: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: string;
  subject: string;
  bytes: number;
  sha256: string;
  near_duplicate_of: string;
  same_message_id_as: string;
  container: string;
  note: string;
}

const COLUMNS: (keyof MailboxManifestRow)[] = [
  "path", "kind", "mailbox", "folder", "key", "group", "message_id", "from", "to", "cc", "bcc", "date", "subject",
  "bytes", "sha256", "near_duplicate_of", "same_message_id_as", "container", "note",
];
const cell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const addr = (p: Person) => `${p.first} ${p.last} <${p.email}>`;
const addrs = (ps: Person[]) => ps.map(addr).join(", ");
const rcpt = (p: Person): PstRecipient => ({ n: `${p.first} ${p.last}`, e: p.email });
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
/** RFC 5322 date, UTC. */
const rfcDate = (d: Date) => `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
/** The asctime date of an mbox "From " line. */
const asctime = (d: Date) => `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;

/** Folders of the fake PST, with a '/' and a '#' in two names (the path encoding must survive them). */
const PST_FOLDERS: string[][] = [
  ["Inbox"],
  ["Inbox", "Projects"],
  ["Inbox", "Projects", "Harbour Lease"],
  ["Inbox", "Q1/Q2 Reports"],
  ["Inbox", "Case #12"],
  ["Sent Items"],
  ["Archive", "2019"],
];

class Factory {
  readonly people: Person[];
  private seq = 0;
  private groupSeq = 0;
  constructor(private rng: Rng, readonly marker: string) {
    const companies = Array.from({ length: 10 }, () => makeCompany(rng));
    this.people = Array.from({ length: 40 }, () => makePerson(rng, rng.pick(companies)));
  }

  private id(from: Person): string {
    return `<${this.rng.u32().toString(16)}.${this.seq++}.mbx@${from.company.domain}>`;
  }

  async attachment(r: Rng, big: boolean): Promise<Attachment> {
    switch (r.int(0, 4)) {
      case 0: {
        const p = await textPdf(r, this.people, big ? r.int(4, 30) : r.int(1, 3), this.marker);
        return { filename: `${title(r).replace(/[^A-Za-z0-9 -]/g, "")}.pdf`, contentType: "application/pdf", data: p.bytes };
      }
      case 1:
        return { filename: `${title(r).replace(/[^A-Za-z0-9 -]/g, "")} v${r.int(1, 9)}.docx`, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: docx(Array.from({ length: big ? r.int(20, 120) : r.int(2, 6) }, () => paragraph(r, this.people)), title(r), this.marker) };
      case 2: {
        const rows: (string | number)[][] = [["Date", "Reference", "Counterparty", "Amount"]];
        for (let i = big ? r.int(200, 2000) : r.int(10, 60); i > 0; i--) rows.push([formatDate(makeDate(r)), `INV-${r.int(10000, 99999)}`, r.pick(this.people).company.name, r.int(100, 950000)]);
        return { filename: `ledger-${r.int(100, 999)}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: xlsx(rows, this.marker) };
      }
      case 3:
        return { filename: `IMG_${r.int(1000, 9999)}.png`, contentType: "image/png", data: photo(r, big ? r.int(800, 1600) : r.int(200, 500), big ? r.int(600, 1200) : r.int(150, 400), this.marker) };
      default: {
        const entries = [
          { name: `notes/${title(r).replace(/[^A-Za-z0-9 -]/g, "")}.docx`, data: docx([paragraph(r, this.people), paragraph(r, this.people)], title(r), this.marker) },
          { name: `ledger-${r.int(100, 999)}.xlsx`, data: xlsx([["Item", "Amount"], [title(r), r.int(10, 9999)]], this.marker) },
        ];
        return { filename: `bundle-${r.int(100, 999)}.zip`, contentType: "application/zip", data: zipOf(entries, this.marker) };
      }
    }
  }

  /** A new message (its own group). `big`: larger attachments, for the size-targeted mailboxes. */
  async message(big = false): Promise<Msg> {
    const r = this.rng.fork();
    const from = r.pick(this.people);
    const to = [r.pick(this.people), ...(r.chance(0.3) ? [r.pick(this.people)] : [])];
    const cc = r.chance(0.35) ? [r.pick(this.people)] : [];
    const bcc = r.chance(0.12) ? [r.pick(this.people)] : [];
    const paras = Array.from({ length: r.int(2, 8) }, () => paragraph(r, this.people));
    // Some bodies have a line that starts with "From ": MBOX must escape it (">From ") and read it back.
    if (r.chance(0.1)) paras.splice(1, 0, `From the minutes of ${formatDate(makeDate(r))}: ${paragraph(r, this.people, 2)}`);
    const atts: Attachment[] = [];
    if (r.chance(big ? 0.6 : 0.4)) for (let i = r.int(1, 3); i > 0; i--) atts.push(await this.attachment(r, big && r.chance(0.5)));
    const emb: Embedded[] = [];
    if (r.chance(0.08)) {
      const ef = r.pick(this.people);
      emb.push({ subject: `FW: ${title(r)}`, body: [paragraph(r, this.people), paragraph(r, this.people)].join("\n\n"), from: ef, to: [r.pick(this.people)], date: makeDate(r), messageId: this.id(ef) });
    }
    const key = `m${this.seq}`;
    return {
      key, group: `g${this.groupSeq++}`, from, to, cc, bcc, date: makeDate(r),
      subject: `${r.chance(0.3) ? "RE: " : ""}${title(r)} - ${formatDate(makeDate(r))}`,
      messageId: this.id(from), body: paras.join("\n\n"), atts, emb,
    };
  }

  /** Another copy of `m` (same group, so an exact duplicate by content). */
  copy(m: Msg): Msg {
    return { ...m, key: `m${this.seq++}` };
  }

  /** `m` sent again: new Message-ID and date, same subject and text: a near-duplicate. */
  resent(m: Msg): Msg {
    const r = this.rng.fork();
    return { ...m, key: `m${this.seq++}`, group: `g${this.groupSeq++}`, messageId: this.id(m.from), date: new Date(m.date.getTime() + r.int(3600, 30 * 86400) * 1000), atts: [], emb: [], nearOf: m.key };
  }

  /** A different message that reuses `m`'s Message-ID (it happens: broken clients, forged mail). */
  sameIdDifferentContent(m: Msg): Msg {
    const r = this.rng.fork();
    return { ...m, key: `m${this.seq++}`, group: `g${this.groupSeq++}`, body: `${paragraph(r, this.people)}\n\n${m.body}`, atts: [], emb: [], sameIdAs: m.key };
  }

  /** A message with no Message-ID (an unsent draft). */
  async draft(): Promise<Msg> {
    const m = await this.message();
    return { ...m, messageId: null, subject: `DRAFT ${m.subject}` };
  }
}

/** The message as RFC 5322 bytes. `copyOf` names the mailbox copy: only transport headers depend on it. */
function renderRfc822(m: Msg, mailboxName: string, marker: string, eol: string): Buffer {
  const received = new Date(m.date.getTime() + 47_000);
  const head = [
    `Return-Path: <${m.from.email}>`,
    `Received: from mail.${m.from.company.domain} by mx.${mailboxName.replace(/[^a-z0-9]/gi, "").toLowerCase()}.example.test; ${rfcDate(received)}`,
    `From: ${addr(m.from)}`,
    `To: ${addrs(m.to)}`,
    ...(m.cc.length ? [`Cc: ${addrs(m.cc)}`] : []),
    ...(m.bcc.length ? [`Bcc: ${addrs(m.bcc)}`] : []),
    `Subject: ${m.subject}`,
    `Date: ${rfcDate(m.date)}`,
    ...(m.messageId ? [`Message-ID: ${m.messageId}`] : []),
    `X-Casefile-Fake-Corpus: ${marker}`,
    `X-Casefile-Fake-Mailbox-Copy: ${mailboxName}`,
    "MIME-Version: 1.0",
  ];
  const body = m.body.split("\n").join(eol);
  if (m.atts.length === 0 && m.emb.length === 0) {
    return Buffer.from([...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body, ""].join(eol));
  }
  const boundary = `=_mbx_${createHash("sha1").update(m.group).digest("hex").slice(0, 20)}`;
  const parts = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body];
  for (const a of m.atts) {
    parts.push(`--${boundary}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${a.filename}"`, "");
    const b64 = a.data.toString("base64");
    for (let i = 0; i < b64.length; i += 76) parts.push(b64.slice(i, i + 76));
  }
  for (const e of m.emb) {
    const name = attachedMessageFileName(e.subject);
    parts.push(`--${boundary}`, `Content-Type: message/rfc822; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "", renderEmbedded(e, marker, eol));
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join(eol));
}

function renderEmbedded(e: Embedded, marker: string, eol: string): string {
  return [
    `From: ${addr(e.from)}`, `To: ${addrs(e.to)}`, `Subject: ${e.subject}`, `Date: ${rfcDate(e.date)}`, `Message-ID: ${e.messageId}`,
    `X-Casefile-Fake-Corpus: ${marker}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "",
    e.body.split("\n").join(eol), "",
  ].join(eol);
}

/** mboxrd: every line that starts with "From " (after any number of '>') gets one more '>'. */
function mboxEscape(bytes: Buffer): Buffer {
  const s = bytes.toString("latin1");
  return Buffer.from(s.replace(/(^|\n)(>*From )/g, "$1>$2"), "latin1");
}

class ManifestWriter {
  private fd: number;
  rows = 0;
  constructor(path: string) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, COLUMNS.join(",") + "\n");
  }
  write(r: Partial<MailboxManifestRow> & Pick<MailboxManifestRow, "path" | "kind" | "mailbox">): void {
    const full: MailboxManifestRow = {
      folder: "", key: "", group: "", message_id: "", from: "", to: "", cc: "", bcc: "", date: "", subject: "", bytes: 0, sha256: "",
      near_duplicate_of: "", same_message_id_as: "", container: "", note: "", ...r,
    };
    writeSync(this.fd, COLUMNS.map((c) => cell(full[c])).join(",") + "\n");
    this.rows++;
  }
  close(): void {
    closeSync(this.fd);
  }
}

interface Totals {
  mailboxes: number;
  messages: number;
  attachments: number;
  bytes: number;
  byMailbox: Record<string, { messages: number; bytes: number; note: string }>;
}

/** What the manifest needs of a message copy: no attachment bytes, so a PST's messages can wait for its node ids. */
interface LiteMsg extends Omit<Msg, "atts"> {
  atts: { filename: string; bytes: number; sha256: string }[];
}
const lite = (m: Msg): LiteMsg => ({ ...m, atts: m.atts.map((a) => ({ filename: a.filename, bytes: a.data.length, sha256: sha(a.data) })) });

/** Manifest rows of one message copy: the message, its attachments, its attached messages. */
function messageRows(mf: ManifestWriter, m: LiteMsg, mailboxRel: string, folder: string[], path: string, keyToPath: Map<string, string>, totals: Totals, note = ""): void {
  keyToPath.set(m.key, path);
  mf.write({
    path, kind: "message", mailbox: mailboxRel, folder: folder.join("/"), key: m.key, group: m.group, message_id: m.messageId ?? "",
    from: m.from.email, to: m.to.map((p) => p.email).join(" "), cc: m.cc.map((p) => p.email).join(" "), bcc: m.bcc.map((p) => p.email).join(" "),
    date: m.date.toISOString(), subject: m.subject, near_duplicate_of: m.nearOf ? keyToPath.get(m.nearOf) ?? m.nearOf : "",
    same_message_id_as: m.sameIdAs ? keyToPath.get(m.sameIdAs) ?? m.sameIdAs : "", note,
  });
  totals.messages++;
  for (const a of m.atts) {
    mf.write({ path: `${path}#attachment:${a.filename}`, kind: "attachment", mailbox: mailboxRel, key: m.key, group: m.group, bytes: a.bytes, sha256: a.sha256, container: path, note });
    totals.attachments++;
  }
  for (const e of m.emb) {
    mf.write({ path: `${path}#attachment:${attachedMessageFileName(e.subject)}`, kind: "attached_message", mailbox: mailboxRel, key: m.key, group: m.group, message_id: e.messageId, subject: e.subject, container: path, note });
    totals.attachments++;
  }
}

/** Writes one MBOX file from the messages, in order, and their manifest rows; returns each message's offset and the file size. */
function writeMbox(abs: string, rel: string, msgs: Msg[], mf: ManifestWriter | null, marker: string, eol: string, keyToPath: Map<string, string>, totals: Totals): { offsets: number[]; size: number } {
  const fd = openSync(abs, "w");
  let offset = 0;
  const offsets: number[] = [];
  const name = rel.split("/").pop()!;
  for (const m of msgs) {
    const fromLine = Buffer.from(`From ${m.from.email} ${asctime(m.date)}${eol}`);
    const body = mboxEscape(renderRfc822(m, name, marker, eol));
    offsets.push(offset);
    if (mf) messageRows(mf, lite(m), rel, [], messagePath(rel, [], mboxLocator(offset)), keyToPath, totals);
    writeSync(fd, fromLine);
    writeSync(fd, body);
    writeSync(fd, Buffer.from(eol));
    offset += fromLine.length + body.length + Buffer.byteLength(eol);
  }
  closeSync(fd);
  return { offsets, size: offset };
}

/** The PST writer's spec line for one message copy. */
function pstSpec(m: Msg, folder: string[], marker: string, mailboxName: string): PstMessageSpec {
  const headers = [
    `Received: from mail.${m.from.company.domain} by mx.${mailboxName.replace(/[^a-z0-9]/gi, "").toLowerCase()}.example.test; ${rfcDate(new Date(m.date.getTime() + 47_000))}`,
    `X-Casefile-Fake-Corpus: ${marker}`,
    "",
  ].join("\r\n");
  return {
    t: "msg", key: m.key, folder, subject: m.subject, body: m.body.split("\n").join("\r\n"),
    from: rcpt(m.from), to: m.to.map(rcpt), cc: m.cc.map(rcpt), bcc: m.bcc.map(rcpt), date: m.date.toISOString(),
    messageId: m.messageId, headers,
    atts: m.atts.map((a) => ({ name: a.filename, mime: a.contentType, b64: a.data.toString("base64") })),
    emb: m.emb.map((e) => ({ subject: e.subject, body: e.body.split("\n").join("\r\n"), from: rcpt(e.from), to: e.to.map(rcpt), date: e.date.toISOString(), messageId: e.messageId })),
  };
}

/**
 * One PST being written: each message's spec line goes to <out>/work as it is added (attachment
 * bytes are not kept), then finish() runs PstWriter and writes the manifest rows with the node ids
 * the writer reports.
 */
class PstBuilder {
  private fd: number;
  private placed: { m: LiteMsg; folder: string[] }[] = [];
  readonly specPath: string;
  constructor(outDir: string, private rel: string, private marker: string, passwordCrc = 0) {
    const work = join(outDir, "work");
    mkdirSync(work, { recursive: true });
    this.specPath = join(work, `${rel.replace(/[\\/]/g, "__")}.spec.jsonl`);
    this.fd = openSync(this.specPath, "w");
    writeSync(this.fd, JSON.stringify({ t: "store", name: `Fake mailbox ${rel} (${marker})`, passwordCrc }) + "\n");
  }
  add(m: Msg, folder: string[]): void {
    writeSync(this.fd, JSON.stringify(pstSpec(m, folder, this.marker, this.rel.split("/").pop()!)) + "\n");
    this.placed.push({ m: lite(m), folder });
  }
  get count(): number {
    return this.placed.length;
  }
  /** Writes the PST at `abs`; manifest rows name it `manifestRel` (they can differ: a PST that is damaged afterwards). */
  async finish(abs: string, mf: ManifestWriter, keyToPath: Map<string, string>, totals: Totals, log?: (s: string) => void, note = ""): Promise<number> {
    closeSync(this.fd);
    const nodes = await writePst(this.specPath, abs, log);
    for (const { m, folder } of this.placed) {
      const n = nodes.get(m.key);
      if (!n) throw new Error(`the PST writer reported no node for message ${m.key}`);
      messageRows(mf, m, this.rel, folder, messagePath(this.rel, folder, pstLocator(n.nid)), keyToPath, totals, note);
    }
    return statSync(abs).size;
  }
}

function prepareOut(outDir: string, seed: number): { corpus: string; marker: string } {
  if (isInsideRepo(outDir)) throw new Error(`Refusing to write fake mailboxes inside the repository (${outDir}). Choose a folder outside it.`);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`${outDir} already exists and is not empty. Nothing was written; choose a new folder.`);
  const corpus = join(outDir, "corpus");
  mkdirSync(corpus, { recursive: true });
  const marker = markerFor(seed);
  writeFileSync(join(outDir, MARKER_FILE), `${marker}\nfake mailboxes\n`);
  return { corpus, marker };
}

export interface MailboxSummary {
  kind: MailboxKind;
  seed: number;
  mailboxes: number;
  messages: number;
  attachments: number;
  bytes: number;
  manifest_rows: number;
  by_mailbox: Totals["byMailbox"];
  elapsed_ms: number;
  peak_rss_bytes: number;
}

export async function generateMailboxes(opts: MailboxOptions): Promise<MailboxSummary> {
  const started = Date.now();
  const { corpus, marker } = prepareOut(opts.outDir, opts.seed);
  const rng = new Rng(opts.seed * 7919 + 3);
  const f = new Factory(rng, marker);
  const mf = new ManifestWriter(join(opts.outDir, MAILBOX_MANIFEST_FILE));
  const totals: Totals = { mailboxes: 0, messages: 0, attachments: 0, bytes: 0, byMailbox: {} };
  const keyToPath = new Map<string, string>();
  let peak = process.memoryUsage().rss;
  const note = (rel: string, bytes: number, messages: number, n: string, sha256: string) => {
    totals.mailboxes++;
    totals.bytes += bytes;
    totals.byMailbox[rel] = { messages, bytes, note: n };
    mf.write({ path: rel, kind: "mailbox", mailbox: rel, bytes, sha256, note: n });
    peak = Math.max(peak, process.memoryUsage().rss);
  };
  const dir = (rel: string) => {
    mkdirSync(join(corpus, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    return join(corpus, rel);
  };
  const shaOfFile = async (abs: string) => {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
    return h.digest("hex");
  };
  const log = opts.log;
  /** Keeps only the manifest paths later rows can still refer to (the recent messages'). */
  const prune = (recent: Msg[]) => {
    const keep = new Map(recent.map((r) => [r.key, keyToPath.get(r.key) ?? ""] as const));
    keyToPath.clear();
    for (const [k, v] of keep) keyToPath.set(k, v);
  };
  /** A new message, or (3%) a copy of a recent one, or (2%) a recent one sent again. */
  const nextBig = async (recent: Msg[]): Promise<Msg> => {
    const roll = rng.next();
    const m = recent.length > 0 && roll < 0.03 ? f.copy(rng.pick(recent)) : recent.length > 0 && roll < 0.05 ? f.resent(rng.pick(recent)) : await f.message(true);
    recent.push(m);
    if (recent.length > 50) recent.shift();
    return m;
  };
  /** Streams messages into an MBOX until it reaches `target` bytes; returns its size and message count. */
  const bigMbox = async (abs: string, rel: string, target: number, make: (n: number) => Promise<Msg>): Promise<{ size: number; count: number }> => {
    const fd = openSync(abs, "w");
    const name = rel.split("/").pop()!;
    let offset = 0;
    let n = 0;
    while (offset < target) {
      const m = await make(n);
      const fromLine = Buffer.from(`From ${m.from.email} ${asctime(m.date)}\n`);
      const body = mboxEscape(renderRfc822(m, name, marker, "\n"));
      messageRows(mf, lite(m), rel, [], messagePath(rel, [], mboxLocator(offset)), keyToPath, totals);
      writeSync(fd, fromLine);
      writeSync(fd, body);
      writeSync(fd, Buffer.from("\n"));
      offset += fromLine.length + body.length + 1;
      if (++n % 2000 === 0) {
        log?.(`  ${name}: ${(offset / 1024 ** 2).toFixed(0)} MB, ${n} messages`);
        peak = Math.max(peak, process.memoryUsage().rss);
      }
    }
    closeSync(fd);
    return { size: offset, count: n };
  };

  if (opts.kind === "mbox" || opts.kind === "pst") {
    const target = opts.sizeBytes ?? 1024 ** 3;
    const rel = opts.kind === "mbox" ? "Big/big.mbox" : "Big/big.pst";
    const abs = dir(rel);
    const recent: Msg[] = [];
    if (opts.kind === "mbox") {
      const { size, count } = await bigMbox(abs, rel, target, async (n) => {
        if (n % 2000 === 0) prune(recent);
        return nextBig(recent);
      });
      note(rel, size, count, `one MBOX of ${(size / 1024 ** 2).toFixed(0)} MB`, await shaOfFile(abs));
    } else {
      const pst = new PstBuilder(opts.outDir, rel, marker);
      let approx = 0;
      while (approx < target) {
        const n = pst.count;
        if (n % 2000 === 0) prune(recent);
        const m = await nextBig(recent);
        // At most 1,500 messages per folder: Archive/<year>/Batch <nnn>.
        pst.add(m, ["Archive", String(2019 + (n % 5)), `Batch ${String(Math.floor(n / 1500)).padStart(3, "0")}`]);
        approx += m.body.length + m.atts.reduce((s, a) => s + a.data.length, 0) + 600;
        if ((n + 1) % 2000 === 0) {
          log?.(`  big.pst spec: about ${(approx / 1024 ** 2).toFixed(0)} MB of messages, ${n + 1} messages`);
          peak = Math.max(peak, process.memoryUsage().rss);
        }
      }
      const count = pst.count;
      const bytes = await pst.finish(abs, mf, keyToPath, totals, log);
      note(rel, bytes, count, `one PST of ${(bytes / 1024 ** 2).toFixed(0)} MB`, await shaOfFile(abs));
    }
  } else {
    // ── The standard set ─────────────────────────────────────────────────────
    const alice: Msg[] = [];
    for (let i = 0; i < 300; i++) alice.push(await f.message());
    // Bob: new messages, 60 copies of Alice's (same message, other custodian), 20 messages twice,
    // 15 resent (near-duplicates), 2 that reuse a Message-ID with other content.
    const bob: Msg[] = [];
    for (let i = 0; i < 380; i++) bob.push(await f.message());
    for (let i = 0; i < 60; i++) bob.splice(rng.int(0, bob.length), 0, f.copy(alice[i * 5]!));
    for (let i = 0; i < 20; i++) bob.splice(rng.int(0, bob.length), 0, f.copy(bob[rng.int(0, bob.length - 1)]!));
    for (let i = 0; i < 15; i++) bob.push(f.resent(bob[i * 7]!));
    for (let i = 0; i < 2; i++) bob.push(f.sameIdDifferentContent(bob[i * 11 + 3]!));

    const aliceRel = "Custodian A/alice.mbox";
    const aliceOut = writeMbox(dir(aliceRel), aliceRel, alice, mf, marker, "\r\n", keyToPath, totals);
    note(aliceRel, aliceOut.size, alice.length, "MBOX, CRLF line ends", await shaOfFile(join(corpus, aliceRel)));
    const bobRel = "Custodian B/bob.mbox";
    const bobOut = writeMbox(dir(bobRel), bobRel, bob, mf, marker, "\n", keyToPath, totals);
    note(bobRel, bobOut.size, bob.length, "MBOX, LF line ends; copies of alice.mbox messages, messages twice, resent, a reused Message-ID", await shaOfFile(join(corpus, bobRel)));

    // Carol's PST: a folder tree, Bcc, attached messages, 40 of Alice's messages (the same message
    // in an MBOX and a PST), 10 messages in two folders, two identical drafts with no Message-ID.
    const carolRel = "Custodian C/carol.pst";
    const carol = new PstBuilder(opts.outDir, carolRel, marker);
    const carolMsgs: Msg[] = [];
    for (let i = 0; i < 700; i++) {
      const m = await f.message();
      carolMsgs.push(m);
      carol.add(m, PST_FOLDERS[i % PST_FOLDERS.length]!);
    }
    for (let i = 0; i < 40; i++) carol.add(f.copy(alice[i * 7 + 1]!), ["Inbox", "From Alice"]);
    for (let i = 0; i < 10; i++) carol.add(f.copy(carolMsgs[i * 13]!), ["Archive", "2019"]);
    const draft = await f.draft();
    carol.add(draft, ["Drafts"]);
    carol.add(f.copy(draft), ["Drafts"]);
    const carolCount = carol.count;
    const carolBytes = await carol.finish(dir(carolRel), mf, keyToPath, totals, log);
    note(carolRel, carolBytes, carolCount, "PST with a folder tree", await shaOfFile(join(corpus, carolRel)));
    // The same PST file twice: a top-level exact duplicate (triage skips the second file).
    const carolCopyRel = "Custodian C/carol - backup copy.pst";
    copyFileSync(join(corpus, carolRel), dir(carolCopyRel));
    note(carolCopyRel, carolBytes, 0, `byte-identical copy of ${carolRel}`, await shaOfFile(join(corpus, carolCopyRel)));

    // A large MBOX (several hundred MB); every 97th message is a copy of one of Bob's.
    const archiveRel = "Archive/archive-2019.mbox";
    const arch = await bigMbox(dir(archiveRel), archiveRel, 320 * 1024 ** 2, async (n) => (n > 0 && n % 97 === 0 ? f.copy(bob[(n / 97) % bob.length]!) : f.message(true)));
    note(archiveRel, arch.size, arch.count, "large MBOX (several hundred MB); every 97th message is a copy of one of bob.mbox's", await shaOfFile(join(corpus, archiveRel)));

    // ── Mailboxes that cannot be read, or only in part ───────────────────────
    const smallPst = async (rel: string, count: number, passwordCrc = 0) => {
      const b = new PstBuilder(opts.outDir, rel, marker, passwordCrc);
      for (let i = 0; i < count; i++) b.add(await f.message(), ["Inbox"]);
      return b;
    };
    const work = (name: string) => join(opts.outDir, "work", name);

    const protRel = "Broken/password-protected.pst";
    const protBytes = await (await smallPst(protRel, 20, 0x5eed0042)).finish(dir(protRel), mf, keyToPath, totals, log, "in a password-protected PST: expected not read");
    note(protRel, protBytes, 20, "password-protected (PidTagPstPassword set): expected stored, listed, not read", await shaOfFile(join(corpus, protRel)));

    const encRel = "Broken/high-encryption.pst";
    await (await smallPst(encRel, 20)).finish(work("high-encryption-before-header-change.pst"), mf, keyToPath, totals, log, "in a PST whose header says high encryption: expected not read");
    {
      const b = readFileSync(work("high-encryption-before-header-change.pst"));
      b[513] = 0x02; // bCryptMethod = NDB_CRYPT_CYCLIC ("high encryption"). The blocks keep their permute encoding.
      writeFileSync(dir(encRel), b);
      note(encRel, b.length, 20, "header says high (cyclic) encryption; expected stored, listed, not read. Only the header byte was changed", sha(b));
    }

    const dmgRel = "Broken/damaged-in-the-middle.pst";
    await (await smallPst(dmgRel, 200)).finish(work("damaged-before-damage.pst"), mf, keyToPath, totals, log, "in a PST damaged in the middle: read, or listed as unreadable");
    {
      const b = readFileSync(work("damaged-before-damage.pst"));
      const from = Math.floor(b.length * 0.45) & ~511;
      const to = Math.floor(b.length * 0.55) & ~511;
      b.fill(0, from, to);
      writeFileSync(dir(dmgRel), b);
      note(dmgRel, b.length, 200, `bytes ${from}-${to - 1} zeroed: expected some messages read, the rest listed as unreadable`, sha(b));
    }

    const truncRel = "Broken/truncated.pst";
    await (await smallPst(truncRel, 200)).finish(work("truncated-before-cut.pst"), mf, keyToPath, totals, log, "in a truncated PST");
    {
      const b = readFileSync(work("truncated-before-cut.pst"));
      const cut = b.subarray(0, Math.floor(b.length * 0.6));
      writeFileSync(dir(truncRel), cut);
      note(truncRel, cut.length, 200, `first ${cut.length} of ${b.length} bytes: expected stored and listed with the reason`, sha(cut));
    }

    const cutMboxRel = "Broken/truncated.mbox";
    {
      const msgs: Msg[] = [];
      for (let i = 0; i < 100; i++) msgs.push(await f.message());
      const whole = writeMbox(work("truncated-before-cut.mbox"), cutMboxRel, msgs, null, marker, "\n", keyToPath, totals);
      const b = readFileSync(work("truncated-before-cut.mbox"));
      const cutAt = Math.floor(b.length * 0.7);
      writeFileSync(dir(cutMboxRel), b.subarray(0, cutAt));
      let kept = 0;
      msgs.forEach((m, i) => {
        const start = whole.offsets[i]!;
        if (start >= cutAt) return;
        const end = whole.offsets[i + 1] ?? whole.size;
        kept++;
        messageRows(mf, lite(m), cutMboxRel, [], messagePath(cutMboxRel, [], mboxLocator(start)), keyToPath, totals, end > cutAt ? `cut: the file ends inside this message, at byte ${cutAt}` : "");
      });
      note(cutMboxRel, cutAt, kept, `first ${cutAt} of ${b.length} bytes (cut inside a message): expected the messages before the cut read, the cut one marked`, sha(b.subarray(0, cutAt)));
    }

    const notRel = "Broken/not-a-mailbox.mbox";
    {
      const r = rng.fork();
      const text = Buffer.from(`${marker}\n` + Array.from({ length: 400 }, () => paragraph(r, f.people)).join("\n\n"));
      writeFileSync(dir(notRel), text);
      note(notRel, text.length, 0, "text that is not an mbox (no 'From ' line): expected stored, listed, not read", sha(text));
    }
  }
  mf.close();
  const summary: MailboxSummary = {
    kind: opts.kind, seed: opts.seed, mailboxes: totals.mailboxes, messages: totals.messages, attachments: totals.attachments, bytes: totals.bytes,
    manifest_rows: mf.rows, by_mailbox: totals.byMailbox, elapsed_ms: Date.now() - started, peak_rss_bytes: Math.max(peak, process.memoryUsage().rss),
  };
  writeFileSync(join(opts.outDir, MAILBOX_SUMMARY_FILE), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

export function formatMailboxSummary(s: MailboxSummary, outDir: string): string {
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const lines = [
    `Fake mailboxes written to ${outDir}`,
    `  kind ${s.kind}, seed ${s.seed}: ${s.mailboxes} mailboxes, ${s.messages} message copies, ${s.attachments} attachments, ${mb(s.bytes)} (${s.manifest_rows} manifest rows)`,
    `  ${(s.elapsed_ms / 1000).toFixed(1)} s, peak memory ${mb(s.peak_rss_bytes)}`,
    "",
  ];
  for (const [k, v] of Object.entries(s.by_mailbox)) lines.push(`  ${k.padEnd(42)} ${String(v.messages).padStart(6)} messages ${mb(v.bytes).padStart(10)}  ${v.note}`);
  return lines.join("\n");
}
