/**
 * How a message inside a mailbox file is named (BIGDATA-3B, D108). The name is the path the ingest
 * records for the message (sources.metadata.source_path, ingest_decisions.path), the path
 * `pnpm ingest:report` lists and the path `pnpm ingest:include --path` takes:
 *
 *   <mailbox file>#mailbox:<folder>/<folder>/.../<locator>
 *
 *   - the folders are the mailbox's own folder path (a PST's Inbox/Projects/...; an MBOX file has
 *     none), each name with '%', '#' and '/' percent-encoded so the path can be split again;
 *   - the locator finds the message in the file: `nid:0x00200024` (a PST or OST node id) or
 *     `offset:123456` (the byte offset of an MBOX message's "From " line).
 * An attachment of the message follows as `#attachment:<file name>`, as for an .eml today.
 */

export const MAILBOX_SEGMENT_PREFIX = "mailbox:";

export function encodeFolderName(name: string): string {
  return name.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\//g, "%2F");
}

export function decodeFolderName(name: string): string {
  return name.replace(/%2F/gi, "/").replace(/%23/g, "#").replace(/%25/g, "%");
}

export const pstLocator = (nid: number): string => `nid:0x${nid.toString(16).padStart(8, "0")}`;
export const mboxLocator = (offset: number): string => `offset:${offset}`;

/** The `mailbox:...` segment of a message's path. */
export function messageSegment(folder: readonly string[], locator: string): string {
  return MAILBOX_SEGMENT_PREFIX + [...folder.map(encodeFolderName), locator].join("/");
}

export function messagePath(mailboxPath: string, folder: readonly string[], locator: string): string {
  return `${mailboxPath}#${messageSegment(folder, locator)}`;
}

export type MessageLocator = { kind: "nid"; nid: number } | { kind: "offset"; offset: number };

/** The folder path and locator of a `mailbox:...` segment, or null if it is not one. */
export function parseMessageSegment(segment: string): { folder: string[]; locator: MessageLocator } | null {
  if (!segment.startsWith(MAILBOX_SEGMENT_PREFIX)) return null;
  const parts = segment.slice(MAILBOX_SEGMENT_PREFIX.length).split("/");
  const last = parts.pop() ?? "";
  const nid = /^nid:0x([0-9a-f]{1,8})$/i.exec(last);
  const off = /^offset:(\d+)$/.exec(last);
  if (!nid && !off) return null;
  const locator: MessageLocator = nid ? { kind: "nid", nid: parseInt(nid[1]!, 16) } : { kind: "offset", offset: Number(off![1]) };
  return { folder: parts.filter((p) => p !== "").map(decodeFolderName), locator };
}

/** A file name made from a subject: no path separators, no '#' (paths split on it), at most 120 characters. */
export function subjectFileStem(subject: string): string {
  const s = subject
    // Control characters are not allowed in file names either.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|#\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, "");
  return s || "(no subject)";
}

/** The file name of a message's source: its subject, as an .eml. */
export const messageFileName = (subject: string): string => `${subjectFileStem(subject)}.eml`;

/** The file name an attached (embedded) message is given inside its parent message. */
export const attachedMessageFileName = (subject: string): string => `${subjectFileStem(subject)}.eml`;
