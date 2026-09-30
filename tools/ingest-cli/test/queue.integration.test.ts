import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { getDbUrl, createDbClient } from "@casefile/db";
import { listBucketObjects } from "@casefile/storage";
import { resolveRecordContext } from "../src/triage.js";
import { enqueueDirectory, ingestDirectory } from "../src/ingest.js";
import { enqueueRun, registerWorker, claimItem, releaseItem, withFence, LeaseLostError, retryFailedItems, type WorkItem } from "../src/queue.js";
import { runWorker } from "../src/worker.js";
import { getRunStatus, formatRunStatus } from "../src/run-status.js";
import { buildIngestReport, formatReport } from "../src/report.js";
import { newMatter, q, keptSkipped, rowCounts, type Matter } from "./helpers/run-outcomes.js";

/**
 * BIGDATA-4 (plan section 16; answer 9): the work queue is a table in the matter's own database.
 *   - the queue is built from the run's triage decisions, one item per object to ingest, in reading order,
 *     and building it again adds nothing;
 *   - workers take items with a lease (FOR UPDATE SKIP LOCKED): two workers never hold the same item, and
 *     the earliest item is taken first; a worker whose lease ran out cannot commit (the fence) and another
 *     worker takes the item;
 *   - an item that keeps failing is marked failed with its error after 3 attempts, listed, never dropped,
 *     and the case owner can retry it;
 *   - doing an item twice writes nothing twice.
 */
const BASE = join(process.cwd(), ".tmp-test-fixtures", `queue_${Date.now()}`);
const fakeText = (i: number) => `Fake note number ${i}: the fake barge ${i} left the fake quay ${i} at dawn, carrying fake crates.`;

function writeCorpus(dir: string, files: number): void {
  mkdirSync(join(dir, "notes"), { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(dir, "notes", `note-${String(i).padStart(2, "0")}.txt`), fakeText(i));
  const zip = new AdmZip();
  zip.addFile("inside/one.txt", Buffer.from(fakeText(100)));
  zip.addFile("inside/two.txt", Buffer.from(fakeText(101)));
  zip.writeZip(join(dir, "bundle.zip"));
}

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe("tools/ingest-cli — BIGDATA-4 work queue", () => {
  const db = () => createDbClient(getDbUrl(), { max: 4 });

  it("builds one item per object triage decided to ingest, in reading order, and building it again adds nothing", async () => {
    const dir = join(BASE, "enqueue");
    writeCorpus(dir, 6);
    writeFileSync(join(dir, "notes", "empty.txt"), "");
    const m = await newMatter("enqueue", BASE);
    const { runId } = await enqueueDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    const items = await q(m.tenantId, (tx) => tx<{ path: string; top_seq: number; part_no: number; kind: string; state: string; decision_id: string }[]>`
      SELECT path, top_seq, part_no, kind, state, decision_id FROM ingest_work WHERE run_id = ${runId} ORDER BY top_seq, part_no`);
    const ingestDecisions = await q(m.tenantId, (tx) => tx<{ id: string; path: string }[]>`
      SELECT id, path FROM ingest_decisions WHERE run_id = ${runId} AND stage = 'triage' AND decision = 'ingest' ORDER BY seq`);
    expect(items.map((i) => i.path)).toEqual(ingestDecisions.map((d) => d.path));
    expect(items.map((i) => i.decision_id)).toEqual(ingestDecisions.map((d) => d.id));
    expect(items).toHaveLength(7); // 6 notes + the zip; the empty file is a skip-junk decision, not an item
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(["file"]));
    expect(items.every((i) => i.state === "pending" && i.part_no === 0)).toBe(true);
    expect(items.map((i) => i.top_seq)).toEqual([...items.map((i) => i.top_seq)].sort((a, b) => a - b));

    const c = db();
    try {
      const rec = await resolveRecordContext(c, m.tenantId, m.investigationId, m.userId);
      const again = await enqueueRun(c, rec, runId);
      expect(again.added).toBe(0);
      expect(again.total).toBe(7);
    } finally {
      await c.end();
    }
    const run = await q(m.tenantId, (tx) => tx<{ queued_at: Date | null }[]>`SELECT queued_at FROM ingest_runs WHERE id = ${runId}`);
    expect(run[0]!.queued_at).toBeInstanceOf(Date);
  });

  it("8 workers claiming at once never get the same item, and each takes the earliest item left", async () => {
    const dir = join(BASE, "claim");
    writeCorpus(dir, 39);
    const m = await newMatter("claim", BASE);
    const { runId } = await enqueueDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    const clients = Array.from({ length: 8 }, () => db());
    try {
      const rec = await resolveRecordContext(clients[0]!, m.tenantId, m.investigationId, m.userId);
      const workers = await Promise.all(clients.map((c, i) => registerWorker(c, rec, runId, `claimer-${i}`)));
      const claimed: WorkItem[][] = await Promise.all(clients.map(async (c, i) => {
        const mine: WorkItem[] = [];
        for (;;) {
          const it = await claimItem(c, rec, runId, workers[i]!, { leaseSeconds: 60 });
          if (!it) return mine;
          mine.push(it);
        }
      }));
      const all = claimed.flat();
      expect(all).toHaveLength(40);
      expect(new Set(all.map((x) => x.id)).size).toBe(40);
      expect(all.every((x) => x.attempts === 1)).toBe(true);
      for (const mine of claimed) expect(mine.map((x) => x.top_seq)).toEqual([...mine.map((x) => x.top_seq)].sort((a, b) => a - b));
      const leased = await q(m.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ingest_work WHERE run_id = ${runId} AND leased_by IS NOT NULL AND lease_expires_at > now()`);
      expect(leased[0]!.n).toBe(40);
      for (const x of all) await releaseItem(clients[0]!, rec, x);
      const back = await q(m.tenantId, (tx) => tx<{ n: number; attempts: number }[]>`SELECT count(*)::int AS n, max(attempts)::int AS attempts FROM ingest_work WHERE run_id = ${runId} AND leased_by IS NULL`);
      expect(back[0]).toEqual({ n: 40, attempts: 0 }); // a released item was not a failed attempt
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it("a worker whose lease ran out cannot commit; another worker takes the item and its write is the only one", async () => {
    const dir = join(BASE, "lease");
    writeCorpus(dir, 2);
    const m = await newMatter("lease", BASE);
    const { runId } = await enqueueDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    const c1 = db();
    const c2 = db();
    try {
      const rec = await resolveRecordContext(c1, m.tenantId, m.investigationId, m.userId);
      const w1 = await registerWorker(c1, rec, runId, "slow");
      const w2 = await registerWorker(c2, rec, runId, "fast");
      const first = (await claimItem(c1, rec, runId, w1, { leaseSeconds: 1 }))!;
      await new Promise((r) => setTimeout(r, 1600));
      const again = (await claimItem(c2, rec, runId, w2, { leaseSeconds: 60 }))!;
      expect(again.id).toBe(first.id);
      expect(again.attempts).toBe(2);
      await expect(withFence(c1, rec, first, async () => "the old holder's write")).rejects.toBeInstanceOf(LeaseLostError);
      await expect(withFence(c2, rec, again, async () => "the new holder's write")).resolves.toBe("the new holder's write");
    } finally {
      await c1.end();
      await c2.end();
    }

    // The same with real workers: one stops renewing in the middle of an item (it hangs), the other
    // finishes the run; when the first one wakes up its write is refused. Every file is a source once.
    const dir2 = join(BASE, "lease-workers");
    writeCorpus(dir2, 5);
    const m2 = await newMatter("lease-workers", BASE);
    const { runId: run2 } = await enqueueDirectory({ dir: dir2, investigationId: m2.investigationId, tenantId: m2.tenantId, userId: m2.userId });
    let wake: () => void = () => {};
    const hung = new Promise<void>((r) => (wake = r));
    const stuck = runWorker({
      runId: run2, tenantId: m2.tenantId, name: "hangs", leaseSeconds: 1, heartbeatMs: 60_000,
      hooks: { beforeWrite: async (item) => { if (item.file_name === "bundle.zip") await hung; } },
    });
    await new Promise((r) => setTimeout(r, 300));
    const other = await runWorker({ runId: run2, tenantId: m2.tenantId, name: "finishes", leaseSeconds: 60 });
    wake();
    const stuckReport = await stuck;
    expect(stuckReport.leasesLost).toBe(1);
    expect(other.itemsDone + stuckReport.itemsDone).toBe(6);
    const outcomes = await keptSkipped(m2, dir2);
    expect(outcomes.filter((l) => l.startsWith("bundle.zip"))).toEqual([
      "bundle.zip\tkept indexed",
      "bundle.zip#inside/one.txt\tkept indexed",
      "bundle.zip#inside/two.txt\tkept indexed",
    ]);
    const perPath = await q(m2.tenantId, (tx) => tx<{ path: string; n: number }[]>`
      SELECT metadata->>'source_path' AS path, count(*)::int AS n FROM sources WHERE tenant_id = ${m2.tenantId} GROUP BY 1 HAVING count(*) > 1`);
    expect(perPath).toEqual([]);
  });

  it("an item that keeps failing is failed after 3 attempts with its error, listed, audited once, and the owner can retry it", async () => {
    const dir = join(BASE, "retry");
    writeCorpus(dir, 3);
    const m = await newMatter("retry", BASE);
    const { runId } = await enqueueDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    const report = await runWorker({
      runId, tenantId: m.tenantId, name: "breaks-one",
      hooks: { duringWrite: (item) => { if (item.file_name === "note-01.txt") throw new Error("fake storage outage (injected by the test)"); } },
    });
    expect(report.attemptsFailed).toBe(3);
    // Plan answer 10: each worker reports the audit rows it chained and the time it waited for, and held, the chain.
    expect(report.chain.rows).toBeGreaterThan(0);
    expect(report.chain.waitMs).toBeGreaterThanOrEqual(0);
    expect(report.chain.holdMs).toBeGreaterThan(0);
    const failed = await q(m.tenantId, (tx) => tx<{ path: string; state: string; attempts: number; last_error: string; errors: unknown[] }[]>`
      SELECT path, state, attempts, last_error, errors FROM ingest_work WHERE run_id = ${runId} AND state = 'failed'`);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.path).toBe(join(dir, "notes", "note-01.txt"));
    expect(failed[0]!.attempts).toBe(3);
    expect(failed[0]!.last_error).toContain("fake storage outage");
    expect(failed[0]!.errors).toHaveLength(3);
    const auditFailed = async () => q(m.tenantId, (tx) => tx<{ path: string }[]>`
      SELECT after->>'path' AS path FROM audit_events WHERE tenant_id = ${m.tenantId} AND action = 'source.ingest_failed'`);
    expect((await auditFailed()).map((r) => r.path)).toEqual([join(dir, "notes", "note-01.txt")]);

    const status = await getRunStatus({ runId, tenantId: m.tenantId });
    expect(status.state).toBe("finished-with-failures");
    expect(status.failed).toEqual([expect.objectContaining({ path: join(dir, "notes", "note-01.txt"), attempts: 3, error: expect.stringContaining("fake storage outage") })]);
    expect(formatRunStatus(status)).toContain("fake storage outage");
    const reportText = formatReport(await buildIngestReport({ runId, tenantId: m.tenantId, dbUrl: getDbUrl() }), "x.csv", null);
    expect(reportText).toContain("Failed items: 1");
    expect(reportText).toContain("fake storage outage");
    expect((await keptSkipped(m, dir)).some((l) => l.startsWith("notes/note-01.txt\tkept"))).toBe(false);

    const retried = await retryFailedItems({ runId, tenantId: m.tenantId });
    expect(retried.reset).toBe(1);
    const second = await runWorker({ runId, tenantId: m.tenantId, name: "after-the-fix" });
    expect(second.itemsDone).toBe(1);
    expect(await keptSkipped(m, dir)).toContain("notes/note-01.txt\tkept indexed");
    expect((await getRunStatus({ runId, tenantId: m.tenantId })).state).toBe("finished");
    expect((await auditFailed())).toHaveLength(1); // the first failure stays on record; it was not written again
    const history = await q(m.tenantId, (tx) => tx<{ state: string; errors: unknown[] }[]>`SELECT state, errors FROM ingest_work WHERE run_id = ${runId} AND path = ${join(dir, "notes", "note-01.txt")}`);
    expect(history[0]!.state).toBe("done");
    expect(history[0]!.errors).toHaveLength(3);
  });

  it("doing an item or a whole run again writes nothing twice (rows and bucket objects)", async () => {
    const dir = join(BASE, "twice");
    writeCorpus(dir, 4);
    const m: Matter = await newMatter("twice", BASE);
    const summary = await ingestDirectory({ dir, investigationId: m.investigationId, tenantId: m.tenantId, userId: m.userId });
    const before = await rowCounts(m);
    const objects = async () => (await listBucketObjects(process.env.GCS_BUCKET_SOURCES!, `${m.tenantId}/`)).map((o) => `${o.name} generation ${o.generation}`).sort();
    const objectsBefore = await objects();
    expect(objectsBefore).toHaveLength(7);
    expect(before.sources).toBe(7);

    // The run's workers again: every item is done, so nothing is claimed.
    const again = await runWorker({ runId: summary.runId, tenantId: m.tenantId, name: "late" });
    expect(again.itemsDone).toBe(0);
    // One item forced back into the queue as if its first execution's end had been lost: its
    // second execution finds its rows (the fence reads the item's state) and writes nothing.
    await q(m.tenantId, (tx) => tx`UPDATE ingest_work SET state = 'sequenced', lease_token = NULL, leased_by = NULL, lease_expires_at = NULL
                                   WHERE run_id = ${summary.runId} AND file_name = 'bundle.zip'`);
    const redo = await runWorker({ runId: summary.runId, tenantId: m.tenantId, name: "redo" });
    expect(redo.itemsDone).toBe(1);
    expect(await rowCounts(m)).toEqual(before);
    expect(await objects()).toEqual(objectsBefore);
  });
});
