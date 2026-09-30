/**
 * MBOX, read message by message from a stream (BIGDATA-3B, D109). No library: mbox-reader (MIT,
 * maintained) was checked; it rewrites every line ending to "\n" and gives no byte offsets, and
 * the ingest needs each message's exact bytes and where it starts (its locator, `offset:<n>`). This
 * reader holds one message at a time, never the file.
 *
 * The format (RFC 4155): each message starts with a "From " line ("From <sender> <date>", the date
 * with a time of day) at the start of the file or after an empty line; the message is the lines up to the empty line before
 * the next "From " line. Lines of the message that start with "From " were written as ">From "
 * (mboxrd also escapes ">From " as ">>From "): one '>' is taken off every line matching
 * /^>+From /. That is exact for mboxrd; for mboxo a line that really started with ">From " comes
 * back as "From ", which cannot be told apart (the stored mailbox file keeps the original bytes).
 * Line endings are kept as they are (LF or CRLF).
 */

export interface MboxMessage {
  /** Byte offset of the message's "From " line in the file. */
  offset: number;
  /** Bytes from the "From " line to the end of the message (the separator line not included). */
  length: number;
  /** The "From " line, without its line ending. */
  fromLine: string;
  /** The message as RFC 5322 bytes: after the "From " line, unescaped. */
  bytes: Buffer;
  /** True when the file ends inside this message (not after a complete last line). */
  truncated: boolean;
  /** Set when the message is above `maxMessageBytes`: its bytes were not kept. */
  tooLarge?: boolean;
}

export class NotAnMboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAnMboxError";
  }
}

// "From <sender> <date>": the date always has a time (asctime: "Thu Mar  4 10:11:12 2021"). Asking
// for the time keeps an unescaped body line such as "From here on ..." after an empty line from
// being taken for the start of a message.
const FROM_LINE = /^From \S+ .*\b\d{1,2}:\d{2}(:\d{2})?\b/;
const ESCAPED_FROM = /^>+From /;

/** True when these first bytes of a file start like an mbox: a "From <sender> <date>" line. */
export function looksLikeMbox(head: Buffer): boolean {
  const nl = head.indexOf(0x0a);
  const first = head.subarray(0, nl < 0 ? Math.min(head.length, 1000) : nl).toString("latin1").replace(/\r$/, "");
  return FROM_LINE.test(first);
}

/**
 * The messages of an mbox stream, in order. Throws NotAnMboxError when the stream does not start
 * with a "From " line. A message above `maxMessageBytes` is still yielded (with its offset and
 * length) but without its bytes, and `tooLarge` set.
 */
export async function* readMbox(chunks: AsyncIterable<Buffer | string> | Iterable<Buffer | string>, opts: { maxMessageBytes?: number } = {}): AsyncGenerator<MboxMessage> {
  const maxBytes = opts.maxMessageBytes ?? Number.MAX_SAFE_INTEGER;
  let pending: Buffer = Buffer.alloc(0);
  let pos = 0; // absolute offset of `pending`'s first byte
  let current: { offset: number; fromLine: string; lines: Buffer[]; size: number; tooLarge: boolean; lastBlank: boolean; blankLen: number } | null = null;
  let sawFirst = false;
  let prevBlank = true; // the start of the file counts as "after an empty line"
  let lastLineComplete = true;

  const finish = (end: number, truncated: boolean): MboxMessage => {
    const c = current!;
    // The empty line before the next "From " line separates messages: it is not part of this one.
    let lines = c.lines;
    let length = end - c.offset;
    if (c.lastBlank && !truncated) {
      lines = lines.slice(0, -1);
      length -= c.blankLen;
    }
    const bytes = c.tooLarge ? Buffer.alloc(0) : Buffer.concat(lines);
    return { offset: c.offset, length, fromLine: c.fromLine, bytes, truncated, ...(c.tooLarge ? { tooLarge: true } : {}) };
  };

  const onLine = function* (line: Buffer, lineStart: number, complete: boolean): Generator<MboxMessage> {
    const text = line.subarray(0, Math.min(line.length, 1000)).toString("latin1");
    const bare = text.replace(/\r?\n$/, "");
    const isBlank = bare === "" || bare === "\r";
    if (prevBlank && complete && FROM_LINE.test(bare)) {
      if (current) yield finish(lineStart, false);
      sawFirst = true;
      current = { offset: lineStart, fromLine: bare.replace(/\r$/, ""), lines: [], size: line.length, tooLarge: false, lastBlank: false, blankLen: 0 };
      prevBlank = false;
      return;
    }
    if (!sawFirst) throw new NotAnMboxError("not an mbox file: it does not start with a 'From ' line");
    const c = current!;
    c.size += line.length;
    if (!c.tooLarge) {
      if (c.size > maxBytes) {
        c.tooLarge = true;
        c.lines = [];
      } else {
        c.lines.push(ESCAPED_FROM.test(text) ? line.subarray(1) : line);
      }
    }
    c.lastBlank = isBlank && complete;
    c.blankLen = line.length;
    prevBlank = isBlank && complete;
  };

  for await (const chunk of chunks) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    pending = pending.length ? Buffer.concat([pending, buf]) : buf;
    let start = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, start);
      if (nl < 0) break;
      yield* onLine(pending.subarray(start, nl + 1), pos + start, true);
      start = nl + 1;
    }
    pos += start;
    pending = pending.subarray(start);
  }
  if (pending.length > 0) {
    // The file ends without a line ending: its last line is cut.
    lastLineComplete = false;
    yield* onLine(pending, pos, false);
    pos += pending.length;
  }
  if (!sawFirst) throw new NotAnMboxError("not an mbox file: it is empty or has no 'From ' line");
  if (current) yield finish(pos, !lastLineComplete);
}
