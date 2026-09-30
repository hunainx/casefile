import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMbox, NotAnMboxError, type MboxMessage } from "../src/mbox.js";
import { openPst, walkPst } from "../src/pst.js";
import { planMboxParts, readMboxPart, planPstParts, readPstPart } from "../src/mailbox-split.js";

/**
 * BIGDATA-4 (plan section 16): a big mailbox is split into parts that different workers read.
 *   - MBOX by byte range: a part reads the messages whose "From " line starts inside its range, using
 *     the whole-file reader's own rule to find a message start, so every message is read by exactly
 *     one part, with the same offset and bytes as when the file is read whole;
 *   - PST by folder and message index: a part reads its folder's messages [start, start + count), so
 *     every message is read by exactly one part, in the whole-file walk's order.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MBOX_PATH = join(REPO, "test-corpus", "mailbox.mbox");
const PST_PATH = join(REPO, "test-corpus", "mailbox.pst");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const key = (m: MboxMessage) => `${m.offset} ${m.length} ${m.truncated} ${m.tooLarge ?? false} ${m.fromLine} ${sha(m.bytes)}`;

async function* fromBuffer(b: Buffer, start: number): AsyncGenerator<Buffer> {
  for (let i = start; i < b.length; i += 97) yield b.subarray(i, Math.min(b.length, i + 97));
}

async function whole(b: Buffer, maxMessageBytes?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const m of readMbox(fromBuffer(b, 0), maxMessageBytes ? { maxMessageBytes } : {})) out.push(key(m));
  return out;
}

async function byParts(b: Buffer, partBytes: number, maxMessageBytes?: number): Promise<string[]> {
  const out: string[] = [];
  for (const range of planMboxParts(b.length, partBytes)) {
    for await (const m of readMboxPart((start) => fromBuffer(b, start), range, maxMessageBytes ? { maxMessageBytes } : {})) out.push(key(m));
  }
  return out;
}

// CRLF line ends, a body line that starts with "From " without a time, an escaped ">From ", an empty
// line followed by a "From " line with a time inside the body (a message start by the rule), a message
// above the size limit, and a last line cut short.
const TRICKY = Buffer.from([
  "From a@fake.test Thu Mar  4 10:11:12 2021\r\nSubject: one\r\n\r\nFrom the start of a body line, no time here\r\n>From escaped\r\n\r\n",
  "From b@fake.test Fri Mar  5 09:00:00 2021\r\nSubject: two\r\n\r\nshort\r\n\r\n",
  "From c@fake.test Sat Mar  6 08:00:00 2021\r\nSubject: three is long\r\n\r\n" + "x".repeat(900) + "\r\n\r\n",
  "From d@fake.test Sun Mar  7 07:00:00 2021\r\nSubject: four\r\n\r\ncut here without a line end",
].join(""));

describe("tools/ingest-cli — BIGDATA-4 mailbox parts", () => {
  it("MBOX parts of any size read every message exactly once, with the whole-file reader's offsets and bytes", async () => {
    const file = readFileSync(MBOX_PATH);
    const expected = await whole(file);
    expect(expected.length).toBe(6);
    for (const size of [1, 2, 3, 7, 50, 97, 256, 1000, 4096, file.length, file.length * 2]) {
      expect(await byParts(file, size), `part size ${size}`).toEqual(expected);
    }
    const tricky = await whole(TRICKY, 600);
    expect(tricky.length).toBe(4);
    for (const size of [1, 5, 40, 64, 120, 333, TRICKY.length]) {
      expect(await byParts(TRICKY, size, 600), `tricky, part size ${size}`).toEqual(tricky);
    }
  });

  it("MBOX parts: the ranges cover the file end to end, and only the first part can find a file that is not an mbox", async () => {
    expect(planMboxParts(10, 4)).toEqual([{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 10 }]);
    expect(planMboxParts(8, 4)).toEqual([{ start: 0, end: 4 }, { start: 4, end: 8 }]);
    expect(planMboxParts(0, 4)).toEqual([{ start: 0, end: 0 }]);
    const notMbox = Buffer.from("Fake notes, not a mailbox.\nNo From line starts this file.\n");
    const parts = planMboxParts(notMbox.length, 20);
    const read = async (i: number) => {
      const out: MboxMessage[] = [];
      for await (const m of readMboxPart((s) => fromBuffer(notMbox, s), parts[i]!, {})) out.push(m);
      return out;
    };
    await expect(read(0)).rejects.toBeInstanceOf(NotAnMboxError);
    await expect(read(1)).resolves.toEqual([]);
  });

  it("PST parts read every message exactly once, in the whole-file walk's order", async () => {
    const walked = (() => {
      const { file } = openPst(PST_PATH);
      try {
        const out: string[] = [];
        for (const e of walkPst(file)) out.push(e.kind === "message" ? `${e.folder.join("/")} ${e.nid}` : `${e.kind} ${e.folder.join("/")}`);
        return out;
      } finally {
        file.close();
      }
    })();
    expect(walked.filter((w) => !w.startsWith("folder-skipped") && !w.startsWith("error")).length).toBeGreaterThanOrEqual(6);
    for (const perPart of [1, 2, 3, 50]) {
      const { file } = openPst(PST_PATH);
      try {
        const plan = planPstParts(file, perPart);
        const out: string[] = [...plan.skipped.map((s) => `folder-skipped ${s.folder.join("/")}`)];
        const read: string[] = [];
        for (const part of plan.parts) {
          expect(part.count).toBeLessThanOrEqual(perPart);
          for (const e of readPstPart(file, part)) read.push(e.kind === "message" ? `${e.folder.join("/")} ${e.nid}` : `${e.kind} ${e.folder.join("/")}`);
        }
        expect(read, `messages per part ${perPart}`).toEqual(walked.filter((w) => !w.startsWith("folder-skipped")));
        expect(out.sort()).toEqual(walked.filter((w) => w.startsWith("folder-skipped")).sort());
      } finally {
        file.close();
      }
    }
  });
});
