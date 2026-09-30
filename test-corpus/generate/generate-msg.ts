/**
 * Regenerates test-corpus/message.msg: a synthetic Outlook message with one recipient
 * and one child attachment (image429c36.PNG). All names and addresses are fictional.
 *
 *   npx tsx test-corpus/generate/generate-msg.ts
 *
 * The file is an [MS-OXMSG] compound file written with the CFB burner that ships in
 * @kenjiuno/msgreader, the same library the parser reads it with.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { burn, type Entry } from "@kenjiuno/msgreader/lib/Burner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "message.msg");

const DIRECTORY = 1;
const DOCUMENT = 2;
const ROOT = 5;

const PT_LONG = 0x0003;
const PT_SYSTIME = 0x0040;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;

const utf16 = (s: string) => Buffer.from(s, "utf16le");

/** FILETIME: 100ns intervals since 1601-01-01. */
function filetime(date: Date): Buffer {
  const ft = BigInt(date.getTime()) * 10000n + 116444736000000000n;
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(ft);
  return b;
}

interface Prop {
  id: number;
  type: number;
  value: Buffer | number;
}

function substgName(p: Prop): string {
  return `__substg1.0_${p.id.toString(16).padStart(4, "0").toUpperCase()}${p.type.toString(16).padStart(4, "0").toUpperCase()}`;
}

/** [MS-OXMSG] 2.4 property stream: header, then one 16-byte entry per property. */
function propertyStream(props: Prop[], header: Buffer): Buffer {
  const entries = props.map((p) => {
    const e = Buffer.alloc(16);
    e.writeUInt32LE(((p.id << 16) | p.type) >>> 0, 0);
    e.writeUInt32LE(0x00000006, 4); // PROPATTR_READABLE | PROPATTR_WRITABLE
    if (p.type === PT_LONG) e.writeUInt32LE(p.value as number, 8);
    else if (p.type === PT_SYSTIME) (p.value as Buffer).copy(e, 8);
    else {
      // Variable-length: size of the value stream (+2 for the UTF-16 terminator).
      const len = (p.value as Buffer).length + (p.type === PT_UNICODE ? 2 : 0);
      e.writeUInt32LE(len, 8);
    }
    return e;
  });
  return Buffer.concat([header, ...entries]);
}

const entries: Entry[] = [];
function add(entry: Entry): number {
  entries.push(entry);
  return entries.length - 1;
}
function doc(parent: number, name: string, data: Buffer): void {
  // Copy out of Node's shared Buffer pool: the burner reads the whole backing store.
  const bytes = new Uint8Array(data);
  const idx = add({ name, type: DOCUMENT, length: bytes.length, binaryProvider: () => bytes });
  entries[parent]!.children!.push(idx);
}
function dir(parent: number, name: string): number {
  const idx = add({ name, type: DIRECTORY, length: 0, children: [] });
  entries[parent]!.children!.push(idx);
  return idx;
}
function writeProps(parent: number, props: Prop[], header: Buffer): void {
  for (const p of props) {
    if (p.type === PT_UNICODE || p.type === PT_BINARY) doc(parent, substgName(p), p.value as Buffer);
  }
  doc(parent, "__properties_version1.0", propertyStream(props, header));
}

const sent = new Date(Date.UTC(2026, 0, 16, 9, 15, 0));
const body =
  "Jane,\r\n\r\n" +
  "Confirming receipt of the signed services agreement. Our logo is attached for the cover page " +
  "of the joint inventory report. The first weekly count will go to Mary Major on Monday.\r\n\r\n" +
  "Best,\r\nJohn Roe\r\nExample Corp.\r\n456 Sample Avenue, Exampleville, EX 00000\r\n\r\n" +
  "FICTIONAL DOCUMENT FOR SOFTWARE TESTING. ALL NAMES AND FACTS ARE INVENTED.\r\n";

const root = add({ name: "Root Entry", type: ROOT, length: 0, children: [] });

// Top-level header: 8 reserved, next recipient id, next attachment id, recipient count,
// attachment count, 8 reserved.
const topHeader = Buffer.alloc(32);
topHeader.writeUInt32LE(1, 8);
topHeader.writeUInt32LE(1, 12);
topHeader.writeUInt32LE(1, 16);
topHeader.writeUInt32LE(1, 20);

writeProps(
  root,
  [
    { id: 0x001a, type: PT_UNICODE, value: utf16("IPM.Note") },
    { id: 0x0037, type: PT_UNICODE, value: utf16("Signed services agreement - Example Corp. / Acme Holdings") },
    { id: 0x0c1a, type: PT_UNICODE, value: utf16("John Roe") },
    { id: 0x0c1e, type: PT_UNICODE, value: utf16("SMTP") },
    { id: 0x0c1f, type: PT_UNICODE, value: utf16("john.roe@example.com") },
    { id: 0x5d01, type: PT_UNICODE, value: utf16("john.roe@example.com") },
    { id: 0x0e04, type: PT_UNICODE, value: utf16("Jane Doe") },
    { id: 0x1000, type: PT_UNICODE, value: utf16(body) },
    { id: 0x1035, type: PT_UNICODE, value: utf16("<20260116091500.0002@example.com>") },
    { id: 0x0039, type: PT_SYSTIME, value: filetime(sent) },
    { id: 0x0e06, type: PT_SYSTIME, value: filetime(sent) },
  ],
  topHeader,
);

// Named-property mapping storage is mandatory in a .msg even when empty.
const nameid = dir(root, "__nameid_version1.0");
doc(nameid, "__substg1.0_00020102", Buffer.alloc(0));
doc(nameid, "__substg1.0_00030102", Buffer.alloc(0));
doc(nameid, "__substg1.0_00040102", Buffer.alloc(0));

const recip = dir(root, "__recip_version1.0_#00000000");
writeProps(
  recip,
  [
    { id: 0x0c15, type: PT_LONG, value: 1 }, // MAPI_TO
    { id: 0x3001, type: PT_UNICODE, value: utf16("Jane Doe") },
    { id: 0x3002, type: PT_UNICODE, value: utf16("SMTP") },
    { id: 0x3003, type: PT_UNICODE, value: utf16("jane.doe@acme-holdings.example") },
    { id: 0x39fe, type: PT_UNICODE, value: utf16("jane.doe@acme-holdings.example") },
  ],
  Buffer.alloc(8),
);

const png = readFileSync(resolve(HERE, "msg-attachment.png"));
const attach = dir(root, "__attach_version1.0_#00000000");
writeProps(
  attach,
  [
    { id: 0x3705, type: PT_LONG, value: 1 }, // ATTACH_BY_VALUE
    { id: 0x3701, type: PT_BINARY, value: png },
    { id: 0x3704, type: PT_UNICODE, value: utf16("IMAGE4~1.PNG") },
    { id: 0x3707, type: PT_UNICODE, value: utf16("image429c36.PNG") },
    { id: 0x3001, type: PT_UNICODE, value: utf16("image429c36.PNG") },
    { id: 0x3703, type: PT_UNICODE, value: utf16(".PNG") },
    { id: 0x370e, type: PT_UNICODE, value: utf16("image/png") },
  ],
  Buffer.alloc(8),
);

writeFileSync(OUT, Buffer.from(burn(entries)));
process.stdout.write(`wrote ${OUT}\n`);
