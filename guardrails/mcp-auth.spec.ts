/**
 * GUARDRAIL: mcp-auth  —  docs/PLAN-MCP-AUTH.md section 7  ·  decisions D73, D74
 *
 * /mcp is reachable from the public internet (Claude calls it from Anthropic's cloud). Every
 * route under /mcp and /mcp/ must go through the /mcp auth gate (apps/api/src/mcp/auth.ts),
 * which accepts only this deployment's OAuth access token. A route added later without it
 * would hand case documents to anyone.
 *
 * This suite builds the real app in its default mode, records every route as Fastify
 * registers it, and:
 *   1. sends every route under /mcp and /mcp/ a request with no token, and fails on any
 *      answer other than 401 with the sign-in hint (WWW-Authenticate resource_metadata);
 *   2. fails if any /mcp route — public: true or not — lacks the auth gate as its first
 *      preHandler.
 * It is not a list of known routes: a new /mcp route is checked the moment it exists.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildApp } from "../apps/api/src/app.js";
import { isMcpAuthGate } from "../apps/api/src/mcp/auth.js";

interface SeenRoute {
  method: string;
  url: string;
  isPublic: boolean;
  preHandlers: unknown[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isMcpPath = (url: string) => url === "/mcp" || url.startsWith("/mcp/");

describe("guardrails/mcp-auth — every /mcp route is behind the OAuth auth gate", () => {
  let app: ReturnType<typeof buildApp>;
  const seen: SeenRoute[] = [];

  beforeAll(async () => {
    app = buildApp();
    // Added before ready(): the route plugins are loaded during ready(), so this hook sees
    // every route registered by every plugin.
    app.addHook("onRoute", (route: { method: string | string[]; url: string; config?: unknown; preHandler?: unknown }) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const pre = route.preHandler;
      const config = route.config;
      for (const method of methods) {
        seen.push({
          method: String(method).toUpperCase(),
          url: route.url,
          isPublic: typeof config === "object" && config !== null && Reflect.get(config, "public") === true,
          preHandlers: pre === undefined ? [] : Array.isArray(pre) ? pre : [pre],
        });
      }
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const mcpRoutes = () => seen.filter((r) => isMcpPath(r.url) && r.method !== "OPTIONS");

  it("finds the /mcp routes (the checks below are not vacuous)", () => {
    const keys = mcpRoutes().map((r) => `${r.method} ${r.url}`);
    expect(keys).toContain("POST /mcp");
    expect(keys).toContain("POST /mcp/");
  });

  it("every route under /mcp and /mcp/ answers a request without a token with 401 and the sign-in hint", async () => {
    const failures: string[] = [];
    for (const r of mcpRoutes()) {
      // Path parameters and wildcards get a placeholder segment; the gate runs before routing matters.
      const url = r.url.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
      const res = await app.inject({
        method: r.method as "GET",
        url,
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        ...(["POST", "PUT", "PATCH", "DELETE"].includes(r.method) ? { payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } } : {}),
      });
      const hint = String(res.headers["www-authenticate"] ?? "");
      if (res.statusCode !== 401 || !hint.includes("resource_metadata=")) {
        failures.push(`${r.method} ${r.url} -> ${res.statusCode} (WWW-Authenticate: ${hint || "none"}) ${res.body.slice(0, 200)}`);
      }
    }
    expect(failures, `/mcp routes reachable without a valid token:\n${failures.join("\n")}`).toEqual([]);
  });

  it("no /mcp route is registered public: true without the MCP auth gate", () => {
    const offenders = mcpRoutes()
      .filter((r) => r.isPublic && !r.preHandlers.some(isMcpAuthGate))
      .map((r) => `${r.method} ${r.url}`);
    expect(offenders, `public /mcp routes that bypass the MCP auth gate:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("every /mcp route runs the MCP auth gate first", () => {
    const offenders = mcpRoutes()
      .filter((r) => !isMcpAuthGate(r.preHandlers[0]))
      .map((r) => `${r.method} ${r.url} (preHandlers: ${r.preHandlers.length})`);
    expect(offenders, `/mcp routes whose first preHandler is not the MCP auth gate:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("MCP_AUTH_MODE and local-no-login are read in exactly one module, next to its startup refusal checks (plan section 7, D77)", () => {
    // Production TypeScript, tracked or not yet committed: a second reader in a new file counts.
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts"], { cwd: ROOT, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((f) => f !== "" && existsSync(resolve(ROOT, f)))
      .filter((f) => /^(apps|packages|tools)\/[^/]+\/src\//.test(f) || (f.startsWith("scripts/") && !f.startsWith("scripts/archive/")));
    const readers = new Map<string, number>();
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(resolve(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
      let hits = 0;
      const visit = (node: ts.Node) => {
        // Code only: identifiers (process.env.MCP_AUTH_MODE, a destructured name) and string or
        // template text (env["MCP_AUTH_MODE"], "local-no-login"). Comments are not code.
        if (ts.isIdentifier(node) && node.text === "MCP_AUTH_MODE") hits += 1;
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /MCP_AUTH_MODE|local-no-login/.test(node.text)) hits += 1;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      if (hits > 0) readers.set(file, hits);
    }
    expect(files.length, "the scan found no production files").toBeGreaterThan(50);
    const listed = [...readers].map(([f, n]) => `${f} (${n})`).join("\n");
    expect([...readers.keys()], `modules that read MCP_AUTH_MODE or name local-no-login:\n${listed}`).toEqual([
      "apps/api/src/mcp/local-mode.ts",
    ]);
    const source = readFileSync(resolve(ROOT, "apps/api/src/mcp/local-mode.ts"), "utf8");
    for (const check of ["resolveMcpAuthMode", "localNoLoginEnvProblems", "assertLocalNoLoginAllowed", "localNoLoginRequestProblem"]) {
      expect(source, `local-mode.ts must define ${check}`).toMatch(new RegExp(`export (async )?function ${check}\\b`));
    }
  });
});
