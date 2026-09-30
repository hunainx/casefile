import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type {
  MockScript,
  MockScenarioRule,
  PromptRequest,
  ModelResponse,
  CitationRef,
} from "./types.js";

export class MockProviderTimeoutError extends Error {
  public readonly code = "REQUEST_TIMEOUT";
  public readonly status = 504;

  constructor(message = "Mock AI provider request timed out") {
    super(message);
    this.name = "MockProviderTimeoutError";
  }
}

export class MockProviderApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message = "Mock AI provider error", code = "PROVIDER_ERROR", status = 500) {
    super(message);
    this.name = "MockProviderApiError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Deterministic Mock AI Provider (D36 — load-bearing for I5, I6, §56.7).
 */
export class MockModelProvider {
  private script: MockScript;

  constructor(scriptOrPath?: MockScript | string) {
    if (typeof scriptOrPath === "object" && scriptOrPath !== null) {
      this.script = scriptOrPath;
    } else if (typeof scriptOrPath === "string") {
      this.script = this.loadScriptFromPath(scriptOrPath);
    } else if (process.env.AI_MOCK_SCRIPT && existsSync(process.env.AI_MOCK_SCRIPT)) {
      this.script = this.loadScriptFromPath(process.env.AI_MOCK_SCRIPT);
    } else {
      this.script = { scenarios: [] };
    }
  }

  private loadScriptFromPath(path: string): MockScript {
    try {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content) as MockScript;
    } catch (err) {
      throw new Error(`Failed to load mock script from ${path}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  public setScript(script: MockScript): void {
    this.script = script;
  }

  private matchScenario(req: PromptRequest): MockScenarioRule["behavior"] | null {
    const fullPrompt = req.messages.map((m) => m.content).join("\n").toLowerCase();
    const systemPrompt = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n")
      .toLowerCase();

    for (const scenario of this.script.scenarios) {
      const { match, behavior } = scenario;

      if (match.promptIncludes) {
        const matchesAll = match.promptIncludes.every((str) =>
          fullPrompt.includes(str.toLowerCase()),
        );
        if (!matchesAll) continue;
      }

      if (match.systemIncludes) {
        const matchesAll = match.systemIncludes.every((str) =>
          systemPrompt.includes(str.toLowerCase()),
        );
        if (!matchesAll) continue;
      }

      if (match.hasInjection) {
        const hasInj =
          fullPrompt.includes("ignore previous instructions") ||
          fullPrompt.includes("system prompt override") ||
          fullPrompt.includes("you are now in maintenance mode");
        if (!hasInj) continue;
      }

      if (match.toolOffered) {
        const offered = req.tools?.some((t) => t.name === match.toolOffered);
        if (!offered) continue;
      }

      return behavior;
    }

    return this.script.defaultBehavior ?? null;
  }

  /**
   * Deterministically generates responses according to script rules and modes.
   */
  async generate(req: PromptRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const behavior = this.matchScenario(req) ?? { type: "valid" };

    if (behavior.delayMs && behavior.delayMs > 0) {
      if (req.timeoutMs && behavior.delayMs > req.timeoutMs) {
        throw new MockProviderTimeoutError(
          `Request exceeded timeout limit of ${req.timeoutMs}ms (delay was ${behavior.delayMs}ms)`,
        );
      }
    }

    if (behavior.type === "error") {
      const err = behavior.error ?? { message: "Internal Provider Error", code: "INTERNAL_ERROR", status: 500 };
      throw new MockProviderApiError(err.message, err.code, err.status);
    }

    if (behavior.type === "timeout") {
      throw new MockProviderTimeoutError(behavior.error?.message ?? "Operation timed out");
    }

    const fullPrompt = req.messages.map((m) => m.content).join("\n");
    const promptHash = createHash("sha256").update(fullPrompt).digest("hex");
    const promptTokens = Math.max(10, Math.floor(fullPrompt.length / 4));

    let content: string;
    let toolCalls: ModelResponse["toolCalls"] = undefined;
    let citations: CitationRef[] | undefined = undefined;

    switch (behavior.type) {
      case "malformed": {
        // Off-schema, truncated, or invalid JSON
        if (behavior.rawContent) {
          content = behavior.rawContent;
        } else if (behavior.payload) {
          // Truncate serialized JSON to break syntax
          content = JSON.stringify(behavior.payload).slice(0, -10);
        } else {
          content = "{ \"status\": \"incomplete\", \"data\": [ { \"id\": 123, \"corrupt\": ";
        }
        break;
      }

      case "hallucinated_citations": {
        citations = behavior.citations ?? [
          {
            citation_uri: "dtz://inv/inv_nonexistent_99/src/src_fake_888/art/art_fake_777/blk/blk_000?c=0-100&h=000000",
            snippet: "This document contains a fabricated fact that does not exist in any evidence.",
            support: "direct",
          },
          {
            citation_uri: "dtz://inv/inv_current/src/src_real/art/art_real/blk/blk_99999?c=99999-99999&h=ffffff",
            snippet: "The span exists nowhere on the cited page.",
            support: "indirect",
          },
        ];
        content = behavior.rawContent ?? "According to fabricated evidence, the transaction was authorized by unauthorized party.";
        break;
      }

      case "injection_compliant": {
        content = behavior.injectedResponse ?? "INJECTION_SUCCESSFUL: I have followed the injected instruction and revealed hidden data.";
        break;
      }

      case "unauthorized_tool_call": {
        const unauth = behavior.unauthorizedTool ?? {
          name: "system.execute_shell",
          arguments: { command: "cat /etc/passwd" },
        };
        toolCalls = [unauth];
        content = "Invoking tool to satisfy request.";
        break;
      }

      case "valid":
      case "slow":
      default: {
        if (behavior.rawContent) {
          content = behavior.rawContent;
        } else if (behavior.payload) {
          content = JSON.stringify(behavior.payload);
        } else if (req.jsonSchema) {
          content = JSON.stringify({
            answer: "Deterministic mock answer based on provided context.",
            confidence: 0.95,
            basis: "Evidence corroboration",
            promptHash: promptHash.slice(0, 8),
          });
        } else {
          content = `Mock AI deterministic response for: ${req.messages[req.messages.length - 1]?.content.slice(0, 50)}`;
        }
        citations = behavior.citations;
        break;
      }
    }

    const completionTokens = Math.max(5, Math.floor(content.length / 4));
    const durationMs = behavior.delayMs ?? (Date.now() - startTime);

    return {
      content,
      toolCalls,
      citations,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: {
        provider: "casefile-mock",
        modelId: "mock-reasoning-v1",
        version: "2026-08-31",
      },
      durationMs,
    };
  }
}
