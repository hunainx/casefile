import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter } from "vitest/reporters";
import type { TestModule } from "vitest/node";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../../test-results");
const OUT = resolve(OUT_DIR, ".integration-last-run.json");

// Vitest 4 removed onFinished(files); onTestRunEnd(testModules) replaces it (D135). The counting is
// unchanged: a test marked skip or todo is skipped, every other test ran, and a failed result is a failure.
function count(module: TestModule, seen: { ran: number; failed: number; skipped: number }): void {
  for (const test of module.children.allTests()) {
    if (test.options.mode === "skip" || test.options.mode === "todo") {
      seen.skipped += 1;
      continue;
    }
    seen.ran += 1;
    if (test.result().state === "failed") seen.failed += 1;
  }
}

export default class IntegrationReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    mkdirSync(OUT_DIR, { recursive: true });

    let totalSkipped = 0;
    let totalRan = 0;
    let totalFailed = 0;

    const fileSummaries: Record<string, { ran: number; failed: number; skipped: number }> = {};

    for (const module of testModules) {
      const name = basename(module.moduleId);
      if (!name) continue;
      const seen = { ran: 0, failed: 0, skipped: 0 };
      count(module, seen);
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
