#!/usr/bin/env tsx
/**
 * Casefile requirement coverage report — HANDOFF.md §3.3.
 *
 * This is a BLOCKING CI check from commit 1. It is the mechanism that makes a
 * 57,000-word specification tractable: nothing counts as built until its entry in
 * traceability/requirements.yaml has a passing verification.
 *
 *   pnpm trace:report                 # human-readable report, exit 1 on failure
 *   pnpm trace:report --epic E4       # scope to one epic
 *   pnpm trace:report --json          # machine-readable
 *   pnpm trace:report --complete E1,E2,E3
 *        Declare these epics complete. Every `must` requirement in them is then
 *        required to be verified/deviated/waived, or the build fails.
 *
 * FAILURE RULES (each blocks the build):
 *   F1  status: implemented           — implemented-but-unverified is not a resting state
 *   F2  missing verification artifact — a listed path does not exist on disk
 *   F3  verified with no artifacts    — "I read the code and it looks right" is not verification
 *   F4  incomplete completed epic     — a `must` requirement in a claimed-complete epic is unverified
 *   F5  red invariant guardrail       — any of I1..I10 without a green guardrail suite
 *   F6  manual overuse                — more than 3% of requirements verified by hand
 *   F7  malformed requirement         — unknown type/status/priority, duplicate id
 *   F8  under-evidenced verification   — statement describes observed behaviour, no test could observe it
 *   F9  bulk-assigned verification     — >8 verified requirements sharing one artifact list
 *   F10 §61.3 threshold without eval   — an ai_eval verified by anything but the eval harness
 *   F11 mappable `must` in E0          — a requirement no `pnpm doneness` run inspects
 *   F12 live test skip gate            — DATABASE_URL is live and any live integration test skipped
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB = resolve(ROOT, "traceability/requirements.yaml");
// Hand-authored requirements. extract.py never touches this file, so entries here
// survive regeneration. See traceability/manual.yaml for why that matters.
const MANUAL_DB = resolve(ROOT, "traceability/manual.yaml");
const GUARDRAIL_STATE = resolve(ROOT, "guardrails/.last-run.json");
const INTEGRATION_STATE = resolve(ROOT, "test-results/.integration-last-run.json");

const MANUAL_BUDGET = 0.03;

const VALID_TYPES = new Set([
  "invariant", "acceptance", "story", "schema", "api", "event", "perf", "security",
  "ai_eval", "ux", "behavior", "rbac", "tool", "threat", "risk", "assumption",
  "decision", "open_question", "quality", "context",
]);
const VALID_STATUS = new Set([
  "not_started", "in_progress", "implemented", "verified", "deviated", "waived",
]);
const VALID_PRIORITY = new Set(["must", "should", "may"]);
const VALID_METHODS = new Set([
  "unit_test", "integration_test", "e2e_test", "arch_test", "eval", "benchmark",
  "db_constraint", "manual", "review",
]);

/** The five always-green suites. HANDOFF.md §3.5. */
const GUARDRAILS: Record<string, string[]> = {
  "tenancy": ["I7"],
  "epistemic-authority": ["I2"],
  "grounding": ["I1", "I4", "I9"],
  "injection": ["I5", "I6"],
  "audit-integrity": ["I8"],
};
const UNGUARDED_INVARIANTS = ["I3", "I10"]; // covered by service-level integration tests

interface Requirement {
  id: string;
  prd_section: string;
  prd_anchor: string;
  statement: string;
  type: string;
  epic: string;
  priority: string;
  invariant_ref?: string | null;
  verification: { method?: string[]; artifacts?: string[] };
  status: string;
  verified_at?: string | null;
  notes?: string;
}

interface Failure {
  rule: string;
  id: string;
  detail: string;
}

// ---------------------------------------------------------------------------

function loadOne(path: string, label: string, required: boolean): Requirement[] {
  if (!existsSync(path)) {
    if (!required) return [];
    console.error(`FATAL: ${path} does not exist. Run: pnpm trace:extract`);
    process.exit(2);
  }
  const parsed = parse(readFileSync(path, "utf8"));
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    console.error(`FATAL: ${label} did not parse to a list.`);
    process.exit(2);
  }
  return parsed as Requirement[];
}

function loadRequirements(): Requirement[] {
  const generated = loadOne(DB, "requirements.yaml", true);
  const manual = loadOne(MANUAL_DB, "manual.yaml", false);

  // An id in both files means the extractor has caught up with something that was
  // added by hand. That is good news, but it must be resolved deliberately: delete
  // the manual entry, or rename it. Silently preferring one would mean the status
  // and artifacts recorded against the other are ignored.
  const genIds = new Set(generated.map((r) => r.id));
  const collisions = manual.filter((r) => genIds.has(r.id)).map((r) => r.id);
  if (collisions.length > 0) {
    console.error(
      `FATAL: these ids appear in BOTH requirements.yaml and manual.yaml:\n` +
      collisions.map((c) => `  ${c}`).join("\n") +
      `\nThe extractor now generates them. Remove them from manual.yaml.`,
    );
    process.exit(2);
  }
  return [...generated, ...manual];
}

type GuardrailState = "green" | "red" | "absent" | "not_run";

/**
 * guardrails/.last-run.json is written by the guardrail vitest reporter.
 *
 * "not_run" and "absent" are different facts and must not be conflated:
 *   not_run — the suite has not been executed in this working tree. We know nothing.
 *   absent  — it ran, and every test in it is still a todo. We know it enforces nothing.
 * Reporting a suite that was never run as "absent" states a finding that was never
 * made, which is the exact failure this whole report exists to prevent.
 */
function loadGuardrailState(): Record<string, GuardrailState> {
  const state: Record<string, GuardrailState> = {};
  const ran = existsSync(GUARDRAIL_STATE);
  for (const name of Object.keys(GUARDRAILS)) state[name] = ran ? "absent" : "not_run";
  if (!ran) return state;
  try {
    const raw = JSON.parse(readFileSync(GUARDRAIL_STATE, "utf8")) as Record<string, unknown>;
    for (const name of Object.keys(GUARDRAILS)) {
      const v = raw[name];
      if (v === "green" || v === "red") state[name] = v;
    }
  } catch {
    /* leave as absent */
  }
  return state;
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

function bar(fraction: number, width = 24): string {
  const filled = Math.round(fraction * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const epicFilter = argValue(argv, "--epic");
  const completeEpics = new Set(
    (argValue(argv, "--complete") ?? readCompletedEpics()).split(",").map((s) => s.trim()).filter(Boolean),
  );

  const all = loadRequirements();
  const reqs = epicFilter ? all.filter((r) => r.epic === epicFilter) : all;
  const failures: Failure[] = [];

  // ---- F7: shape validation ------------------------------------------
  const seen = new Set<string>();
  for (const r of all) {
    if (seen.has(r.id)) failures.push({ rule: "F7", id: r.id, detail: "duplicate requirement id" });
    seen.add(r.id);
    if (!VALID_TYPES.has(r.type)) failures.push({ rule: "F7", id: r.id, detail: `unknown type '${r.type}'` });
    if (!VALID_STATUS.has(r.status)) failures.push({ rule: "F7", id: r.id, detail: `unknown status '${r.status}'` });
    if (!VALID_PRIORITY.has(r.priority)) failures.push({ rule: "F7", id: r.id, detail: `unknown priority '${r.priority}'` });
    for (const m of r.verification?.method ?? []) {
      if (!VALID_METHODS.has(m)) failures.push({ rule: "F7", id: r.id, detail: `unknown method '${m}'` });
    }
  }

  // ---- F1, F2, F3 -----------------------------------------------------
  for (const r of reqs) {
    const artifacts = r.verification?.artifacts ?? [];
    const methods = r.verification?.method ?? [];

    if (r.status === "implemented") {
      failures.push({
        rule: "F1", id: r.id,
        detail: "status=implemented — implemented but unverified is not a valid resting state",
      });
    }
    for (const a of artifacts) {
      if (!existsSync(resolve(ROOT, a))) {
        failures.push({ rule: "F2", id: r.id, detail: `artifact missing: ${a}` });
      }
    }
    if (r.status === "verified") {
      const manualOnly = methods.length > 0 && methods.every((m) => m === "manual" || m === "review");
      if (artifacts.length === 0) {
        failures.push({
          rule: "F3", id: r.id,
          detail: manualOnly
            ? "verified by manual/review with no dated checklist entry in docs/manual-checks/"
            : "verified with no verification artifacts",
        });
      }
    }
    if ((r.status === "deviated" || r.status === "waived") && !(r.notes ?? "").trim()) {
      failures.push({
        rule: "F7", id: r.id,
        detail: `status=${r.status} requires notes (deviation id, or the user's quoted waiver)`,
      });
    }
  }

  // ---- F4: completed epics --------------------------------------------
  const settled = new Set(["verified", "deviated", "waived"]);
  for (const epic of completeEpics) {
    for (const r of all.filter((x) => x.epic === epic && x.priority === "must")) {
      if (!settled.has(r.status)) {
        failures.push({
          rule: "F4", id: r.id,
          detail: `epic ${epic} is declared complete but this 'must' requirement is ${r.status}`,
        });
      }
    }
  }

  // ---- F5: invariant guardrails ---------------------------------------
  const guardrailState = loadGuardrailState();
  for (const [suite, invariants] of Object.entries(GUARDRAILS)) {
    const state = guardrailState[suite];
    if (state === "red") {
      failures.push({
        rule: "F5", id: `guardrails/${suite}.spec.ts`,
        detail: `guardrail suite is RED — covers ${invariants.join(", ")}. STOP THE LINE.`,
      });
    } else if (state === "not_run") {
      failures.push({
        rule: "F5", id: `guardrails/${suite}.spec.ts`,
        detail: `guardrail suite has NOT RUN — covers ${invariants.join(", ")}. Run \`pnpm guardrails\`.`,
      });
    } else if (state === "absent") {
      failures.push({
        rule: "F5", id: `guardrails/${suite}.spec.ts`,
        detail: `guardrail suite is ABSENT (all tests todo) — covers ${invariants.join(", ")}. Implement guardrails.`,
      });
    }
  }

  // ---- F8: under-evidenced verification -------------------------------
  //
  // The gate can check that an artifact file exists. It cannot read the test inside
  // it and decide whether the test proves the whole statement. That gap is where a
  // traceability system quietly turns into decoration, and the usual shape of the
  // failure is a compound statement — "...resolves as the matrix specifies, decided by
  // a single implementation, denied by default, and every denial is audited" — marked
  // verified because the first clause passes.
  //
  // This is a heuristic, not a proof. It looks for statements whose vocabulary implies
  // behaviour a unit test cannot observe — something persisted, a request served, a
  // policy enforced at the boundary — and insists the evidence include a method that
  // could actually observe it. A false positive here costs a sentence in `notes`. A
  // false negative costs a requirement everyone believes is done.
  const NEEDS_OBSERVED_BEHAVIOUR = new RegExp(
    [
      "audited", "persisted", "written to", "recorded in", "stored",
      "transaction", "rolled back", "endpoint", "request", "response",
      "\\bRLS\\b", "row level security", "returns", "persistence layer",
      "emitted", "published", "logged",
    ].join("|"),
    "i",
  );
  const OBSERVING_METHODS = new Set([
    "integration_test", "e2e_test", "db_constraint", "benchmark", "eval",
  ]);

  for (const r of reqs) {
    if (r.status !== "verified") continue;
    const methods = r.verification?.method ?? [];
    if (methods.some((m) => OBSERVING_METHODS.has(m))) continue;
    if (!NEEDS_OBSERVED_BEHAVIOUR.test(r.statement ?? "")) continue;
    const waived = (r.notes ?? "").includes("F8-ACCEPTED:");
    if (waived) continue;
    failures.push({
      rule: "F8", id: r.id,
      detail:
        `verified with methods [${methods.join(", ") || "none"}], but the statement ` +
        `describes behaviour a unit test cannot observe. Either add an ` +
        `integration/e2e/db_constraint artifact that proves it, set the status to ` +
        `in_progress, or justify it in notes beginning "F8-ACCEPTED: ".`,
    });
  }

  // ---- F9: bulk-assigned verification ---------------------------------
  //
  // Four epics were once verified by `for (req of reqs) if (req.epic === 'E8')
  // req.status = 'verified'`, which assigned 134 claims in one pass with artifacts
  // chosen by id prefix. The tests existed; nobody checked that each one proved the
  // requirement it was attached to.
  //
  // Legitimate grouping is small — one flow test can honestly prove three related
  // stories. Nothing honest produces sixty. Override per requirement with a
  // "CLUSTER-ACCEPTED: <reason>" note, one at a time, having read the statement.
  const CLUSTER_LIMIT = 8;
  const clusters = new Map<string, string[]>();
  for (const r of reqs) {
    if (r.status !== "verified") continue;
    const key = JSON.stringify([...(r.verification?.artifacts ?? [])].sort());
    clusters.set(key, [...(clusters.get(key) ?? []), r.id]);
  }
  for (const [key, ids] of clusters) {
    if (ids.length <= CLUSTER_LIMIT) continue;
    const arts = (JSON.parse(key) as string[]).join(", ") || "(none)";
    for (const id of ids) {
      const r = reqs.find((x) => x.id === id)!;
      if ((r.notes ?? "").includes("CLUSTER-ACCEPTED:")) continue;
      failures.push({
        rule: "F9", id,
        detail: `verified sharing one identical artifact list with ${ids.length - 1} others ` +
          `(${arts.slice(0, 70)}). Re-verify individually, or justify with a ` +
          `"CLUSTER-ACCEPTED: " note after reading the statement.`,
      });
    }
  }

  // ---- F10: §61.3 thresholds need the eval harness ---------------------
  //
  // A fabrication rate or a false-merge rate is measured against labelled ground
  // truth by evals/harness/run.py. No integration test can produce one. Three of
  // these are hard gates whose whole purpose is to stop a model version shipping.
  for (const r of reqs) {
    if (r.type !== "ai_eval" || r.status !== "verified") continue;
    if ((r.verification?.method ?? []).includes("eval")) continue;
    failures.push({
      rule: "F10", id: r.id,
      detail: `§61.3 threshold verified by [${(r.verification?.method ?? []).join(", ") || "none"}] ` +
        `instead of method 'eval'. Run: python3 evals/harness/run.py --all`,
    });
  }

  // ---- F11: no mappable `must` requirement may sit in E0 ---------------
  //
  // E0 means "cross-cutting — owned by the whole build". `pnpm doneness` runs per epic
  // and never inspects E0, and the build order is E1..E12, so
  // anything landing there is owned by nobody and chased by no gate.
  //
  // That is not hypothetical. 224 `must` requirements — 18% of the specification — sat
  // in E0 for nine sessions: 81 user stories orphaned by six wrong prefix keys in
  // STORY_EPIC, all 49 non-tenancy tables, all 17 §49 performance targets, and the
  // AC-FND criteria. Every epic reported its own coverage honestly the whole time.
  //
  // traceability/extract.py now refuses to emit these, so this rule guards the
  // hand-authored half: traceability/manual.yaml.
  const MAPPABLE_TYPES = new Set([
    "story", "acceptance", "schema", "perf", "api", "event", "rbac", "tool",
  ]);
  for (const r of all) {
    if (r.epic !== "E0" || r.priority !== "must") continue;
    if (!MAPPABLE_TYPES.has(r.type)) continue;      // governance genuinely lives in E0
    if (r.id.startsWith("REQ-AC-PERF-")) continue;  // whole-system §53.5 measurement
    failures.push({
      rule: "F11", id: r.id,
      detail: `type '${r.type}' with priority 'must' is in E0, which no \`pnpm doneness\` ` +
        `run inspects and which is not in the E1..E12 build order. Assign the epic that ` +
        `owns it.`,
    });
  }

  // ---- F6: manual budget ----------------------------------------------
  const manualCount = all.filter((r) => (r.verification?.method ?? []).includes("manual")).length;
  const manualShare = all.length === 0 ? 0 : manualCount / all.length;
  if (manualShare > MANUAL_BUDGET) {
    failures.push({
      rule: "F6", id: "(global)",
      detail: `${manualCount}/${all.length} (${(manualShare * 100).toFixed(1)}%) requirements use method 'manual'; ` +
        `budget is ${MANUAL_BUDGET * 100}%. Automate the difference.`,
    });
  }

  // ---- F12: live test skip gate ---------------------------------------
  //
  // If DATABASE_URL is a live (non-localhost, non-CHANGEME) URL, every live
  // integration test MUST run and none may be skipped. A live suite silently
  // downgrading to skipped is how two sessions of cloud verification quietly
  // stopped happening.
  let dbUrl = process.env.DATABASE_URL;
  if (existsSync(resolve(ROOT, ".env"))) {
    try {
      const envContent = readFileSync(resolve(ROOT, ".env"), "utf-8");
      for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("DATABASE_URL=")) {
          let val = trimmed.slice("DATABASE_URL=".length).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          dbUrl = val;
        }
      }
    } catch {
      // ignore
    }
  }

  const isLiveDb = dbUrl && !dbUrl.includes("127.0.0.1") && !dbUrl.includes("localhost") && !dbUrl.includes("CHANGEME");
  if (isLiveDb) {
    if (existsSync(INTEGRATION_STATE)) {
      try {
        const intState = JSON.parse(readFileSync(INTEGRATION_STATE, "utf-8")) as {
          totalRan: number;
          totalFailed: number;
          totalSkipped: number;
          files?: Record<string, { ran: number; failed: number; skipped: number }>;
        };
        if (intState.totalSkipped > 0) {
          const skippedFileList = Object.entries(intState.files ?? {})
            .filter(([, stats]) => stats.skipped > 0)
            .map(([f, s]) => `${f} (${s.skipped} skipped)`)
            .join(", ");
          failures.push({
            rule: "F12",
            id: "(live-integration-tests)",
            detail: `DATABASE_URL is a live cloud URL (${dbUrl?.split("@")[1] || "cloud"}), but ${intState.totalSkipped} integration tests were SKIPPED [${skippedFileList || "unknown"}]. Live tests must never be skipped when configured against live infrastructure.`,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  // ---- tally -----------------------------------------------------------
  const tally = (rs: Requirement[]) => {
    const t: Record<string, number> = {
      not_started: 0, in_progress: 0, implemented: 0, verified: 0, deviated: 0, waived: 0,
    };
    for (const r of rs) if (r.status in t) t[r.status]! += 1;
    return t;
  };
  const totals = tally(reqs);

  const epics = [...new Set(all.map((r) => r.epic))].sort();
  const types = [...new Set(all.map((r) => r.type))].sort();

  if (asJson) {
    console.log(JSON.stringify({
      total: reqs.length,
      totals,
      manual: { count: manualCount, share: manualShare, budget: MANUAL_BUDGET },
      byEpic: Object.fromEntries(epics.map((e) => [e, tally(all.filter((r) => r.epic === e))])),
      byType: Object.fromEntries(types.map((t) => [t, tally(all.filter((r) => r.type === t))])),
      guardrails: guardrailState,
      completeEpics: [...completeEpics],
      failures,
      ok: failures.length === 0,
    }, null, 2));
    process.exit(failures.length === 0 ? 0 : 1);
  }

  // ---- render ----------------------------------------------------------
  const W = 62;
  console.log("\nCASEFILE REQUIREMENT COVERAGE");
  console.log("─".repeat(W));
  console.log(`Total requirements        ${String(reqs.length).padStart(6)}${epicFilter ? `  (epic ${epicFilter})` : ""}`);
  const row = (label: string, n: number, flag = "") =>
    console.log(`  ${label.padEnd(22)}${String(n).padStart(6)}  ${pct(n, reqs.length).padStart(6)}${flag}`);
  row("verified", totals.verified!);
  row("implemented (untested)", totals.implemented!, totals.implemented! > 0 ? "  ← BLOCKS MERGE" : "");
  row("in_progress", totals.in_progress!);
  row("not_started", totals.not_started!);
  row("deviated", totals.deviated!, totals.deviated! > 0 ? "  (see DEVIATIONS.md)" : "");
  row("waived", totals.waived!, totals.waived! > 0 ? "  (user-approved)" : "");

  console.log("");
  console.log("BY EPIC");
  for (const e of epics) {
    const rs = all.filter((r) => r.epic === e);
    const must = rs.filter((r) => r.priority === "must");
    const done = must.filter((r) => settled.has(r.status)).length;
    const frac = must.length === 0 ? 1 : done / must.length;
    const mark = completeEpics.has(e) ? (frac === 1 ? "✅" : "❌") : frac === 1 ? "✅" : frac > 0 ? "⏳" : "  ";
    console.log(
      `  ${e.padEnd(4)} ${mark} ${bar(frac)} ${pct(done, must.length).padStart(6)}` +
      `  ${String(done).padStart(4)}/${String(must.length).padEnd(4)} must` +
      `  ${String(rs.length).padStart(4)} total`,
    );
  }

  console.log("");
  console.log("BY TYPE");
  for (const t of types) {
    const rs = all.filter((r) => r.type === t);
    const done = rs.filter((r) => settled.has(r.status)).length;
    console.log(`  ${t.padEnd(15)}${bar(done / rs.length, 16)} ${pct(done, rs.length).padStart(6)}  ${String(rs.length).padStart(4)}`);
  }

  console.log("");
  console.log("INVARIANTS I1–I10");
  const MARKS: Record<GuardrailState, string> = {
    green: "✅ green ", red: "❌ RED   ", absent: "⚠ absent", not_run: "·  not run",
  };
  for (const [suite, invs] of Object.entries(GUARDRAILS)) {
    console.log(`  ${MARKS[guardrailState[suite]!]}  ${suite.padEnd(22)} ${invs.join(", ")}`);
  }
  console.log(`  ·          (service-level)        ${UNGUARDED_INVARIANTS.join(", ")}`);
  if (Object.values(guardrailState).some((v) => v === "not_run")) {
    console.log("");
    console.log("  These suites have not been run in this working tree, which is not the");
    console.log("  same as knowing they enforce nothing. Run `pnpm guardrails` first —");
    console.log("  or `pnpm verify`, which runs them in the right order.");
  }

  console.log("");
  console.log(`MANUAL VERIFICATION BUDGET  ${manualCount}/${all.length} = ${(manualShare * 100).toFixed(1)}%  (cap ${MANUAL_BUDGET * 100}%)`);

  if (failures.length === 0) {
    console.log("");
    console.log("✅ No blocking failures.");
    console.log("");
    process.exit(0);
  }

  console.log("");
  console.log(`FAILURES (${failures.length})`);
  console.log("─".repeat(W));
  const byRule = new Map<string, Failure[]>();
  for (const f of failures) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  for (const rule of [...byRule.keys()].sort()) {
    const list = byRule.get(rule)!;
    console.log(`\n  ${rule}  (${list.length})`);
    for (const f of list.slice(0, 25)) {
      console.log(`    ${f.id.padEnd(30)} ${f.detail}   BLOCKS`);
    }
    if (list.length > 25) console.log(`    … and ${list.length - 25} more`);
  }
  console.log("");
  process.exit(1);
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

/** traceability/completed-epics.txt is the ledger of record for which epics are claimed complete. */
function readCompletedEpics(): string {
  const p = resolve(ROOT, "traceability/completed-epics.txt");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .join(",");
}

main();
