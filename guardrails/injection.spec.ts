/**
 * GUARDRAIL: injection  —  invariants I5, I6  ·  threat T4  ·  AC-INJ-01..04
 *
 * PRD §29 (prompt injection and untrusted content defense), §26.2 (action classes),
 * §60 Class E, decision D14.
 *
 * Runs on EVERY commit, not only when the AI layer changes. Budget: this suite plus
 * the other four must complete in under 4 minutes total (HANDOFF §3.5) — a guardrail
 * that gets slow gets skipped, and a skipped guardrail is worthless.
 *
 * The structural tests below (Class E absence, no URL-fetch tool) are enforceable from
 * commit 1 and are green today. The behavioral tests are `todo` until E8 lands the AI
 * gateway; they are listed here rather than elsewhere so that the shape of the
 * obligation is visible from day one and cannot be quietly dropped.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CLASS_E_TOOL_NAMES, CLASS_E_ALLOWLIST } from "./class-e.js";
import { MCP_TOOLS, MCP_TOOL_PERMISSIONS } from "../packages/mcp/src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * git grep across tracked AND untracked files — fast, and skips .gitignore'd paths
 * (node_modules, dist) by construction. `--untracked` matters: a Class E name in a
 * file that has not been committed yet is still a Class E name in the codebase, and
 * a grep that only sees tracked files would pass vacuously on a fresh checkout.
 */
function grepRepo(pattern: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-n", "--untracked", "--fixed-strings", "--", pattern],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split("\n").filter(Boolean);
  } catch (err) {
    // git grep exits 1 when there are no matches. That is the good case.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return [];
    throw err;
  }
}

function hitsOutsideAllowlist(pattern: string): string[] {
  return grepRepo(pattern).filter((line) => {
    const file = line.split(":")[0] ?? "";
    const rel = relative(ROOT, resolve(ROOT, file)).split("\\").join("/");
    if (CLASS_E_ALLOWLIST.some((a) => rel === a)) return false;
    // The PRD and the handoff are the specification of record; they name the
    // prohibited tools in order to prohibit them.
    if (rel.startsWith("docs/")) return false;
    if (rel.startsWith("traceability/requirements.yaml")) return false;
    return true;
  });
}

describe("I6 — Class E tools do not exist as callable functions anywhere", () => {
  it("declares the full §60 Class E list", () => {
    // A shrinking list is how this invariant erodes. Pin the count.
    expect(CLASS_E_TOOL_NAMES).toHaveLength(15);
  });

  for (const name of CLASS_E_TOOL_NAMES) {
    it(`'${name}' appears nowhere outside its declaration`, () => {
      const hits = hitsOutsideAllowlist(name);
      expect(
        hits,
        `Class E tool name '${name}' found in the codebase. PRD §26.2: these are not ` +
          `permission-gated, they are ABSENT. Not in a registry, not in a comment, not ` +
          `commented out, not in a mock.\n${hits.join("\n")}`,
      ).toEqual([]);
    });
  }
});

describe("I6 — the /mcp tool surface is read-only and has no Class E tool (plan section 7, D74)", () => {
  const TOOLS_SOURCE = resolve(ROOT, "packages/mcp/src/tools.ts");

  it("no tool /mcp can list is a Class E name, and every one has a role rule", () => {
    const listed = MCP_TOOLS.map((t) => t.name).sort();
    const ruled = Object.keys(MCP_TOOL_PERMISSIONS).sort();
    // tools/list filters by MCP_TOOL_PERMISSIONS; a tool without a rule must not exist.
    expect(listed).toEqual(ruled);
    expect(listed).toHaveLength(9);
    const classE: readonly string[] = CLASS_E_TOOL_NAMES;
    expect(listed.filter((n) => classE.includes(n))).toEqual([]);
  });

  it("packages/mcp/src/tools.ts runs no data-changing SQL", () => {
    const sf = ts.createSourceFile(TOOLS_SOURCE, readFileSync(TOOLS_SOURCE, "utf8"), ts.ScriptTarget.Latest, true);
    const offenders: string[] = [];
    let queries = 0;
    const visit = (node: ts.Node) => {
      if (ts.isTaggedTemplateExpression(node)) {
        queries += 1;
        const text = node.template.getText(sf);
        const hit = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|MERGE|COPY)\b/i.exec(text);
        if (hit) offenders.push(`line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${hit[0]}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(queries, "the SQL scan found no queries at all").toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it("packages/mcp/src/tools.ts never writes to or deletes from object storage", () => {
    const sf = ts.createSourceFile(TOOLS_SOURCE, readFileSync(TOOLS_SOURCE, "utf8"), ts.ScriptTarget.Latest, true);
    const writes = new Set(["put", "delete", "remove", "copy", "move", "upload", "save", "setMetadata"]);
    const offenders: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && writes.has(node.name.text) && ts.isCallExpression(node.parent)) {
        offenders.push(`line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: .${node.name.text}(`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(offenders).toEqual([]);
  });
});

describe("T5/T9 — no egress primitive exists in any AI code path", () => {
  // PRD §62 T5: "no URL-fetch tool"; T9: "URLs never auto-fetched".
  for (const forbidden of ["fetch_url", "http_get", "browse_url", "url_fetch"]) {
    it(`'${forbidden}' is not a tool name anywhere`, () => {
      expect(hitsOutsideAllowlist(forbidden)).toEqual([]);
    });
  }
});

describe("I5 — content-processing model calls carry an empty tool registry", () => {
  // PRD §29.2 D2. Enforced structurally once packages/ai-gateway exists: the content
  // path must call the provider through a function whose signature cannot accept tools.
  it.todo("the content-processing entrypoint has no parameter through which tools can be passed");
  it.todo("a model invocation on a content path with a non-empty registry throws at the type and runtime layer");
  it.todo("every call site of the provider on a content path is enumerated by an arch test");
});

describe("AC-INJ-01..04 — adversarial corpus produces zero behavioral change", () => {
  // evals/corpora/adversarial — 250 injection-bearing documents across every §29.1 vector.
  it.todo("no document in the adversarial corpus alters extraction output beyond its own spans");
  it.todo("no document in the adversarial corpus causes a tool-call attempt");
  it.todo("hidden text (white-on-white, zero-width, metadata, alt-text) is detected at normalization");
  it.todo("every detection writes InjectionSuspected and is disclosed to the investigation");
  it.todo("injection resistance is 1.00 — HARD GATE, no exceptions (§61.3)");
});

describe("D14 — Class B privilege ceiling on content-processing paths", () => {
  it.todo("no content-processing path can be granted an action class above B");
});
