/**
 * Writes the mailbox fixtures of test-corpus/ (BIGDATA-3B): mailbox.mbox, mailbox.pst and
 * mailbox-password.pst. Every person, address and fact is invented (example.com / .org / .net).
 *
 *   npx tsx test-corpus/generate/generate-mailboxes.ts
 *
 * The .mbox is written here, byte for byte. The .pst files are written by the fake-corpus PST
 * writer (tools/fake-corpus/src/pst-writer.ts: Windows only; it fetches its pinned PST library and
 * starting file into a cache outside the repository). The PST library writes random GUIDs and the
 * current time, so a new run gives the same messages but not the same bytes.
 *
 * The messages, and what the tests rely on:
 *   mailbox.mbox (LF line ends)
 *     M1 Harbour lease: first draft   Jane -> John, Cc Mary; a body line starting "From " (written
 *                                     ">From "); bundle.zip (notes.txt, schedule.csv) and an
 *                                     attached message "FW Survey report.eml"; word quayside-lantern
 *     M2 the same message as M1, another mailbox copy (other Received and Status lines): a duplicate
 *     M3 Old berth invoice            Sam -> Jane, 1 June 2019
 *     M4 M3 sent again on 15 June 2019 (new Message-ID, same text): a near-duplicate
 *     M5 reuses M1's Message-ID with another body: NOT a duplicate
 *     M6 Private note on the lease    Jane -> John, Bcc Mary (the sender's copy)
 *   mailbox.pst (folders Inbox/Projects, Inbox/Q1/Q2 Reports, Inbox/Case #12, Sent Items, Drafts)
 *     P1 Inbox/Projects: the same message as M1 (an MBOX and a PST copy of one message)
 *     P2 Inbox/Q1/Q2 Reports: John -> Jane, Cc Richard, Bcc Sam; figures.csv and an embedded
 *        message "FW: Q1 figures"; word saltmarsh-ledger
 *     P3 Sent Items: Jane -> Richard, Bcc John; lease.pdf attached by reference (the PST holds only
 *        its path, no content: listed as an attachment that could not be read)
 *     P4, P5 Drafts: the same unsent draft twice, no Message-ID: a duplicate
 *     P6 Inbox/Case #12: Mary -> Jane, 10 January 2020
 *   mailbox-password.pst: one message; the store has a password.
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { writePst, type PstMessageSpec, type PstRecipient } from "../../tools/fake-corpus/src/pst-writer.js";
import { attachedMessageFileName } from "../../tools/ingest-cli/src/mailbox-paths.js";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTE = "FICTIONAL DOCUMENT FOR SOFTWARE TESTING. ALL NAMES AND FACTS ARE INVENTED.";

const P = {
  jane: { n: "Jane Doe", e: "jane.doe@example.com" },
  john: { n: "John Roe", e: "john.roe@example.org" },
  mary: { n: "Mary Major", e: "mary.major@example.net" },
  richard: { n: "Richard Roe", e: "richard.roe@example.com" },
  sam: { n: "Sam Poe", e: "sam.poe@example.org" },
} satisfies Record<string, PstRecipient>;
const addr = (r: PstRecipient) => `${r.n} <${r.e}>`;

const M1_BODY = [
  "John,",
  "Here is the first draft of the fictional harbour lease. The quayside-lantern clause is new.",
  "From the minutes of 3 March: the berth fee stays at the invented rate.",
  `Jane\n${NOTE}`,
].join("\n\n");

const zip = new AdmZip();
zip.addFile("notes.txt", Buffer.from(`Fictional notes: tide tables and berth numbers.\n${NOTE}\n`));
zip.addFile("schedule.csv", Buffer.from("berth,fee\n12,100\n14,120\n"));
const BUNDLE = zip.toBuffer();

const SURVEY = { subject: "FW: Survey report", from: P.richard, to: [P.jane], date: "2021-02-20T09:00:00Z", messageId: "<survey-1@example.org>", body: `The fictional survey found rust on berth 12.\n\n${NOTE}` };

const rfc = (d: string) => new Date(d).toUTCString().replace("GMT", "+0000");

function embeddedEml(e: typeof SURVEY): string {
  return [
    `From: ${addr(e.from)}`, `To: ${e.to.map(addr).join(", ")}`, `Subject: ${e.subject}`, `Date: ${rfc(e.date)}`, `Message-ID: ${e.messageId}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", e.body, "",
  ].join("\n");
}

interface M {
  from: PstRecipient;
  to: PstRecipient[];
  cc?: PstRecipient[];
  bcc?: PstRecipient[];
  date: string;
  subject: string;
  messageId: string | null;
  body: string;
  atts?: { name: string; mime: string; data: Buffer }[];
  emb?: (typeof SURVEY)[];
}

function eml(m: M, copy: string): string {
  const lines = [
    `Return-Path: <${m.from.e}>`,
    `Received: from mail.example.com by ${copy}.example.net; ${rfc(m.date)}`,
    `From: ${addr(m.from)}`,
    `To: ${m.to.map(addr).join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(addr).join(", ")}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.map(addr).join(", ")}`] : []),
    `Subject: ${m.subject}`,
    `Date: ${rfc(m.date)}`,
    ...(m.messageId ? [`Message-ID: ${m.messageId}`] : []),
    `Status: ${copy === "mx-b" ? "RO" : "O"}`,
    "MIME-Version: 1.0",
  ];
  if (!m.atts?.length && !m.emb?.length) return [...lines, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", m.body, ""].join("\n");
  const b = "=_fixture_boundary";
  const out = [...lines, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", m.body];
  for (const a of m.atts ?? []) {
    out.push(`--${b}`, `Content-Type: ${a.mime}; name="${a.name}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${a.name}"`, "", a.data.toString("base64").replace(/(.{76})/g, "$1\n").trimEnd());
  }
  for (const e of m.emb ?? []) {
    const name = attachedMessageFileName(e.subject);
    out.push(`--${b}`, `Content-Type: message/rfc822; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "", embeddedEml(e));
  }
  out.push(`--${b}--`, "");
  return out.join("\n");
}

const escapeFrom = (s: string) => s.replace(/(^|\n)(>*From )/g, "$1>$2");
const fromLine = (m: M) => `From ${m.from.e} ${new Date(m.date).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, (_x, d, dd, mo, y, t) => `${d} ${mo} ${String(Number(dd)).padStart(2, " ")} ${t} ${y}`)}`;

const M1: M = { from: P.jane, to: [P.john], cc: [P.mary], date: "2021-03-04T10:11:12Z", subject: "Harbour lease: first draft", messageId: "<harbour-1@example.com>", body: M1_BODY, atts: [{ name: "bundle.zip", mime: "application/zip", data: BUNDLE }], emb: [SURVEY] };
const M3: M = { from: P.sam, to: [P.jane], date: "2019-06-01T08:30:00Z", subject: "Old berth invoice", messageId: "<berth-2019@example.org>", body: `Jane,\n\nThe fictional invoice for berth 14 in May is attached to nothing: the amount is 120 invented units, due in thirty days.\n\nPlease confirm the berth, the dates and the amount, and tell me who signs for the harbour board.\n\nSam\n\n${NOTE}` };
const MBOX: { m: M; copy: string }[] = [
  { m: M1, copy: "mx-a" },
  { m: M1, copy: "mx-b" },
  { m: M3, copy: "mx-a" },
  { m: { ...M3, messageId: "<berth-2019-resent@example.org>", date: "2019-06-15T08:30:00Z" }, copy: "mx-a" },
  { m: { ...M1, body: `John, ignore the draft: a fictional correction follows.\n\n${NOTE}`, atts: [], emb: [] }, copy: "mx-a" },
  { m: { from: P.jane, to: [P.john], bcc: [P.mary], date: "2021-05-05T16:00:00Z", subject: "Private note on the lease", messageId: "<private-1@example.com>", body: `John, a fictional private note. Mary is copied blind.\n\n${NOTE}` }, copy: "mx-a" },
];

const mbox = MBOX.map(({ m, copy }) => `${fromLine(m)}\n${escapeFrom(eml(m, copy))}\n`).join("");
writeFileSync(join(OUT, "mailbox.mbox"), mbox);

const spec = (key: string, folder: string[], m: M): PstMessageSpec => ({
  t: "msg", key, folder, subject: m.subject, body: m.body.replace(/\n/g, "\r\n"), from: m.from, to: m.to, cc: m.cc ?? [], bcc: m.bcc ?? [], date: m.date,
  messageId: m.messageId, headers: null,
  atts: (m.atts ?? []).map((a) => ({ name: a.name, mime: a.mime, b64: a.data.toString("base64") })),
  emb: (m.emb ?? []).map((e) => ({ subject: e.subject, body: e.body.replace(/\n/g, "\r\n"), from: e.from, to: e.to, date: e.date, messageId: e.messageId })),
});
const DRAFT: M = { from: P.jane, to: [P.john], date: "2021-06-01T12:00:00Z", subject: "DRAFT note on the berth fee", messageId: null, body: `Unsent fictional draft about the berth fee.\n\n${NOTE}` };
const PST: PstMessageSpec[] = [
  spec("P1", ["Inbox", "Projects"], M1),
  spec("P2", ["Inbox", "Q1/Q2 Reports"], {
    from: P.john, to: [P.jane], cc: [P.richard], bcc: [P.sam], date: "2021-07-01T09:15:00Z", subject: "Q2 figures (fictional)", messageId: "<q2@example.org>",
    body: `Jane,\n\nThe fictional Q2 figures: see figures.csv. Keyword saltmarsh-ledger.\n\nJohn\n\n${NOTE}`,
    atts: [{ name: "figures.csv", mime: "text/csv", data: Buffer.from("quarter,amount\nQ1,10\nQ2,12\n") }],
    emb: [{ subject: "FW: Q1 figures", from: P.mary, to: [P.john], date: "2021-04-02T10:00:00Z", messageId: "<q1@example.net>", body: `Q1 fictional figures, for the record.\n\n${NOTE}` }],
  }),
  { ...spec("P3", ["Sent Items"], { from: P.jane, to: [P.richard], bcc: [P.john], date: "2021-03-05T11:00:00Z", subject: "Re: Harbour lease", messageId: "<re-harbour@example.com>", body: `Richard, the fictional lease is with John.\n\n${NOTE}` }),
    atts: [{ name: "lease.pdf", mime: "application/pdf", reference: "\\\\fileserver.example.com\\leases\\lease.pdf" }] },
  spec("P4", ["Drafts"], DRAFT),
  spec("P5", ["Drafts"], DRAFT),
  spec("P6", ["Inbox", "Case #12"], { from: P.mary, to: [P.jane], date: "2020-01-10T14:00:00Z", subject: "Case #12 hearing date", messageId: "<case12@example.net>", body: `The fictional hearing for case 12 is on 3 February 2020.\n\n${NOTE}` }),
];

async function pst(name: string, lines: object[]): Promise<void> {
  const work = join(tmpdir(), `casefile-fixture-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const specPath = join(work, `${name}.spec.jsonl`);
  writeFileSync(specPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const tmpOut = join(work, name);
  if (existsSync(tmpOut)) throw new Error(`${tmpOut} exists`);
  await writePst(specPath, tmpOut, (s) => process.stdout.write(`${s}\n`));
  copyFileSync(tmpOut, join(OUT, name));
}

async function main(): Promise<void> {
  await pst("mailbox.pst", [{ t: "store", name: "Fixture mailbox (fictional)", passwordCrc: 0 }, ...PST]);
  await pst("mailbox-password.pst", [{ t: "store", name: "Fixture protected mailbox (fictional)", passwordCrc: 0x0badcafe }, spec("W1", ["Inbox"], M3)]);
  process.stdout.write("wrote mailbox.mbox, mailbox.pst, mailbox-password.pst\n");
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
