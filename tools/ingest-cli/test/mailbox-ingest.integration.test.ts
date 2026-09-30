import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { getDbUrl, withTenant, createDbClient } from "@casefile/db";
import { downloadBucketObject, ensureEmulatorBucket, getGcsStorageClient } from "@casefile/storage";
import { matterConfig } from "../../../matter.config.js";
import { bootstrap } from "../src/bootstrap.js";
import { ingestDirectory, ingestBucket, type IngestBatchSummary } from "../src/ingest.js";
import { buildIngestReport, formatReport } from "../src/report.js";
import { includeSkipped } from "../src/include.js";
import { handleGetSource } from "@casefile/mcp";

/**
 * BIGDATA-3B (D108-D112): PST, OST and MBOX files are read message by message.
 *   - every message becomes its own source under the mailbox file, with the mailbox's folder path
 *     and From, To, Cc, Bcc, Date, Subject and Message-ID; attachments inside messages (a zip and
 *     its entries, an attached email, a PST's embedded message) are ingested as today;
 *   - the mailbox file is stored whole and never changed; a mailbox above the parse size limit is
 *     read message by message, not skipped;
 *   - a mailbox that cannot be read (password, encryption, damage, not a mailbox) is stored and
 *     listed with the reason; the messages read before a file's cut are kept, and the report says
 *     where it stopped;
 *   - the BIGDATA-3 rules apply to each message: exact duplicates by message identity (the same
 *     message twice in one mailbox, or in an MBOX and a PST), near-duplicates, the owner's filters;
 *     every skipped message is a decision row in ingest:report and can be re-included.
 * Fixtures: test-corpus/mailbox.mbox, mailbox.pst, mailbox-password.pst (test-corpus/SOURCES.md).
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CORPUS = join(REPO, "test-corpus");
const BASE = join(process.cwd(), ".tmp-test-fixtures", `mailbox_${Date.now()}`);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const MBOX = readFileSync(join(CORPUS, "mailbox.mbox"));
const PST = readFileSync(join(CORPUS, "mailbox.pst"));
/** The byte offset of each message's "From " line, found here independently of the reader. */
const OFFSETS = [...MBOX.toString("latin1").matchAll(/(?:^|\n\n)(From \S+ [^\n]*\d\d:\d\d:\d\d \d{4})\n/g)].map((m) => m.index! + (m.index === 0 ? 0 : 2));
const PARSE_LIMIT = 5000; // below the size of both mailboxes

type Src = { id: string; filename: string; status: string; sha256: string; storage_uri: string; mime_type: string; metadata: Record<string, unknown> };
type Decision = { id: string; path: string; stage: string; decision: string; rule: string | null; reason: string | null; duplicate_of_path: string | null; duplicate_of_source_id: string | null; supersedes: string | null };

async function matter(label: string) {
  const envDir = join(BASE, `${label}-env`);
  mkdirSync(envDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return bootstrap({ name: `3B ${label} ${stamp}`, investigationName: `3B ${label}`, email: `bigdata3b-${label}-${stamp}@casefile.test`, matter: `bigdata3b-${label}-${stamp}`, envDir, dbUrl: getDbUrl() });
}

// The fixtures' copies of all three suites below live under BASE; removed once, after the last one.
afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe("tools/ingest-cli — BIGDATA-3B mailboxes (PST, OST, MBOX)", () => {
  const A = join(BASE, "a");
  let a: { tenantId: string; investigationId: string };
  let run: IngestBatchSummary;
  let sources: Src[] = [];
  let decisions: Decision[] = [];
  const mboxPath = join(A, "mailbox.mbox");
  const pstPath = join(A, "mailbox.pst");

  const q = async <T,>(tenantId: string, fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      return await withTenant(tenantId, fn, c);
    } finally {
      await c.end();
    }
  };
  const sourcesOf = (tenantId: string) => q(tenantId, (tx) => tx<Src[]>`SELECT id, filename, status, sha256, storage_uri, mime_type, metadata FROM sources ORDER BY created_at, id`);
  const decisionsOf = (tenantId: string, runId: string) => q(tenantId, (tx) => tx<Decision[]>`SELECT * FROM ingest_decisions WHERE run_id = ${runId} ORDER BY seq`);
  const byPath = (p: string) => sources.find((s) => s.metadata.source_path === p);
  const children = (parentId: string) => sources.filter((s) => s.metadata.parent_file_id === parentId);
  const mboxMsg = (i: number) => `${mboxPath}#mailbox:offset:${OFFSETS[i]}`;
  const pstMsgs = () => sources.filter((s) => s.metadata.mailbox_path === pstPath);
  const pstBySubject = (subject: string) => pstMsgs().find((s) => (s.metadata.headers as { subject: string }).subject === subject);
  const storedSha = async (uri: string) => {
    const m = /^gcs:\/\/([^/]+)\/(.+)$/.exec(uri)!;
    return sha(await downloadBucketObject(m[1]!, m[2]!));
  };

  beforeAll(async () => {
    mkdirSync(join(A, "protected"), { recursive: true });
    mkdirSync(join(A, "z-broken"), { recursive: true });
    copyFileSync(join(CORPUS, "mailbox.mbox"), mboxPath);
    copyFileSync(join(CORPUS, "mailbox.pst"), pstPath);
    copyFileSync(join(CORPUS, "mailbox-password.pst"), join(A, "protected", "mailbox-password.pst"));
    const enc = Buffer.from(PST);
    enc[513] = 0x02; // the header's bCryptMethod: high (cyclic) encryption
    writeFileSync(join(A, "z-broken", "encrypted.pst"), enc);
    // Cut to 15%: this small PST keeps all its messages in its first 30% (a 30% cut still reads all 6).
    writeFileSync(join(A, "z-broken", "truncated.pst"), PST.subarray(0, Math.floor(PST.length * 0.15)));
    writeFileSync(join(A, "z-broken", "not-a-mailbox.mbox"), "Fictional notes that are not a mailbox.\nNo From line starts this file.\n");
    const zip = new AdmZip();
    zip.addFile("inner.mbox", MBOX.subarray(OFFSETS[5]!)); // the last message only: not the same bytes as mailbox.mbox
    zip.writeZip(join(A, "z-broken", "bundle-with-a-mailbox.zip"));
    expect(OFFSETS).toHaveLength(6);
    expect(MBOX.length).toBeGreaterThan(PARSE_LIMIT);
    expect(PST.length).toBeGreaterThan(PARSE_LIMIT);

    a = await matter("a");
    run = await ingestDirectory({ dir: A, investigationId: a.investigationId, tenantId: a.tenantId, dbUrl: getDbUrl(), maxParseBytes: PARSE_LIMIT });
    sources = await sourcesOf(a.tenantId);
    decisions = await decisionsOf(a.tenantId, run.runId);
  });

  it("stores each mailbox file whole and unchanged, and reads it message by message although it is above the parse size limit", async () => {
    for (const [p, bytes] of [[mboxPath, MBOX], [pstPath, PST]] as const) {
      const s = byPath(p)!;
      expect(s.status, p).toBe("indexed");
      expect(Number(bytes.length)).toBeGreaterThan(PARSE_LIMIT);
      expect(s.sha256).toBe(sha(bytes));
      expect(await storedSha(s.storage_uri), "the stored object is the whole file").toBe(sha(bytes));
      expect(sha(readFileSync(p)), "the file on disk is unchanged").toBe(sha(bytes));
      expect((s.metadata.mailbox_read as { messages_read: number }).messages_read).toBe(6);
    }
    expect(byPath(mboxPath)!.mime_type).toBe("application/mbox");
    expect(byPath(pstPath)!.mime_type).toBe("application/vnd.ms-outlook-pst");
  });

  it("makes every MBOX message its own source under the mailbox, named by its offset (the copy that is a duplicate is a decision)", () => {
    const mb = byPath(mboxPath)!;
    const msgs = sources.filter((s) => s.metadata.mailbox_path === mboxPath);
    expect(msgs.map((s) => s.metadata.source_path).sort()).toEqual([0, 2, 3, 4, 5].map(mboxMsg).sort());
    for (const s of msgs) {
      expect(s.metadata.parent_file_id).toBe(mb.id);
      expect(s.metadata.mailbox_source_id).toBe(mb.id);
      expect(s.metadata.folder_path).toBe("");
      expect(s.filename).toMatch(/\.eml$/);
      expect(s.status).toBe("indexed");
    }
    expect(decisions.find((d) => d.path === mboxMsg(1))?.decision).toBe("skip-duplicate");
  });

  it("keeps each message's From, To, Cc, Bcc, Date, Subject and Message-ID (and a Bcc in its indexed header text)", async () => {
    const m1 = byPath(mboxMsg(0))!.metadata.headers as Record<string, string>;
    expect(m1.from).toContain("jane.doe@example.com");
    expect(m1.to).toContain("john.roe@example.org");
    expect(m1.cc).toContain("mary.major@example.net");
    expect(m1.bcc).toBe("");
    expect(m1.date).toBe("2021-03-04T10:11:12.000Z");
    expect(m1.subject).toBe("Harbour lease: first draft");
    expect(m1.message_id).toBe("<harbour-1@example.com>");
    const m6 = byPath(mboxMsg(5))!;
    expect((m6.metadata.headers as Record<string, string>).bcc).toContain("mary.major@example.net");
    const headerBlock = await q(a.tenantId, (tx) => tx<{ text: string }[]>`
      SELECT b.text FROM content_blocks b JOIN content_documents cd ON cd.id = b.content_document_id JOIN artifacts ar ON ar.id = cd.artifact_id
      WHERE ar.source_id = ${m6.id} AND b.block_type = 'email_header'`);
    expect(headerBlock[0]!.text).toMatch(/\nBcc: "?Mary Major"? <mary\.major@example\.net>\n/);
  });

  it("gives back a body line that began with 'From ' (written '>From ' in the mbox)", async () => {
    const body = await q(a.tenantId, (tx) => tx<{ text: string }[]>`
      SELECT b.text FROM content_blocks b JOIN content_documents cd ON cd.id = b.content_document_id JOIN artifacts ar ON ar.id = cd.artifact_id
      WHERE ar.source_id = ${byPath(mboxMsg(0))!.id} AND b.section_path = 'Email Body'`);
    expect(body[0]!.text).toContain("\nFrom the minutes of 3 March");
    expect(body[0]!.text).not.toContain(">From");
  });

  it("ingests the attachments inside a message: a zip and its entries, and an attached email", () => {
    const m1 = byPath(mboxMsg(0))!;
    const kids = children(m1.id);
    expect(kids.map((k) => k.filename).sort()).toEqual(["FW_ Survey report.eml", "bundle.zip"]);
    const zip = kids.find((k) => k.filename === "bundle.zip")!;
    expect(zip.metadata.source_path).toBe(`${mboxMsg(0)}#attachment:bundle.zip`);
    expect(children(zip.id).map((k) => k.filename).sort()).toEqual(["notes.txt", "schedule.csv"]);
    const fw = kids.find((k) => k.filename.endsWith(".eml"))!;
    expect(fw.status).toBe("indexed");
  });

  it("makes every PST message its own source with its folder path ('/' and '#' in folder names kept), headers and Bcc", () => {
    const p2 = pstBySubject("Q2 figures (fictional)")!;
    expect(p2.metadata.folder_path).toBe("Inbox/Q1/Q2 Reports");
    expect(String(p2.metadata.source_path)).toMatch(new RegExp(`^${pstPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}#mailbox:Inbox/Q1%2FQ2 Reports/nid:0x[0-9a-f]{8}$`));
    const h = p2.metadata.headers as Record<string, string>;
    expect(h.from).toContain("john.roe@example.org");
    expect(h.to).toContain("jane.doe@example.com");
    expect(h.cc).toContain("richard.roe@example.com");
    expect(h.bcc).toContain("sam.poe@example.org");
    expect(h.message_id).toBe("<q2@example.org>");
    expect(h.date).toBe("2021-07-01T09:15:00.000Z");
    expect(p2.metadata.rendered).toMatch(/rendering/);
    expect(p2.metadata.parent_file_id).toBe(byPath(pstPath)!.id);
    const p6 = pstBySubject("Case #12 hearing date")!;
    expect(p6.metadata.folder_path).toBe("Inbox/Case #12");
    expect(String(p6.metadata.source_path)).toContain("#mailbox:Inbox/Case %2312/nid:0x");
    expect(((pstBySubject("Re: Harbour lease")!.metadata.headers) as Record<string, string>).bcc).toContain("john.roe@example.org");
    expect(pstBySubject("Re: Harbour lease")!.metadata.folder_path).toBe("Sent Items");
    expect(pstMsgs().map((s) => s.metadata.folder_path).sort()).toEqual(["Drafts", "Inbox/Case #12", "Inbox/Q1/Q2 Reports", "Sent Items"]);
  });

  it("ingests a PST message's attachments: a file and an embedded message", () => {
    const kids = children(pstBySubject("Q2 figures (fictional)")!.id);
    expect(kids.map((k) => k.filename).sort()).toEqual(["FW_ Q1 figures.eml", "figures.csv"]);
    expect(kids.every((k) => k.status === "indexed")).toBe(true);
  });

  it("lists an attachment the PST holds only by reference (no content) as not read, with its path", async () => {
    const p3 = pstBySubject("Re: Harbour lease")!;
    expect(children(p3.id)).toEqual([]);
    const failed = await q(a.tenantId, (tx) => tx<{ path: string; reason: string }[]>`
      SELECT after->>'path' AS path, after->>'reason' AS reason FROM audit_events WHERE action = 'source.ingest_failed'`);
    const row = failed.find((f) => f.path === `${String(p3.metadata.source_path)}#attachment:lease.pdf`)!;
    expect(row.reason).toMatch(/attachment not read: attach method 2/);
    const listed = run.mailboxes.find((m) => m.path === pstPath)!;
    expect(listed.attachments.failed).toBe(1);
    expect(listed.failed, "no message was unreadable").toBe(0);
  });

  it("skips exact duplicates by message identity: twice in one MBOX, in an MBOX and a PST, twice in a PST; not a reused Message-ID", async () => {
    const dups = decisions.filter((d) => d.rule === "message-duplicate");
    // BIGDATA-4 (answer 1): the password-protected PST is read now; its one message is M3 again.
    expect(dups.map((d) => d.stage)).toEqual(["ingest", "ingest", "ingest", "ingest"]);
    const pwDup = dups.find((d) => d.path.startsWith(join(A, "protected", "mailbox-password.pst")))!;
    expect(pwDup.duplicate_of_path, "the protected PST's copy of M3").toBe(mboxMsg(2));
    expect(dups.every((d) => d.decision === "skip-duplicate")).toBe(true);
    const m1 = byPath(mboxMsg(0))!;
    const m2Dup = dups.find((d) => d.path === mboxMsg(1))!;
    expect(m2Dup.duplicate_of_source_id).toBe(m1.id);
    const p1Dup = dups.find((d) => d.path.includes("#mailbox:Inbox/Projects/nid:"))!;
    expect(p1Dup.duplicate_of_source_id, "the PST copy of the MBOX message").toBe(m1.id);
    expect(p1Dup.duplicate_of_path).toBe(mboxMsg(0));
    const p5Dup = dups.find((d) => d.path.includes("#mailbox:Drafts/nid:"))!;
    expect(p5Dup.duplicate_of_source_id).toBe(pstMsgs().find((s) => s.metadata.folder_path === "Drafts")!.id);
    // M5 reuses M1's Message-ID with another body: indexed, not a duplicate.
    const m5 = byPath(mboxMsg(4))!;
    expect((m5.metadata.headers as Record<string, string>).message_id).toBe("<harbour-1@example.com>");
    expect(m5.status).toBe("indexed");
    const audit = await q(a.tenantId, (tx) => tx<{ object_id: string }[]>`SELECT object_id FROM audit_events WHERE action = 'source.skip' AND object_type = 'ingest_decision'`);
    for (const d of dups) expect(audit.map((x) => x.object_id), `audit row for ${d.path}`).toContain(d.id);
  });

  it("groups a message sent again under the first one as a near-duplicate (both indexed)", async () => {
    const [m3, m4] = [byPath(mboxMsg(2))!, byPath(mboxMsg(3))!];
    const fp = await q(a.tenantId, (tx) => tx<{ source_id: string; near_duplicate_of: string | null }[]>`SELECT source_id, near_duplicate_of FROM document_fingerprints WHERE source_id = ${m4.id}`);
    expect(fp[0]!.near_duplicate_of).toBe(m3.id);
    expect(m4.status).toBe("indexed");
  });

  it("stores and lists, with the reason, a mailbox that cannot be read: encryption, a cut PST, not a mailbox", async () => {
    const expectStored = async (rel: string, code: string, reason: RegExp) => {
      const s = byPath(join(A, rel))!;
      expect(s.status, rel).toBe("stored_unparsed");
      expect(s.metadata.unparsed_reason, rel).toBe(code);
      expect(String(s.metadata.reason), rel).toMatch(reason);
      expect(await storedSha(s.storage_uri), `${rel} stored whole`).toBe(sha(readFileSync(join(A, rel))));
      const listed = run.mailboxes.find((m) => m.path === join(A, rel))!;
      expect(listed.status).toBe("stored_unparsed");
      expect(listed.reason).toMatch(reason);
    };
    await expectStored(join("z-broken", "encrypted.pst"), "encrypted", /high \(cyclic\) encryption/);
    await expectStored(join("z-broken", "truncated.pst"), "corrupt", /could not be opened|could not be read/);
    await expectStored(join("z-broken", "not-a-mailbox.mbox"), "not-a-mailbox", /not an mbox file/);
    const audit = await q(a.tenantId, (tx) => tx<{ object_display: string; outcome: string }[]>`SELECT object_display, outcome FROM audit_events WHERE action = 'source.mailbox_read'`);
    expect(audit.filter((x) => x.outcome === "failure").map((x) => x.object_display).sort()).toEqual(["encrypted.pst", "not-a-mailbox.mbox", "truncated.pst"]);
  });

  it("BIGDATA-4 (owner's answer 1): reads the password-protected PST, marks it, and its one message (M3 again) is a message-duplicate", () => {
    const path = join(A, "protected", "mailbox-password.pst");
    const box = byPath(path)!;
    expect(box.status).toBe("indexed");
    expect(box.metadata.password_protected).toBe(true);
    expect(box.metadata.unparsed_reason).toBeUndefined();
    const listed = run.mailboxes.find((m) => m.path === path)!;
    expect(listed.status).toBe("indexed");
    expect(listed.password_protected).toBe(true);
    expect(listed.messages_read).toBe(1);
    expect(listed.messages_skipped).toEqual({ "message-duplicate": 1 });
  });

  it("stores a mailbox found inside a zip, and says it is not read there", () => {
    const inner = sources.find((s) => s.filename === "inner.mbox")!;
    expect(inner.status).toBe("stored_unparsed");
    expect(inner.metadata.unparsed_reason).toBe("mailbox_in_container");
  });

  it("lists every skipped message and every mailbox in ingest:report", async () => {
    const report = await buildIngestReport({ runId: run.runId, tenantId: a.tenantId, dbUrl: getDbUrl() });
    expect(report.skipped.filter((s) => s.rule === "message-duplicate").map((s) => s.path).sort()).toEqual(decisions.filter((d) => d.rule === "message-duplicate").map((d) => d.path).sort());
    const text = formatReport(report, "skipped.csv", null);
    expect(text).toContain("Mailboxes: 6");
    expect(text).toContain("had a password");
    expect(text).toMatch(/messages read 6, admitted 5, skipped 1 message-duplicate, unreadable 0/);
    expect(text).toMatch(/messages read 6, admitted 4, skipped 2 message-duplicate, unreadable 0/);
  });

  it("re-includes a skipped message with ingest:include, by path and by rule, read again out of its mailbox", async () => {
    const one = await includeSkipped({ runId: run.runId, path: mboxMsg(1), tenantId: a.tenantId, dbUrl: getDbUrl() });
    expect(one.results.map((r) => r.status)).toEqual(["indexed"]);
    const after = await sourcesOf(a.tenantId);
    const m2 = after.find((s) => s.id === one.results[0]!.sourceId)!;
    expect(m2.metadata.source_path).toBe(mboxMsg(1));
    expect(m2.metadata.mailbox_path).toBe(mboxPath);
    expect((m2.metadata.headers as Record<string, string>).subject).toBe("Harbour lease: first draft");
    // Its bytes: the message as it is in the file after its "From " line, with the ">From " escaping undone.
    const raw = MBOX.subarray(MBOX.indexOf("\n", OFFSETS[1]!) + 1, OFFSETS[2]! - 1).toString("latin1");
    expect(m2.sha256).toBe(sha(Buffer.from(raw.replace(/^>(>*From )/gm, "$1"), "latin1")));
    const rest = await includeSkipped({ runId: run.runId, rule: "message-duplicate", tenantId: a.tenantId, dbUrl: getDbUrl() });
    const status = Object.fromEntries(rest.results.map((r) => [r.path.includes("#mailbox:Drafts/") ? "draft copy" : "pst copy of M1", r.status]));
    // The PST copy has other bytes (a rendering) than the MBOX message: its own source. The second
    // draft renders to the same bytes as the first: linked as another copy (D103).
    expect(status).toEqual({ "pst copy of M1": "indexed", "draft copy": "linked" });
  });

  it("reads MBOX and PST mailboxes from a bucket the same way (the objects are not changed)", async () => {
    const BUCKET = process.env.GCS_BUCKET_SOURCES ?? "";
    expect(BUCKET).toMatch(/^casefile-localtest-/);
    await ensureEmulatorBucket(BUCKET);
    const prefix = `mailbox-bucket-${Date.now()}/`;
    const bucket = (await getGcsStorageClient()).bucket(BUCKET);
    await bucket.file(`${prefix}mailbox.mbox`).save(MBOX);
    await bucket.file(`${prefix}mailbox.pst`).save(PST);
    const before = (await bucket.getFiles({ prefix }))[0].map((f) => `${f.name}:${String(f.metadata.generation)}:${String(f.metadata.md5Hash)}`).sort();
    const b = await matter("bucket");
    matterConfig.ingestBuckets.push(BUCKET); // the sandbox bucket, bound to this test's matter only while it runs
    let r: IngestBatchSummary;
    try {
      r = await ingestBucket({ bucket: BUCKET, prefix, investigationId: b.investigationId, tenantId: b.tenantId, dbUrl: getDbUrl() });
    } finally {
      matterConfig.ingestBuckets.splice(matterConfig.ingestBuckets.indexOf(BUCKET), 1);
    }
    const got = Object.fromEntries(r.mailboxes.map((m) => [m.path.split("/").pop(), [m.messages_read, m.messages_admitted, m.messages_skipped["message-duplicate"] ?? 0]]));
    expect(got).toEqual({ "mailbox.mbox": [6, 5, 1], "mailbox.pst": [6, 4, 2] });
    const after = (await bucket.getFiles({ prefix }))[0].map((f) => `${f.name}:${String(f.metadata.generation)}:${String(f.metadata.md5Hash)}`).sort();
    expect(after).toEqual(before);
  });
});

describe("tools/ingest-cli — BIGDATA-3B a mailbox cut in the middle of a message", () => {
  const B = join(BASE, "b");
  // Cut inside the body of the fifth message: the first four are whole, the fifth is cut, the sixth is gone.
  const CUT = MBOX.indexOf("a fictional correction follows");
  let s: IngestBatchSummary;
  let tenantId: string;

  beforeAll(async () => {
    mkdirSync(B, { recursive: true });
    writeFileSync(join(B, "cut.mbox"), MBOX.subarray(0, CUT));
    const m = await matter("cut");
    tenantId = m.tenantId;
    s = await ingestDirectory({ dir: B, investigationId: m.investigationId, tenantId, dbUrl: getDbUrl() });
  });

  it("keeps the messages read before the cut, marks the cut one, and says where reading stopped", async () => {
    expect(CUT).toBeGreaterThan(OFFSETS[4]!);
    expect(CUT).toBeLessThan(OFFSETS[5]!);
    const mb = s.mailboxes[0]!;
    expect([mb.messages_read, mb.messages_admitted, mb.messages_skipped["message-duplicate"]]).toEqual([5, 4, 1]);
    expect(mb.stopped_at).toContain(`cut.mbox#mailbox:offset:${OFFSETS[4]}`);
    expect(mb.stopped_at).toContain("the file ends inside this message");
    const c = createDbClient(getDbUrl(), { max: 1 });
    const rows = await withTenant(tenantId, (tx) => tx<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM sources WHERE metadata->>'mailbox_path' IS NOT NULL`, c);
    await c.end();
    expect(rows.filter((r) => r.metadata.truncated === true).map((r) => r.metadata.message_locator)).toEqual([`offset:${OFFSETS[4]}`]);
    const report = formatReport(await buildIngestReport({ runId: s.runId, tenantId, dbUrl: getDbUrl() }), "x.csv", null);
    expect(report).toContain(`stopped: ${join(B, "cut.mbox")}#mailbox:offset:${OFFSETS[4]}`);
  });
});

describe("tools/ingest-cli — BIGDATA-3B the case owner's filters, message by message", () => {
  const C = join(BASE, "c");
  let s: IngestBatchSummary;
  let tenantId: string;
  let decisions: Decision[] = [];

  beforeAll(async () => {
    mkdirSync(C, { recursive: true });
    copyFileSync(join(CORPUS, "mailbox.mbox"), join(C, "mailbox.mbox"));
    copyFileSync(join(CORPUS, "mailbox.pst"), join(C, "mailbox.pst"));
    const m = await matter("filters");
    tenantId = m.tenantId;
    s = await ingestDirectory({ dir: C, investigationId: m.investigationId, tenantId, dbUrl: getDbUrl(), filters: { emailDateFrom: "2020-01-01", excludePersons: ["richard.roe@example.com"] } });
    const c = createDbClient(getDbUrl(), { max: 1 });
    decisions = await withTenant(tenantId, (tx) => tx<Decision[]>`SELECT * FROM ingest_decisions WHERE run_id = ${s.runId} AND decision = 'skip-filter' ORDER BY seq`, c);
    await c.end();
  });

  it("skips each message the filters catch, by its own headers, as a decision row, and never the mailbox file", () => {
    const got = decisions.map((d) => [d.path.includes(".mbox#") ? `mbox ${d.path.split("offset:")[1]}` : `pst ${d.path.split("#mailbox:")[1]!.split("/nid:")[0]}`, d.rule]);
    expect(got).toEqual([
      // M1 stays, but the email attached to it is from Richard: the filters judge an attached email too.
      [`mbox ${OFFSETS[0]}#attachment:FW_ Survey report.eml`, "exclude-person"],
      [`mbox ${OFFSETS[2]}`, "email-date"],
      [`mbox ${OFFSETS[3]}`, "email-date"],
      ["pst Inbox/Q1%2FQ2 Reports", "exclude-person"],
      ["pst Sent Items", "exclude-person"],
    ]);
    expect(s.mailboxes.map((m) => m.status)).toEqual(["indexed", "indexed"]);
    expect(s.mailboxes[1]!.messages_skipped).toEqual({ "exclude-person": 2, "message-duplicate": 2 });
  });

  it("re-includes a filtered message", async () => {
    const d = decisions.find((x) => x.path.includes("#mailbox:Sent Items/"))!;
    const out = await includeSkipped({ runId: s.runId, path: d.path, tenantId, dbUrl: getDbUrl() });
    expect(out.results.map((r) => [r.previousRule, r.status])).toEqual([["exclude-person", "indexed"]]);
  });
});

describe("tools/ingest-cli — BIGDATA-4 password-protected PSTs are read (owner's answer 1)", () => {
  it("marks the mailbox and its messages as having had a password, in their metadata and in get_source", async () => {
    const dir = join(BASE, "password-only");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "mailbox-password.pst");
    copyFileSync(join(CORPUS, "mailbox-password.pst"), path);
    const m = await matter("password");
    const q = async <T,>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>): Promise<T> => {
      const c = createDbClient(getDbUrl(), { max: 1 });
      try {
        return await withTenant(m.tenantId, fn, c);
      } finally {
        await c.end();
      }
    };
    await ingestDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    const rows = await q((tx) => tx<Src[]>`SELECT id, filename, status, sha256, storage_uri, mime_type, metadata FROM sources ORDER BY created_at, id`);
    const box = rows.find((s) => s.metadata.source_path === path)!;
    expect(box.status).toBe("indexed");
    expect(box.metadata.password_protected).toBe(true);
    const msgs = rows.filter((s) => s.metadata.mailbox_path === path);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.metadata.mailbox_password_protected).toBe(true);
    const ctx = { tenantId: m.tenantId, investigationId: m.investigationId, userId: m.userId, roles: ["lead_inv"] };
    const ofBox = await q((tx) => handleGetSource(tx, ctx, { source_id: box.id }));
    expect(ofBox.source.mailbox_file).toEqual({ format: "pst", had_password: true });
    const ofMsg = await q((tx) => handleGetSource(tx, ctx, { source_id: msgs[0]!.id }));
    expect(ofMsg.source.mailbox).toEqual(expect.objectContaining({ mailbox_had_password: true, folder_path: "Inbox" }));
    // A PST without a password answers as before: no mark.
    const plainDir = join(BASE, "plain-only");
    mkdirSync(plainDir, { recursive: true });
    copyFileSync(join(CORPUS, "mailbox.pst"), join(plainDir, "mailbox.pst"));
    const p = await matter("plain");
    await ingestDirectory({ dir: plainDir, investigationId: p.investigationId, tenantId: p.tenantId, userId: p.userId });
    const c = createDbClient(getDbUrl(), { max: 1 });
    try {
      const plain = await withTenant(p.tenantId, (tx) => tx<Src[]>`SELECT id, filename, status, sha256, storage_uri, mime_type, metadata FROM sources ORDER BY created_at, id`, c);
      const pctx = { tenantId: p.tenantId, investigationId: p.investigationId, userId: p.userId, roles: ["lead_inv"] };
      const plainBox = await withTenant(p.tenantId, (tx) => handleGetSource(tx, pctx, { source_id: plain.find((s) => s.metadata.source_path === join(plainDir, "mailbox.pst"))!.id }), c);
      expect(plainBox.source.mailbox_file).toBeUndefined();
      const plainMsg = await withTenant(p.tenantId, (tx) => handleGetSource(tx, pctx, { source_id: plain.find((s) => typeof s.metadata.message_hash === "string")!.id }), c);
      expect(plainMsg.source.mailbox).not.toHaveProperty("mailbox_had_password");
    } finally {
      await c.end();
    }
  });
});
