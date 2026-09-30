import { basename } from "node:path";
import postgres from "postgres";
import { getDbUrl } from "@casefile/db";
import { parseArgs, loadEnv } from "./args.js";
import { resolveRecordContext } from "./triage.js";
import { enqueueRun } from "./queue.js";
import { loadRunInfo } from "./worker.js";
import { startWorkerProcesses } from "./ingest.js";
import { getRunStatus, formatRunStatus } from "./run-status.js";

/**
 * `pnpm ingest:resume --run <run id> [--workers N]` (BIGDATA-4, DEV-038): takes a stopped run up
 * again. Workers that were killed left their items leased; a lease runs out after INGEST_LEASE_SECONDS
 * (90 s by default) of the database clock and the item is taken again, from its first part not
 * written (a mailbox part from its first message not written). Nothing written is written again (the
 * fence, plan section 16). If the run's queue was not complete when it stopped, it is completed first,
 * from the run's triage decisions. Failed items stay failed: `pnpm ingest:retry` puts them back.
 */
async function runCli() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const runId = typeof args["run"] === "string" ? args["run"] : "";
  const workers = Math.max(1, Number(args["workers"] ?? process.env.INGEST_WORKERS ?? 1) || 1);
  const tenantId = process.env.MATTER_TENANT_ID || "";
  if (!runId || !tenantId) {
    console.error("Usage: pnpm ingest:resume --run <run id> [--workers N]   (MATTER_TENANT_ID from the matter environment)");
    process.exit(1);
  }
  try {
    const db = postgres(getDbUrl(), { max: 2 });
    try {
      const run = await loadRunInfo(db, tenantId, runId);
      if (!run.queued) {
        const rec = await resolveRecordContext(db, tenantId, run.investigationId, run.startedBy ?? undefined);
        const q = await enqueueRun(db, rec, runId);
        console.log(`The run's queue was not complete: ${q.added} items added (${q.total} in all).`);
      }
    } finally {
      await db.end();
    }
    const before = await getRunStatus({ runId, tenantId });
    if (before.state === "finished" || before.state === "finished-with-failures") {
      console.log(formatRunStatus(before));
      console.log(before.failed.length ? `The run is finished with ${before.failed.length} failed item(s): pnpm ingest:retry --run ${runId} puts them back.` : "The run is finished: nothing to resume.");
      return;
    }
    console.log(`Resuming run ${runId} with ${workers} worker process(es): ${before.top.done} of ${before.top.total} done, ${before.top.left} left.`);
    const code = await startWorkerProcesses(runId, workers);
    const after = await getRunStatus({ runId, tenantId });
    console.log(formatRunStatus(after));
    if (code !== 0 || (after.state !== "finished" && after.state !== "finished-with-failures")) process.exit(1);
  } catch (err: unknown) {
    console.error(`ingest:resume failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (/^resume\.(ts|js)$/.test(basename(process.argv[1] ?? ""))) {
  void runCli();
}
