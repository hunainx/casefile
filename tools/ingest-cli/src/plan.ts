import type { ParsedEmailResult } from "../../../apps/api/src/services/document-parsers.js";
import type { FilterRecord } from "./triage-rules.js";

/**
 * BIGDATA-4 (plan section 16): what discovery finds in one work item, as a tree in reading order
 * (the object, then what it contains, recursively; a mailbox part's messages in the file's order),
 * and what the sequencer decides for each node. The tree is kept in the worker's memory between
 * discovery and the write (with the bytes and parsed emails, so nothing is read or parsed twice);
 * each node is also an ingest_nodes row, which is what the sequencer reads and writes.
 */

/** What the rules that look only at the node itself decide (they do not depend on any other copy). */
export type NodeLocal =
  /** A junk name, an empty file, or one of the owner's filters: a skip decision of the ingest stage. */
  | { skip: { decision: "skip-junk" | "skip-filter"; rule: string; rule_version: number; reason: string; filter: FilterRecord | null } }
  /** Not readable (a mailbox entry the reader could not read, a message that is not an email): a failure row. */
  | { error: string }
  /** Writing it will throw this (a zip bomb): the nearest email around it keeps going, anything else fails the item. */
  | { throws: string };

export type DecisionKind = "ingest" | "link" | "skip-duplicate" | "skip-junk" | "skip-filter" | "not-reached" | "error" | "void";

export interface NodeDecision {
  decision: DecisionKind;
  /** ingest: the source id the write will use; link: the existing source. */
  sourceId: string | null;
  duplicateRule: "exact-duplicate" | "message-duplicate" | null;
  duplicateOfPath: string | null;
  duplicateOfSourceId: string | null;
}

export interface PlanNode {
  /** Pre-order position in the item: the item's order key is (top_seq, part_no, entry_index, index). */
  index: number;
  parentIndex: number | null;
  /** In a mailbox part: which of the part's entries the node belongs to (else 0). */
  entryIndex: number;
  depth: number;
  path: string;
  fileName: string;
  byteSize: number;
  sha256: string | null;
  messageHash: string | null;
  kind: "file" | "message" | "error";
  local: NodeLocal | null;
  children: PlanNode[];
  // In memory only (never stored): what the write needs, so nothing is read twice.
  bytes?: Buffer | undefined;
  email?: ParsedEmailResult | undefined;
  emailFailed?: string | undefined;
  zip?: { entries: Array<{ filename: string; path: string; content: Buffer; byteSize: number; depth: number; modified?: Date | null | undefined }> } | undefined;
  zipError?: unknown;
  zipFailed?: string | undefined;
  entryModified?: Date | null | undefined;
  /** Mailbox entries: the message's own facts (offset, node id, transport headers, attachments not read ...). */
  entry?: { folder: string[]; locator: string; rendered: boolean; meta: Record<string, unknown>; truncated: boolean } | undefined;
  /**
   * An error entry of a mailbox: whether it gets a source.ingest_failed row (the reader stopping part
   * way has none, as in BIGDATA-3B), whether it counts as an unreadable message, and where it says
   * reading stopped.
   */
  errorInfo?: { row: boolean; countsAsMessage: boolean; stoppedAt?: string | undefined } | undefined;
  decision?: NodeDecision | undefined;
}

/** The nodes of one or more roots, in pre-order. */
export function preorder(roots: readonly PlanNode[]): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (n: PlanNode) => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** A stable description of a node, to check that a second discovery of an item found the same nodes. */
export function nodeSignature(n: Pick<PlanNode, "index" | "parentIndex" | "entryIndex" | "path" | "byteSize" | "sha256" | "messageHash" | "kind">): string {
  return [n.index, n.parentIndex ?? "", n.entryIndex, n.path, n.byteSize, n.sha256 ?? "", n.messageHash ?? "", n.kind].join("|");
}
