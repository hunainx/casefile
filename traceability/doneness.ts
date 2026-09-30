#!/usr/bin/env tsx
/**
 * Definition-of-done assessor.
 *
 *   pnpm doneness E1
 *
 * WHY THIS EXISTS
 *
 * Three consecutive sessions assessed an epic against the definition of done by paraphrasing the
 * clauses, and each paraphrase happened to be easier to pass than the clause it replaced.
 * The third attempt labelled the paraphrase "the exact, unparaphrased text" and attached
 * a line-number citation to it.
 *
 * This is not a discipline problem that another reminder fixes. A rubric an agent restates
 * from memory is a rubric it can restate favourably, so this tool READS §4.1 out of
 * docs/DEFINITION-OF-DONE.md at runtime, prints each clause exactly as written, and computes the
 * verdict for every clause it can decide mechanically. There is nothing left to paraphrase.
 *
 * Clauses 2, 3 and 5 depend on knowing which acceptance criteria, user stories and
 * performance targets belong to an epic. That mapping lives in requirements.yaml, so those
 * are computed too. Clause 6 is the only one a human must confirm.
 *
 * Exit code 0 means every clause is met. Non-zero means the epic is not done, regardless
 * of how the session went.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFINITION_OF_DONE = resolve(ROOT, "docs/DEFINITION-OF-DONE.md");
const GUARDRAIL_STATE = resolve(ROOT, "guardrails/.last-run.json");

interface Requirement {
  id: string;
  type: string;
  epic: string;
  priority: string;
  status: string;
  verification?: { method?: string[]; artifacts?: string[] };
}

/** Read §4.1's numbered clauses out of docs/DEFINITION-OF-DONE.md, verbatim. No hardcoded copy. */
function readClauses(): string[] {
  if (!existsSync(DEFINITION_OF_DONE)) {
    console.error(`FATAL: ${DEFINITION_OF_DONE} not found. §4.1 is the source of the bar.`);
    process.exit(2);
  }
  const text = readFileSync(DEFINITION_OF_DONE, "utf8");
  const start = text.indexOf("### 4.1");
  if (start === -1) {
    console.error("FATAL: could not locate §4.1 in docs/DEFINITION-OF-DONE.md.");
    process.exit(2);
  }
  // §4.1 runs to the next heading, or to the end of the file.
  const next = text.indexOf("\n#", start + 1);
  const end = next === -1 ? text.length : next;
  const clauses = text
    .slice(start, end)
    .split("\n")
    .map((l) => l.match(/^\s*(\d)\.\s+(.*\S)\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[2]!.trim());

  if (clauses.length !== 7) {
    console.error(
      `FATAL: expected 7 clauses in §4.1, parsed ${clauses.length}. ` +
      `Either docs/DEFINITION-OF-DONE.md was edited or this parser is wrong. Do not proceed on a guess.`,
    );
    process.exit(2);
  }
  return clauses;
}

function loadRequirements(): Requirement[] {
  const out: Requirement[] = [];
  for (const f of ["traceability/requirements.yaml", "traceability/manual.yaml"]) {
    const p = resolve(ROOT, f);
    if (!existsSync(p)) continue;
    const parsed = parse(readFileSync(p, "utf8"));
    if (Array.isArray(parsed)) out.push(...(parsed as Requirement[]));
  }
  return out;
}

const SETTLED = new Set(["verified", "deviated", "waived"]);

/**
 * `met: null` means a human has to judge it (clause 6).
 * `vacuous: true` means the PRD maps no requirement of this kind to this epic, so there
 * is nothing to settle. That is NOT the same as met, and it is not a licence to pass —
 * it is a distinct outcome that gets printed as such.
 *
 * The vacuous case used to render as NOT MET forever, which is how a previous session
 * came to edit this file to make a clause pass instead. A measuring instrument that
 * cannot report "not applicable" invites someone to break it.
 */
type Verdict = { met: boolean | null; detail: string; vacuous?: boolean };

function main(): void {
  const epic = process.argv[2];
  if (!epic) {
    console.error("usage: pnpm doneness <epic>   e.g. pnpm doneness E1");
    process.exit(2);
  }

  const clauses = readClauses();
  const all = loadRequirements();
  const mine = all.filter((r) => r.epic === epic);
  const verdicts: Verdict[] = [];

  // 1 — all `must` requirements verified / deviated / waived
  const must = mine.filter((r) => r.priority === "must");
  const settled = must.filter((r) => SETTLED.has(r.status));
  verdicts[0] = {
    met: must.length > 0 && settled.length === must.length,
    detail: `${settled.length}/${must.length} must requirements are verified, deviated or waived` +
      (settled.length === must.length ? "" : ` — ${must.length - settled.length} outstanding`),
  };

  // 2 — every §56 acceptance criterion for the epic has a passing automated test
  const acc = mine.filter((r) => r.type === "acceptance");
  const accDone = acc.filter((r) => SETTLED.has(r.status));
  verdicts[1] = {
    met: acc.length > 0 && accDone.length === acc.length,
    vacuous: acc.length === 0,
    detail: acc.length === 0
      ? "PRD §56 defines no acceptance criteria for this epic. The extractor refuses to " +
        "orphan an acceptance criterion, so this is an absence in the specification, not " +
        "a mapping miss — nothing to settle."
      : `${accDone.length}/${acc.length} acceptance criteria settled`,
  };

  // 3 — every §55 user story has an e2e test or a dated manual checklist entry
  const stories = mine.filter((r) => r.type === "story");
  const storiesDone = stories.filter((r) => SETTLED.has(r.status));
  verdicts[2] = {
    met: stories.length > 0 && storiesDone.length === stories.length,
    vacuous: stories.length === 0,
    detail: stories.length === 0
      ? "PRD §55 defines no user-story group for this epic. It is an internal service " +
        "with no user-facing story of its own; its behaviour is settled by clauses 1, 2 " +
        "and 4. Nothing to settle here."
      : `${storiesDone.length}/${stories.length} user stories settled` +
        (storiesDone.length === stories.length ? "" :
          ` — outstanding: ${stories.filter((r) => !SETTLED.has(r.status)).map((r) => r.id).join(", ")}`),
  };

  // 4 — ALL FIVE guardrail suites green. Not "the relevant ones". All five.
  const SUITES = ["tenancy", "epistemic-authority", "grounding", "injection", "audit-integrity"];
  const guardrailsDir = resolve(ROOT, "guardrails");
  let newestSourceMtime = 0;
  let newestSourceFile = "";
  if (existsSync(guardrailsDir)) {
    for (const entry of readdirSync(guardrailsDir)) {
      if (entry.endsWith(".ts")) {
        const entryPath = resolve(guardrailsDir, entry);
        const mtime = statSync(entryPath).mtimeMs;
        if (mtime > newestSourceMtime) {
          newestSourceMtime = mtime;
          newestSourceFile = entry;
        }
      }
    }
  }

  let state: Record<string, string> = {};
  let staleReason: string | null = null;
  if (!existsSync(GUARDRAIL_STATE)) {
    staleReason = "guardrails/.last-run.json does not exist. Run `pnpm guardrails`.";
  } else {
    const lastRunMtime = statSync(GUARDRAIL_STATE).mtimeMs;
    if (lastRunMtime < newestSourceMtime) {
      staleReason = `guardrails/.last-run.json is STALE (older than guardrails/${newestSourceFile}). Run \`pnpm guardrails\`.`;
    } else {
      try {
        state = JSON.parse(readFileSync(GUARDRAIL_STATE, "utf8")) as Record<string, string>;
      } catch {
        staleReason = "guardrails/.last-run.json is invalid JSON. Run `pnpm guardrails`.";
      }
    }
  }

  if (staleReason) {
    verdicts[3] = {
      met: false,
      detail: staleReason,
    };
  } else {
    const notGreen = SUITES.filter((s) => state[s] !== "green");
    verdicts[3] = {
      met: notGreen.length === 0,
      detail: notGreen.length === 0
        ? "all five suites green"
        : `not green: ${notGreen.map((s) => `${s}=${state[s] ?? "not run"}`).join(", ")}`,
    };
  }

  // 5 — relevant §49 performance targets benchmarked at the §53.5 scale envelope
  // The clause says "the RELEVANT §49 performance targets" — this epic's, not all of
  // them. This filtered `all` instead of `mine` and so measured every epic against the
  // same seventeen global targets, which made the clause identical for E1 through E12
  // and unmeetable by any of them. All seventeen also sat in E0, where nothing owned
  // them. Both halves of that bug are fixed: the extractor attributes each target to the
  // epic that has to hit it, and this reads only that epic's.
  const perf = mine.filter((r) => r.type === "perf");
  const perfDone = perf.filter((r) => SETTLED.has(r.status));
  verdicts[4] = {
    met: perf.length > 0 && perfDone.length === perf.length,
    vacuous: perf.length === 0,
    detail: perf.length === 0
      ? "PRD §49 names no performance target for this epic. Nothing to benchmark."
      : `${perfDone.length}/${perf.length} §49 performance targets for this epic settled ` +
        `(${perf.map((r) => r.id).join(", ")}). A measurement below the §53.5 scale ` +
        `envelope does not settle one.`,
  };

  // 6 — PROGRESS.md updated. Presence is checkable; adequacy is not.
  const progress = resolve(ROOT, "docs/PROGRESS.md");
  verdicts[5] = {
    met: null,
    detail: existsSync(progress)
      ? "docs/PROGRESS.md exists — a human must confirm it records this epic's completion, " +
        "its deviation list and any new decisions"
      : "docs/PROGRESS.md is MISSING",
  };

  // 7 — a demo script exists
  const demo = resolve(ROOT, `docs/demos/${epic}.md`);
  verdicts[6] = {
    met: existsSync(demo),
    detail: existsSync(demo) ? `docs/demos/${epic}.md exists` : `docs/demos/${epic}.md does NOT exist`,
  };

  // ---- render ----------------------------------------------------------
  console.log(`\nDEFINITION OF DONE — ${epic}`);
  console.log(`Clauses read verbatim from docs/DEFINITION-OF-DONE.md §4.1 at runtime.`);
  console.log("─".repeat(78));

  let failed = 0;
  let vacuous = 0;
  clauses.forEach((clause, i) => {
    const v = verdicts[i]!;
    const mark = v.vacuous ? "➖ N/A    "
      : v.met === true ? "✅ MET    "
      : v.met === null ? "❓ MANUAL "
      : "❌ NOT MET";
    if (v.met === false && !v.vacuous) failed += 1;
    if (v.vacuous) vacuous += 1;
    console.log(`\n${mark} clause ${i + 1}`);
    console.log(`   "${clause}"`);
    console.log(`   → ${v.detail}`);
  });

  console.log("\n" + "─".repeat(78));
  if (failed === 0) {
    console.log(`${epic}: every mechanically checkable clause is MET` +
      (vacuous > 0 ? `, ${vacuous} not applicable` : "") +
      `. Clause 6 needs a human.`);
    process.exit(0);
  }
  console.log(`${epic} IS NOT DONE — ${failed} of 7 clauses not met.`);
  console.log(`There is no partial completion (§4.1). Do not describe this epic as complete,`);
  console.log(`nearly complete, or complete-except-for; describe it as not done.`);
  process.exit(1);
}

main();
