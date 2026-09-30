import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import ts from "typescript";

function findTestFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".git" && entry.name !== ".tmp-test-fixtures") {
          files.push(...findTestFiles(full));
        }
      } else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) {
        files.push(full);
      }
    }
  } catch {
    // Directory might not exist
  }
  return files;
}

interface HollowViolation {
  file: string;
  line: number;
  testName: string;
  condition: string;
  reason: string;
}

function hasAssertion(node: ts.Node): boolean {
  let found = false;
  function visit(n: ts.Node) {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      if (ts.isIdentifier(expr) && expr.text === "expect") {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(expr)) {
        if (ts.isIdentifier(expr.expression) && expr.expression.text === "expect") {
          found = true;
          return;
        }
        if (expr.name.text === "fail") {
          // expect.fail or assert.fail is an intentional failure/guard, not a bypassed assertion
        }
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function isHollowCondition(cond: ts.Expression): { isHollow: boolean; description: string } {
  let hasInstanceOf = false;
  let hasProcessEnv = false;

  function walk(n: ts.Node) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      hasInstanceOf = true;
    }
    if (ts.isPropertyAccessExpression(n)) {
      if (
        ts.isIdentifier(n.expression) &&
        n.expression.text === "process" &&
        n.name.text === "env"
      ) {
        hasProcessEnv = true;
      }
    }
    ts.forEachChild(n, walk);
  }

  walk(cond);

  if (hasInstanceOf) {
    return { isHollow: true, description: "instanceof check guarding assertions" };
  }
  if (hasProcessEnv) {
    return { isHollow: true, description: "process.env check guarding assertions" };
  }
  return { isHollow: false, description: "" };
}

describe("guardrails/no-hollow-tests — No Conditional Assertion Bypasses", () => {
  const projectRoot = resolve(__dirname, "..");
  const testFiles = [
    ...findTestFiles(resolve(projectRoot, "packages")),
    ...findTestFiles(resolve(projectRoot, "apps")),
    ...findTestFiles(resolve(projectRoot, "tools")),
  ];

  it("fails if tests wrap assertions in conditionals that permit silent passes", () => {
    const violations: HollowViolation[] = [];

    for (const filePath of testFiles) {
      // Don't scan guardrails themselves
      if (filePath.includes("guardrails")) continue;

      const code = readFileSync(filePath, "utf-8");
      const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);

      function visit(node: ts.Node, currentTestName = "") {
        let testName = currentTestName;
        if (ts.isCallExpression(node)) {
          const fn = node.expression;
          const isTestCall =
            (ts.isIdentifier(fn) && (fn.text === "it" || fn.text === "test")) ||
            (ts.isPropertyAccessExpression(fn) &&
              ts.isIdentifier(fn.expression) &&
              (fn.expression.text === "it" || fn.expression.text === "test"));

          if (isTestCall && node.arguments.length >= 1) {
            const arg0 = node.arguments[0];
            if (arg0 && ts.isStringLiteral(arg0)) {
              testName = arg0.text;
            }
          }
        }

        if (testName && ts.isIfStatement(node)) {
          const check = isHollowCondition(node.expression);
          if (check.isHollow) {
            // Check if assertions exist inside the then statement
            if (hasAssertion(node.thenStatement)) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
              violations.push({
                file: relative(projectRoot, filePath).replace(/\\/g, "/"),
                line: line + 1,
                testName,
                condition: node.expression.getText(sf),
                reason: `Test wraps assertions inside '${node.expression.getText(sf)}' (${check.description}), allowing silent test passes when false.`,
              });
            }
          }
        }

        ts.forEachChild(node, (child) => visit(child, testName));
      }

      visit(sf);
    }

    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  - ${v.file}:${v.line}\n` +
            `    Test: "${v.testName}"\n` +
            `    Condition: ${v.condition}\n` +
            `    Reason: ${v.reason}\n`,
        )
        .join("\n");

      expect.fail(
        `Found ${violations.length} hollow test pattern(s) with conditional assertions:\n\n${formatted}\n` +
          `A test named for more than it asserts is forbidden. Either assert unconditionally or fail loudly.`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
