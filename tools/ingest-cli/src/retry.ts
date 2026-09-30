import { basename } from "node:path";
import { parseArgs, loadEnv } from "./args.js";
import { retryFailedItems } from "./queue.js";

/**
 * `pnpm ingest:retry --run <run id> [--item <item id>]` (BIGDATA-4): the case owner puts a run's
 * failed items back in its queue (all of them, or one), once the cause is fixed. Their error history
 * stays on the item; the run is open again until workers finish it (`pnpm ingest:resume`). A retried
 * item is judged against everything the matter holds at that time, like a new run. Audited
 * (ingest.retry).
 */
async function runCli() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const runId = typeof args["run"] === "string" ? args["run"] : "";
  const itemId = typeof args["item"] === "string" ? args["item"] : undefined;
  if (!runId) {
    console.error("Usage: pnpm ingest:retry --run <run id> [--item <item id>]   (failed items are listed by pnpm ingest:status --run <run id>)");
    process.exit(1);
  }
  try {
    const out = await retryFailedItems({ runId, itemId });
    console.log(`${out.reset} failed item(s) put back in the queue of run ${runId}:`);
    for (const p of out.paths) console.log(`  ${p}`);
    if (out.reset > 0) console.log(`Work them: pnpm ingest:resume --run ${runId} --workers N`);
  } catch (err: unknown) {
    console.error(`ingest:retry failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (/^retry\.(ts|js)$/.test(basename(process.argv[1] ?? ""))) {
  void runCli();
}
