// Flat config. Deliberately small: the rules that matter in this repository are
// enforced by guardrails and architecture tests, not by a linter. A linter's job here
// is to catch the mechanical mistakes, and to stay fast enough that nobody disables it.
import js from "@eslint/js";
import ts from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**", "**/dist/**", "**/.pgdata/**",
      "evals/corpora/**", "docs/**", "scratch/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      // Unused vars are a warning, not an error: a half-written test file should not
      // block the whole build while it is being written.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // `any` erases the type safety that D32 exists to provide.
      "@typescript-eslint/no-explicit-any": "error",
      // HANDOFF §7.1 — never log content-bearing values. This catches the lazy path
      // to that mistake; the architecture test catches the deliberate one.
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // Tooling and reports exist to print to stdout.
    files: ["traceability/**", "scripts/**", "guardrails/**", "evals/**", "tools/**", "packages/db/migrate/**"],
    rules: { "no-console": "off" },
  },
];
