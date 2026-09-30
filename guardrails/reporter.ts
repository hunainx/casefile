/**
 * Vitest reporter for the guardrail suites.
 *
 * Writes guardrails/.last-run.json — a map of suite name → "green" | "red" — which
 * traceability/report.ts reads to enforce failure rule F5 (a red guardrail suite is a
 * stop-the-line event that blocks the build).
 *
 * A suite is "green" only if every non-todo test in it passed. A suite consisting
 * entirely of todos stays "absent": honest about not yet being enforced, and not a
 * false green.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter } from "vitest/reporters";
import type { TestModule } from "vitest/node";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, ".last-run.json");

type State = "green" | "red" | "absent";

// Vitest 4 removed onFinished(files); onTestRunEnd(testModules) replaces it (D135). The counting is
// unchanged: a test marked skip or todo does not count, every other test ran, a failed result is red.
function count(module: TestModule, seen: { ran: number; failed: number }): void {
  for (const test of module.children.allTests()) {
    if (test.options.mode === "todo" || test.options.mode === "skip") continue;
    seen.ran += 1;
    if (test.result().state === "failed") seen.failed += 1;
  }
}

export default class GuardrailReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const state: Record<string, State> = {};

    for (const module of testModules) {
      const name = basename(module.moduleId, ".spec.ts")
        .replace(/\.spec$/, "");
      if (!name) continue;
      const seen = { ran: 0, failed: 0 };
      count(module, seen);
      state[name] = seen.ran === 0 ? "absent" : seen.failed > 0 ? "red" : "green";
    }

    writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n", "utf8");

    const red = Object.entries(state).filter(([, v]) => v === "red");
    if (red.length > 0) {
      // Deliberately loud. HANDOFF §1.3: a red guardrail is a stop-the-line event.
      process.stderr.write(
        `\n  ██  GUARDRAIL RED: ${red.map(([k]) => k).join(", ")}\n` +
        `  ██  STOP THE LINE. Fix this before any other work continues.\n\n`,
      );
    }
  }
}
