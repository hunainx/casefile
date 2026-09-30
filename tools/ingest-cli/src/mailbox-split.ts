import Long from "long";
import type { PSTFile, PSTFolder } from "pst-extractor";
import { PSTUtil } from "pst-extractor/dist/PSTUtil.class.js";
import { readMbox, type MboxMessage } from "./mbox.js";
import { childErrors, isPstFolder, isPstMessage, ipmSubtreeNid, type PstEntry } from "./pst.js";

/**
 * BIGDATA-4 (plan section 16): a big mailbox is split into parts, so one 50 GB PST does not hold one
 * worker for a day. Each part is a work item of its own; together the parts read every message of
 * the file exactly once, in the order the whole-file readers (BIGDATA-3B) read them.
 *
 *  - MBOX, by byte range: a part reads the messages whose "From " line starts inside its range. The
 *    first message start at or after the range's start is found with the whole-file reader's own
 *    rule (a "From " line with a time of day, at the start of the file or after an empty line, and a
 *    complete line), so the part that ends at an offset and the part that starts there agree on
 *    every message. The last message of a part may run past its end: it is read to its end.
 *  - PST/OST, by folder and message index: a part reads messages [start, start + count) of one
 *    folder's contents table, in the table's order, with the patched reader's error records (D110)
 *    for its own range only. Folders are planned in the whole-file walk's order (a folder's messages,
 *    then its sub-folders), so parts in order are the walk.
 */

export interface MboxRange {
  start: number;
  end: number;
}

/** Byte ranges of `partBytes` covering a file of `byteSize` bytes (one empty range for an empty file). */
export function planMboxParts(byteSize: number, partBytes: number): MboxRange[] {
  if (!(partBytes > 0)) throw new Error("the MBOX part size must be above 0 bytes");
  if (byteSize === 0) return [{ start: 0, end: 0 }];
  const out: MboxRange[] = [];
  for (let start = 0; start < byteSize; start += partBytes) out.push({ start, end: Math.min(byteSize, start + partBytes) });
  return out;
}

// The whole-file reader's "From " line rule (mbox.ts); the blank-line rule is the same too:
// a line that is empty once its "\r?\n" ending is taken off, or is a lone "\r".
const FROM_LINE = /^From \S+ .*\b\d{1,2}:\d{2}(:\d{2})?\b/;
const isBlankLine = (line: Buffer) => {
  const bare = line.subarray(0, Math.min(line.length, 1000)).toString("latin1").replace(/\r?\n$/, "");
  return bare === "" || bare === "\r";
};
const isFromLine = (line: Buffer) => FROM_LINE.test(line.subarray(0, Math.min(line.length, 1000)).toString("latin1").replace(/\r?\n$/, ""));

/**
 * The offset of the first message start at or after `start` and before `end`, or null. `open(o)`
 * streams the file from byte o. A blank line is at most 3 bytes ("\n", "\r\n", "\r\r\n"), so reading
 * from 4 bytes before `start` is enough to judge the line just before it.
 */
async function firstMessageStart(open: (start: number) => AsyncIterable<Buffer>, start: number, end: number): Promise<number | null> {
  const from = Math.max(0, start - 4);
  let pending: Buffer = Buffer.alloc(0);
  let pos = from; // absolute offset of pending[0]
  let lineStart: number | null = from === 0 ? 0 : null; // the first line start we can see
  let prevLine: Buffer | null = null; // the line before the current one, when we saw all of it
  let prevLineStart = -1;
  for await (const chunk of open(from)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let i = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, i);
      if (nl < 0) break;
      const absStart = pos + i;
      const line = pending.subarray(i, nl + 1);
      if (lineStart === null) {
        // The bytes before the first '\n' belong to a line that started before `from`: not a start.
        lineStart = pos + nl + 1;
        prevLine = null;
      } else {
        const blankBefore = absStart === 0 || (prevLine !== null && prevLineStart >= 0 && isBlankLine(prevLine));
        if (absStart >= start && blankBefore && isFromLine(line)) return absStart < end ? absStart : null;
        if (absStart >= end) return null;
        prevLine = line;
        prevLineStart = absStart;
      }
      i = nl + 1;
    }
    pos += i;
    pending = pending.subarray(i);
  }
  return null; // no complete "From " line after an empty line in the range (a cut last line is not one)
}

/**
 * The messages of an MBOX whose "From " line starts in `range`, with the same offsets, bytes and
 * flags as readMbox() gives them for the whole file. The first part (start 0) refuses a file that is
 * not an mbox (NotAnMboxError), as the whole-file reader does; a later part only finds no message.
 */
export async function* readMboxPart(open: (start: number) => AsyncIterable<Buffer>, range: MboxRange, opts: { maxMessageBytes?: number }): AsyncGenerator<MboxMessage> {
  const first = range.start === 0 ? 0 : await firstMessageStart(open, range.start, range.end);
  if (first === null || (first >= range.end && range.start !== 0)) return;
  for await (const m of readMbox(open(first), opts)) {
    const offset = m.offset + first;
    if (offset >= range.end && !(range.start === 0 && range.end === 0)) return;
    yield { ...m, offset };
  }
}

// ── PST / OST ────────────────────────────────────────────────────────────────

export interface PstPart {
  /** The folder's path below the top of the mailbox (Inbox/Projects/...), as walkPst names it. */
  folder: string[];
  folderNid: number;
  /** Messages [start, start + count) of the folder's contents table. */
  start: number;
  count: number;
}

/** What a PST holds, in the whole-file walk's order: runs of messages, and folders skipped or not listable. */
export type PstSegment =
  | ({ kind: "messages" } & PstPart)
  | { kind: "skipped"; folder: string[]; reason: string }
  | { kind: "error"; folder: string[]; reason: string };

export interface PstPlan {
  /** Everything below, in the walk's order (a folder's messages, then its sub-folders). */
  segments: PstSegment[];
  parts: PstPart[];
  /** Search folders: their items are links to messages in other folders (walkPst skips them too). */
  skipped: Array<{ folder: string[]; reason: string }>;
  /** Folders whose sub-folders could not be listed (walkPst's error entry, with no message). */
  errors: Array<{ folder: string[]; reason: string }>;
  messages: number;
}

const NID_TYPE_SEARCH_FOLDER = 0x03;

/** The parts of a PST: every folder's messages in parts of `perPart`, in the whole-file walk's order. */
export function planPstParts(file: PSTFile, perPart: number): PstPlan {
  if (!(perPart > 0)) throw new Error("the PST part size must be at least 1 message");
  const plan: PstPlan = { segments: [], parts: [], skipped: [], errors: [], messages: 0 };
  const ipmNid = ipmSubtreeNid(file);
  const walk = (folder: PSTFolder, path: string[]) => {
    const nid = folder.descriptorNodeId.toNumber();
    if ((nid & 0x1f) === NID_TYPE_SEARCH_FOLDER) {
      const skipped = { folder: path, reason: "search folder: its items are links to messages in other folders" };
      plan.skipped.push(skipped);
      plan.segments.push({ kind: "skipped", ...skipped });
      return;
    }
    const count = folder.contentCount;
    for (let start = 0; start < count; start += perPart) {
      const part = { folder: path, folderNid: nid, start, count: Math.min(perPart, count - start) };
      plan.parts.push(part);
      plan.segments.push({ kind: "messages", ...part });
    }
    plan.messages += Math.max(0, count);
    let subs: PSTFolder[] = [];
    try {
      subs = folder.hasSubfolders ? folder.getSubFolders() : [];
    } catch (err: unknown) {
      const e = { folder: path, reason: `the sub-folders could not be listed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
      plan.errors.push(e);
      plan.segments.push({ kind: "error", ...e });
    }
    for (const sub of subs) {
      const subNid = sub.descriptorNodeId.toNumber();
      walk(sub, subNid === ipmNid ? [] : [...path, sub.displayName]);
    }
  };
  walk(file.getRootFolder(), []);
  return plan;
}

const cursorOf = (folder: PSTFolder): number => Number(Reflect.get(folder, "currentEmailIndex"));

/**
 * The entries of one part: its messages, and the errors the reader records for messages of its
 * range, in the whole-file walk's order. pst-extractor's cursor skips an unreadable message by itself
 * (recording it), so a call may read past the part's end: what lies beyond the end belongs to the
 * next part and is not returned here.
 */
export function* readPstPart(file: PSTFile, part: PstPart): Generator<PstEntry> {
  const loaded: unknown = PSTUtil.detectAndLoadPSTObject(file, Long.fromNumber(part.folderNid));
  if (!isPstFolder(loaded)) {
    yield { kind: "error", folder: part.folder, nid: null, reason: `folder node 0x${part.folderNid.toString(16)} could not be loaded as a folder` };
    return;
  }
  const folder = loaded;
  const end = part.start + part.count;
  folder.moveChildCursorTo(part.start);
  let seen = 0;
  for (;;) {
    if (cursorOf(folder) >= end) return;
    let child: unknown;
    try {
      child = folder.getNextChild();
    } catch (err: unknown) {
      yield { kind: "error", folder: part.folder, nid: null, reason: `the folder's messages could not be listed after ${cursorOf(folder)}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
      return;
    }
    const errs = childErrors(folder);
    for (; seen < errs.length; seen++) {
      const e = errs[seen]!;
      if (e.index < part.start || e.index >= end) continue;
      yield { kind: "error", folder: part.folder, nid: e.nodeId, reason: `message ${e.index + 1} of ${folder.contentCount} could not be read: ${e.error.split("\n")[0]}` };
    }
    if (child === null || child === undefined) return;
    if (cursorOf(folder) - 1 >= end) return; // the next part's first message
    if (isPstMessage(child)) yield { kind: "message", folder: part.folder, nid: child.descriptorNodeId.toNumber(), message: child };
  }
}
