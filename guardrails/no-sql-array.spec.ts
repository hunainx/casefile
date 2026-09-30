import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * D68: postgres.js's `sql.array()` is banned.
 *
 * postgres.js learns array types by querying pg_type when a client's first connection opens.
 * `sql.array()` picks its array type while the query is being built, and the query that
 * opens the connection is built before that lookup is applied. On a new client — every
 * Cloud Run cold start — `sql.array(["a","b"])` is therefore sent as the text "a,b":
 * Postgres answers "malformed array literal", or stores the wrong value where the slot is
 * text. Plain JS arrays are not affected (their type comes from the server's description of
 * the statement), so pass the array itself: `WHERE id = ANY(${ids})`, `VALUES (${ids})`.
 *
 * packages/db/test/array-params-first-query.integration.test.ts demonstrates the failure on
 * purpose; it is the only file allowed to call it, and only EXPECTED_DEMO_CALLS times.
 */
const DEMO_FILE = "packages/db/test/array-params-first-query.integration.test.ts";
const EXPECTED_DEMO_CALLS = 2;

/** Tracked source plus untracked files that are not ignored, so a new file is caught before its first commit. */
function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\0")
    .filter((f) => /\.(ts|mts|cts|tsx)$/.test(f) && !f.endsWith(".d.ts"))
    .map((f) => resolve(ROOT, f));
}

function findSqlArrayUses(): Array<{ file: string; line: number; text: string }> {
  const program = ts.createProgram(sourceFiles(), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    baseUrl: ROOT,
    paths: Object.fromEntries(
      ["db", "audit", "policy", "contracts", "storage", "mock-provider", "mcp"].flatMap((p) => [
        [`@casefile/${p}`, [`packages/${p}/src/index.ts`]],
        [`@casefile/${p}/*`, [`packages/${p}/src/*`]],
      ]),
    ),
  });
  const checker = program.getTypeChecker();

  // A postgres.js tag (Sql, TransactionSql, ReservedSql) is recognised by its shape, so a
  // rename or an alias does not hide it. If the type did not resolve, fall back to the names
  // this repo gives its tags.
  const isPostgresTag = (node: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(node);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      const name = node.getText().replace(/!$/, "").split(".").pop() ?? "";
      return /^(sql|tx|trx|db|conn|client)$|Sql$|Db$|Tx$/.test(name);
    }
    return ["array", "unsafe", "json"].every((p) => type.getProperty(p) !== undefined);
  };

  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !resolve(sf.fileName).startsWith(ROOT) || sf.fileName.includes("node_modules")) continue;
    const record = (node: ts.Node) =>
      hits.push({
        file: resolve(sf.fileName).slice(ROOT.length + 1).replace(/\\/g, "/"),
        line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.getText().replace(/\s+/g, " ").slice(0, 100),
      });
    const visit = (node: ts.Node): void => {
      // sql.array(...), tx.array(...), req.tx!.array(...), sql["array"](...)
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "array" && isPostgresTag(callee.expression)) record(node);
        if (
          ts.isElementAccessExpression(callee) &&
          ts.isStringLiteralLike(callee.argumentExpression) &&
          callee.argumentExpression.text === "array" &&
          isPostgresTag(callee.expression)
        ) {
          record(node);
        }
      }
      // const { array } = sql
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isPostgresTag(node.initializer)) {
        if (node.name.elements.some((e) => (e.propertyName ?? e.name).getText() === "array")) record(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("GUARDRAIL D68: postgres.js sql.array() is banned", () => {
  const hits = findSqlArrayUses();
  const format = (h: { file: string; line: number; text: string }) => `  ${h.file}:${h.line}  ${h.text}`;

  it("no source file calls sql.array() (or .array() on any postgres.js tag)", () => {
    const violations = hits.filter((h) => h.file !== DEMO_FILE);
    expect(
      violations,
      `postgres.js sql.array() is banned (D68, docs/DECISIONS.md). On a new client's first query it ` +
        `sends the array as text ("a,b") and Postgres fails with "malformed array literal". Pass the ` +
        `JS array itself instead, e.g. WHERE id = ANY(\${ids}).\n${violations.map(format).join("\n")}`,
    ).toEqual([]);
  });

  it(`the documented demonstration in ${DEMO_FILE} is the only exemption and has exactly ${EXPECTED_DEMO_CALLS} calls`, () => {
    const demo = hits.filter((h) => h.file === DEMO_FILE);
    expect(demo.length, `expected exactly ${EXPECTED_DEMO_CALLS} demonstration calls:\n${demo.map(format).join("\n")}`).toBe(
      EXPECTED_DEMO_CALLS,
    );
  });
});
