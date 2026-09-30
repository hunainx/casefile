#!/usr/bin/env tsx
/**
 * Verification audit and repair.
 *
 *   pnpm audit:verification            report only
 *   pnpm audit:verification --reset    reset unsound claims to not_started
 *
 * WHY THIS EXISTS
 *
 * Four epics were verified by scripts of the form:
 *
 *     for (const req of reqs) { if (req.epic === 'E8') { req.status = 'verified' } }
 *
 * That marked 134 requirements verified in one pass, with artifact lists chosen by
 * matching the id prefix. The claims are not false because the code is missing — much
 * of the code exists and its tests pass — they are false because nobody checked that
 * each test proves the requirement it is attached to. A traceability database whose
 * entries were assigned rather than earned reports a number nobody can act on.
 *
 * This tool finds the claims that cannot be trusted, using signatures that only bulk
 * assignment produces, and can reset them so the database says "unknown" instead of
 * "proven". Unknown is recoverable. A false "proven" is not, because nobody looks again.
 *
 * It deliberately does NOT reset requirements verified with a small, distinctive
 * artifact set. Legitimate grouping exists: one end-to-end flow test can genuinely
 * prove three related user stories, and E2 was verified that way under review.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["traceability/requirements.yaml", "traceability/manual.yaml"];

/**
 * A cluster this large cannot be the product of reading each statement. Under review,
 * the largest honest cluster in this repository was three (one investigation flow test
 * covering three related stories). Eight leaves generous room for that.
 */
const CLUSTER_LIMIT = 8;

interface Requirement {
  id: string;
  type: string;
  epic: string;
  priority: string;
  status: string;
  statement?: string;
  verification?: { method?: string[]; artifacts?: string[] };
  notes?: string;
  verified_at?: string | null;
}

type Reason = "cluster" | "eval_without_harness" | "no_artifact";

interface Finding {
  id: string;
  epic: string;
  type: string;
  reason: Reason;
  detail: string;
}

function load(file: string): Requirement[] {
  const p = resolve(ROOT, file);
  if (!existsSync(p)) return [];
  const parsed = parse(readFileSync(p, "utf8"));
  return Array.isArray(parsed) ? (parsed as Requirement[]) : [];
}

function artifactKey(r: Requirement): string {
  return JSON.stringify([...(r.verification?.artifacts ?? [])].sort());
}

export function audit(all: Requirement[]): { findings: Finding[]; clusters: Map<string, number> } {
  const verified = all.filter((r) => r.status === "verified");
  const clusters = new Map<string, number>();
  for (const r of verified) {
    const k = artifactKey(r);
    clusters.set(k, (clusters.get(k) ?? 0) + 1);
  }

  const findings: Finding[] = [];
  for (const r of verified) {
    const arts = r.verification?.artifacts ?? [];
    const methods = r.verification?.method ?? [];

    if ((r.notes ?? "").includes("CLUSTER-ACCEPTED:")) continue;

    if (arts.length === 0) {
      findings.push({ id: r.id, epic: r.epic, type: r.type, reason: "no_artifact",
        detail: "verified with no artifact at all" });
      continue;
    }

    // §61.3 thresholds are measured by evals/harness/run.py against the corpora in
    // evals/corpora. No integration test can measure a fabrication rate or a
    // false-merge rate — those need labelled ground truth and a scoring pass.
    if (r.type === "ai_eval" && !methods.includes("eval")) {
      findings.push({ id: r.id, epic: r.epic, type: r.type, reason: "eval_without_harness",
        detail: `§61.3 threshold verified by [${methods.join(", ") || "none"}] instead of the ` +
                `eval harness. Three of these are hard gates.` });
      continue;
    }

    const n = clusters.get(artifactKey(r)) ?? 1;
    if (n > CLUSTER_LIMIT) {
      findings.push({ id: r.id, epic: r.epic, type: r.type, reason: "cluster",
        detail: `shares an identical artifact list with ${n - 1} other verified requirements` });
    }
  }
  return { findings, clusters };
}

function main(): void {
  const doReset = process.argv.includes("--reset");
  const all = FILES.flatMap(load);
  if (all.length === 0) {
    console.error("FATAL: no requirements loaded.");
    process.exit(2);
  }

  const { findings, clusters } = audit(all);
  const verified = all.filter((r) => r.status === "verified").length;

  console.log("\nVERIFICATION AUDIT");
  console.log("─".repeat(78));
  console.log(`  ${all.length} requirements · ${verified} verified · ${findings.length} unsound\n`);

  const big = [...clusters.entries()].filter(([, n]) => n > CLUSTER_LIMIT).sort((a, b) => b[1] - a[1]);
  if (big.length > 0) {
    console.log(`  CLUSTERS ABOVE ${CLUSTER_LIMIT} (only bulk assignment produces these)`);
    for (const [k, n] of big) {
      const arts = (JSON.parse(k) as string[]).join(", ");
      console.log(`    ${String(n).padStart(4)}  ${arts.slice(0, 96)}${arts.length > 96 ? "…" : ""}`);
    }
    console.log("");
  }

  const byReason = new Map<Reason, Finding[]>();
  for (const f of findings) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f]);
  for (const [reason, list] of byReason) {
    console.log(`  ${reason}  (${list.length})`);
    const byEpic = new Map<string, number>();
    for (const f of list) byEpic.set(f.epic, (byEpic.get(f.epic) ?? 0) + 1);
    console.log(`    by epic: ${[...byEpic].sort().map(([e, n]) => `${e}=${n}`).join("  ")}`);
    console.log(`    e.g. ${list[0]!.id} — ${list[0]!.detail}`);
    console.log("");
  }

  if (!doReset) {
    console.log("─".repeat(78));
    console.log(`  Report only. Re-run with --reset to set these ${findings.length} back to`);
    console.log(`  not_started, which is the honest status for a claim nobody checked.`);
    console.log(`  Code and tests are untouched — only the claims about them.\n`);
    process.exit(findings.length > 0 ? 1 : 0);
  }

  const ids = new Set(findings.map((f) => f.id));
  const stamp = new Date().toISOString().slice(0, 10);
  let reset = 0;

  for (const file of FILES) {
    const p = resolve(ROOT, file);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    const out: string[] = [];
    let current: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = line.match(/^- id:\s*(\S+)/);
      if (m) { current = m[1]!; out.push(line); continue; }

      if (!current || !ids.has(current)) { out.push(line); continue; }

      // A value may span lines — `notes: >` followed by an indented block, or a
      // wrapped quoted string. Replacing only the key line and leaving its
      // continuation behind produces a file that no longer parses, which is a worse
      // outcome than the problem being fixed. So consume the whole value.
      const consumeValue = (): void => {
        while (i + 1 < lines.length) {
          const next = lines[i + 1]!;
          if (next.trim() === "") break;
          if (/^- id:/.test(next)) break;
          if (/^ {2}\S/.test(next)) break;   // next key at this level
          i += 1;                            // still part of this value
        }
      };

      if (/^ {2}status:/.test(line)) {
        out.push("  status: not_started"); consumeValue(); reset += 1;
      } else if (/^ {2}verified_at:/.test(line)) {
        out.push("  verified_at: null"); consumeValue();
      } else if (/^ {2}notes:/.test(line)) {
        out.push(`  notes: "RESET ${stamp} by verification audit — was marked verified by ` +
          `bulk assignment, never checked against its own statement. Re-verify one at a time."`);
        consumeValue();
      } else {
        out.push(line);
      }
    }
    writeFileSync(p, out.join("\n"), "utf8");
  }

  console.log("─".repeat(78));
  console.log(`  Reset ${reset} claims to not_started. No code or test was changed.`);
  console.log(`  Run \`pnpm trace:report\` for the honest coverage number, then re-verify`);
  console.log(`  one requirement at a time with a named test per clause.\n`);
}

main();
