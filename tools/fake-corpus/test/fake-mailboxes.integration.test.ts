import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateMailboxes, MAILBOX_MANIFEST_FILE, type MailboxSummary } from "../src/mailboxes.js";
import { parseSize } from "../src/generate.js";
import { MARKER_PREFIX } from "../src/marker.js";
import { readMbox } from "../../ingest-cli/src/mbox.js";

/**
 * BIGDATA-3B: `pnpm fake-corpus --kind mbox --size <n>` writes one fake MBOX and a manifest of
 * every message (its path as the ingest names it: <mailbox>#mailbox:offset:<n>) and attachment,
 * and of which messages are copies of which (group) or sent again (near_duplicate_of). The PST
 * kinds need Windows (the PST writer); this test covers the MBOX kind, which runs anywhere.
 */

interface Row {
  path: string;
  kind: string;
  group: string;
  message_id: string;
  date: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  near_duplicate_of: string;
}
function manifest(dir: string): Row[] {
  const text = readFileSync(join(dir, MAILBOX_MANIFEST_FILE), "utf8").trimEnd().split("\n");
  const header = text[0]!.split(",");
  return text.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    const get = (k: string) => cells[header.indexOf(k)] ?? "";
    return {
      path: get("path"), kind: get("kind"), group: get("group"), message_id: get("message_id"), date: get("date"), from: get("from"),
      to: get("to"), cc: get("cc"), bcc: get("bcc"), subject: get("subject"), near_duplicate_of: get("near_duplicate_of"),
    };
  });
}

describe("fake-corpus generator — mailboxes (MBOX)", () => {
  const base = mkdtempSync(join(tmpdir(), "casefile-fake-mailboxes-test-"));
  const outA = join(base, "a");
  const outB = join(base, "b");
  let a: MailboxSummary;
  let rows: Row[];

  beforeAll(async () => {
    a = await generateMailboxes({ kind: "mbox", seed: 7, outDir: outA, sizeBytes: parseSize("4MB") });
    await generateMailboxes({ kind: "mbox", seed: 7, outDir: outB, sizeBytes: parseSize("4MB") });
    rows = manifest(outA);
  }, 240_000);

  it("the same seed gives the same MBOX, byte for byte, and the same manifest", () => {
    const f = "corpus/Big/big.mbox";
    expect(readFileSync(join(outA, f)).equals(readFileSync(join(outB, f)))).toBe(true);
    expect(readFileSync(join(outA, MAILBOX_MANIFEST_FILE)).equals(readFileSync(join(outB, MAILBOX_MANIFEST_FILE)))).toBe(true);
    expect(a.bytes).toBeGreaterThanOrEqual(parseSize("4MB"));
  });

  it("names every message at the byte offset where its 'From ' line starts, and lists them all", async () => {
    const file = readFileSync(join(outA, "corpus/Big/big.mbox"));
    const read: number[] = [];
    for await (const m of readMbox([file])) read.push(m.offset);
    const listed = rows.filter((r) => r.kind === "message").map((r) => Number(r.path.split("#mailbox:offset:")[1]));
    expect(listed).toEqual(read);
    expect(listed.length).toBe(a.messages);
    for (const off of listed) expect(file.subarray(off, off + 5).toString()).toBe("From ");
  });

  it("gives copies of one message (a group) the same headers and text, and marks some as copies and some as sent again", async () => {
    const file = readFileSync(join(outA, "corpus/Big/big.mbox"));
    const byGroup = new Map<string, Row[]>();
    for (const r of rows.filter((x) => x.kind === "message")) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
    const copies = [...byGroup.values()].filter((g) => g.length > 1);
    expect(copies.length).toBeGreaterThan(0);
    const body = async (r: Row) => {
      const off = Number(r.path.split("offset:")[1]);
      for await (const m of readMbox([file.subarray(off)])) return m.bytes.toString("latin1").replace(/^X-Casefile-Fake-Mailbox-Copy:.*$/m, "");
      return "";
    };
    for (const g of copies) {
      expect(new Set(g.map((r) => `${r.message_id}|${r.date}|${r.from}|${r.to}|${r.cc}|${r.bcc}|${r.subject}`)).size).toBe(1);
      const texts = await Promise.all(g.map(body));
      expect(new Set(texts).size).toBe(1);
    }
    const resent = rows.filter((r) => r.kind === "message" && r.near_duplicate_of !== "");
    expect(resent.length).toBeGreaterThan(0);
    for (const r of resent) expect(rows.find((x) => x.path === r.near_duplicate_of)?.subject).toBe(r.subject);
  });

  it("marks every message as fake (the corpus marker is in each one's headers)", () => {
    const file = readFileSync(join(outA, "corpus/Big/big.mbox")).toString("latin1");
    expect(file.split(`X-Casefile-Fake-Corpus: ${MARKER_PREFIX}`).length - 1).toBeGreaterThanOrEqual(a.messages);
  });
});
