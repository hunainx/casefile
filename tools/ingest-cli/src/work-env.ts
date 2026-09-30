import type postgres from "postgres";
import type { Tx } from "@casefile/db";
import type { ZipGuardOptions } from "../../../apps/api/src/services/document-parsers.js";
import type { RecordContext } from "./triage.js";
import type { TriageFilters } from "./triage-rules.js";
import type { RunState } from "./ingest.js";
import type { PlanNode } from "./plan.js";
import type { WorkItem, WorkState } from "./queue.js";

/**
 * BIGDATA-4: the settings every worker of a run uses (ingest_runs.options), so two workers can
 * never read or split the same object differently.
 */
export interface RunOptions {
  /** Files above this are stored and hashed by streaming, not parsed (D93). */
  max_parse_bytes: number;
  zip?: ZipGuardOptions | undefined;
  /** A PST or OST is split into parts of this many messages. */
  pst_part_messages: number;
  /** An MBOX is split into parts of this many bytes. */
  mbox_part_bytes: number;
}

export const DEFAULT_PST_PART_MESSAGES = 50;
export const DEFAULT_MBOX_PART_BYTES = 16 * 1024 * 1024;

export interface RunInfo {
  runId: string;
  sourceKind: "folder" | "bucket";
  /** Bucket mode: the bucket every object of the run is in. */
  bucket: string | null;
  filters: TriageFilters;
  options: RunOptions;
  bucketSources: string;
  bucketArtifacts: string;
}

export type WorkerActivity = "idle" | "discovering" | "waiting" | "writing" | "indexing";

/** What a worker gives the code that works one item. */
export interface WorkEnv {
  db: postgres.Sql;
  rec: RecordContext;
  run: RunInfo;
  /** The decisions and signatures of the transaction being written. */
  state: RunState;
  workerName: string;
  /** Runs `fn` behind the item's fence (queue.withFence), timing how long it held the audit chain. */
  fenced<T>(item: WorkItem, fn: (tx: Tx, row: { state: WorkState; progress: number; decide_version: number }) => Promise<T>): Promise<T>;
  /**
   * Waits until every copy the given nodes are duplicates of is written (their rows reference it).
   * False when the item's decisions changed meanwhile (the sequencer went back after a failure).
   */
  waitForHolders(item: WorkItem, nodes: PlanNode[], version: number): Promise<boolean>;
  setActivity(state: WorkerActivity, text: string): void;
  onMailboxProgress?: ((path: string, messagesRead: number) => void) | undefined;
}
