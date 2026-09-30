import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter } from "vitest/reporters";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../../test-results");
const OUT = resolve(OUT_DIR, ".integration-last-run.json");

interface TaskLike {
  type?: string;
  mode?: string;
  name?: string;
  result?: { state?: string };
  tasks?: TaskLike[];
}

function walk(task: TaskLike, seen: { ran: number; failed: number; skipped: number }): void {
  if (task.type === "test" || task.type === "custom") {
    if (task.mode === "skip" || task.mode === "todo") {
      seen.skipped += 1;
      return;
    }
    seen.ran += 1;
    if (task.result?.state === "fail") seen.failed += 1;
    return;
  }
  for (const child of task.tasks ?? []) walk(child, seen);
}

export default class IntegrationReporter implements Reporter {
  onFinished(files: TaskLike[] = []): void {
    mkdirSync(OUT_DIR, { recursive: true });

    let totalSkipped = 0;
    let totalRan = 0;
    let totalFailed = 0;

    const fileSummaries: Record<string, { ran: number; failed: number; skipped: number }> = {};

    for (const file of files) {
      const name = basename(String((file as { name?: string }).name ?? ""));
      if (!name) continue;
      const seen = { ran: 0, failed: 0, skipped: 0 };
      walk(file, seen);
      fileSummaries[name] = seen;
      totalSkipped += seen.skipped;
      totalRan += seen.ran;
      totalFailed += seen.failed;
    }

    const state = {
      timestamp: new Date().toISOString(),
      totalRan,
      totalFailed,
      totalSkipped,
      files: fileSummaries,
    };

    writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n", "utf8");
  }
}
