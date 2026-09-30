import { writeAuditEvent, writeAuditEvents, type AuditEventInput } from "@casefile/audit";
import type { Tx } from "@casefile/db";

/**
 * BIGDATA-4 (plan answer 10): the audit rows of a worker's item transaction are written LAST, in
 * one step (writeAuditEvents: one lock of the tenant's chain head, one INSERT, one head update), just
 * before the transaction commits. The rows, their order, their seq and their hashes are the ones
 * writing them one by one would give (the same events, in the order they happened, in the same
 * transaction); each keeps the time its event happened. What changes is how long the transaction
 * holds the chain head: from its last statements to its commit, instead of from its first audit row
 * (the first file of a zip or an email) to its commit, while the rest of the item was parsed and
 * written. Everything else (triage, include, the API) writes its rows as before.
 */
const buffers = new WeakMap<object, AuditEventInput[]>();

/** From now on, this transaction's ingest audit rows are held and written by flushAuditRows(). */
export function deferAuditRows(tx: Tx): void {
  buffers.set(tx, []);
}

/** An ingest audit row: held until flushAuditRows() in a deferred transaction, written now otherwise. */
export async function writeAuditRow(tx: Tx, input: AuditEventInput): Promise<void> {
  const held = buffers.get(tx);
  if (held) held.push({ ...input, timestamp: input.timestamp ?? new Date() });
  else await writeAuditEvent(tx, input);
}

/** Writes the held rows, in order, in one step (call it last, before the transaction commits). */
export async function flushAuditRows(tx: Tx): Promise<void> {
  const held = buffers.get(tx);
  buffers.delete(tx);
  if (held && held.length > 0) await writeAuditEvents(tx, held);
}
