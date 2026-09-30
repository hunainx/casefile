import { describe, it, expect } from "vitest";
import { readMbox, looksLikeMbox, NotAnMboxError, type MboxMessage } from "../src/mbox.js";
import { encodeFolderName, decodeFolderName, messagePath, parseMessageSegment, pstLocator, mboxLocator, subjectFileStem } from "../src/mailbox-paths.js";

/**
 * BIGDATA-3B (D109): the MBOX reader. Messages are split at a "From " line that starts the file or
 * follows an empty line; each keeps its exact bytes and line endings, its offset, and the
 * ">From " escaping is undone; a file that ends inside a message says so; a file that is not an
 * mbox is refused before any message.
 */

async function* chunked(b: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
async function all(b: Buffer, size = 1 << 16, maxMessageBytes?: number): Promise<MboxMessage[]> {
  const out: MboxMessage[] = [];
  for await (const m of readMbox(chunked(b, size), maxMessageBytes ? { maxMessageBytes } : {})) out.push(m);
  return out;
}

const MSG_A = "From: a@example.com\nSubject: one\n\nFirst fake body.\n>From the minutes: a line that began with From.\n>>From twice escaped.\n";
const MSG_B = "From: b@example.org\nSubject: two\n\nFrom here a line that is not after an empty line is text.\n";
const FILE = `From a@example.com Thu Mar  4 10:11:12 2021\n${MSG_A}\nFrom b@example.org Fri Mar  5 09:00:00 2021\n${MSG_B}\n`;

describe("mbox reader (BIGDATA-3B)", () => {
  it("splits at 'From ' lines after an empty line, with each message's offset and bytes", async () => {
    const msgs = await all(Buffer.from(FILE));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.offset).toBe(0);
    expect(msgs[1]!.offset).toBe(FILE.indexOf("From b@example.org"));
    expect(msgs[0]!.fromLine).toBe("From a@example.com Thu Mar  4 10:11:12 2021");
    expect(msgs.map((m) => m.truncated)).toEqual([false, false]);
  });

  it("undoes the mboxrd escaping: one '>' comes off every line that matches /^>+From /", async () => {
    const [a] = await all(Buffer.from(FILE));
    const text = a!.bytes.toString("utf8");
    expect(text).toContain("\nFrom the minutes: a line that began with From.\n");
    expect(text).toContain("\n>From twice escaped.\n");
    expect(text).not.toContain(">>From");
  });

  it("does not split at a 'From ' line that does not follow an empty line", async () => {
    const [, b] = await all(Buffer.from(FILE));
    expect(b!.bytes.toString("utf8")).toBe(MSG_B);
  });

  it("gives the message without the separator line, and the same result whatever the chunk size (1 byte to 64 KiB)", async () => {
    const expected = (await all(Buffer.from(FILE))).map((m) => [m.offset, m.length, m.bytes.toString("latin1")]);
    expect(expected[0]![2]).toBe(MSG_A.replace(">From the minutes", "From the minutes").replace(">>From twice", ">From twice"));
    for (const size of [1, 2, 7, 64, 1 << 16]) {
      expect((await all(Buffer.from(FILE), size)).map((m) => [m.offset, m.length, m.bytes.toString("latin1")]), `chunk size ${size}`).toEqual(expected);
    }
  });

  it("keeps CRLF line endings as they are", async () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const msgs = await all(Buffer.from(crlf));
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.offset).toBe(crlf.indexOf("From b@example.org"));
    expect(msgs[1]!.bytes.toString("latin1")).toBe(MSG_B.replace(/\n/g, "\r\n"));
  });

  it("marks the last message truncated when the file ends inside a line", async () => {
    const cut = FILE.slice(0, FILE.indexOf("that is not after") + 4);
    const msgs = await all(Buffer.from(cut));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.truncated).toBe(false);
    expect(msgs[1]!.truncated).toBe(true);
    expect(msgs[1]!.bytes.toString("latin1")).toBe(cut.slice(cut.indexOf("From: b@")));
  });

  it("refuses a file that does not start with a 'From ' line, before yielding anything", async () => {
    await expect(all(Buffer.from("Just some text\nFrom a@example.com Thu Mar  4 10:11:12 2021\n"))).rejects.toBeInstanceOf(NotAnMboxError);
    await expect(all(Buffer.from(""))).rejects.toBeInstanceOf(NotAnMboxError);
    expect(looksLikeMbox(Buffer.from(FILE))).toBe(true);
    expect(looksLikeMbox(Buffer.from("From: a@example.com\n"))).toBe(false);
  });

  it("yields a message above the size limit with its offset and length but without its bytes", async () => {
    const msgs = await all(Buffer.from(FILE), 1 << 16, 60);
    expect(msgs[0]!.tooLarge).toBe(true);
    expect(msgs[0]!.bytes.length).toBe(0);
    expect(msgs[0]!.length).toBe(FILE.indexOf("From b@example.org") - 1);
    expect(msgs[1]!.offset).toBe(FILE.indexOf("From b@example.org"));
  });
});

describe("mailbox message paths (BIGDATA-3B, D108)", () => {
  it("encodes '%', '#' and '/' in folder names so a path splits back into the same folders", () => {
    const folder = ["Inbox", "Q1/Q2 Reports", "Case #12", "100% done"];
    const p = messagePath("D:/x/carol.pst", folder, pstLocator(0x200024));
    expect(p).toBe("D:/x/carol.pst#mailbox:Inbox/Q1%2FQ2 Reports/Case %2312/100%25 done/nid:0x00200024");
    expect(p.split("#")).toHaveLength(2);
    expect(parseMessageSegment(p.split("#")[1]!)).toEqual({ folder, locator: { kind: "nid", nid: 0x200024 } });
    expect(folder.map(encodeFolderName).map(decodeFolderName)).toEqual(folder);
  });

  it("names an MBOX message by its offset, with no folder", () => {
    const p = messagePath("a.mbox", [], mboxLocator(1234));
    expect(p).toBe("a.mbox#mailbox:offset:1234");
    expect(parseMessageSegment("mailbox:offset:1234")).toEqual({ folder: [], locator: { kind: "offset", offset: 1234 } });
    expect(parseMessageSegment("attachment:x.pdf")).toBeNull();
  });

  it("makes a file name of a subject without path separators or '#'", () => {
    expect(subjectFileStem("RE: Case #12 / hearing?")).toBe("RE_ Case _12 _ hearing_");
    expect(subjectFileStem("   ")).toBe("(no subject)");
  });
});
