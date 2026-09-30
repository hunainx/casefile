export type MockBehaviorType =
  | "valid"
  | "malformed"
  | "hallucinated_citations"
  | "injection_compliant"
  | "unauthorized_tool_call"
  | "error"
  | "timeout"
  | "slow";

export interface CitationRef {
  citation_uri: string;
  snippet?: string;
  locator?: {
    artifact_id?: string;
    block_id?: string;
    page?: number;
    char_start?: number;
    char_end?: number;
  };
  support?: "direct" | "indirect" | "inferred";
}

export interface MockScenarioRule {
  id?: string;
  match: {
    promptIncludes?: string[];
    systemIncludes?: string[];
    hasInjection?: boolean;
    toolOffered?: string;
  };
  behavior: {
    type: MockBehaviorType;
    payload?: unknown;
    rawContent?: string;
    citations?: CitationRef[];
    injectedResponse?: string;
    unauthorizedTool?: {
      name: string;
      arguments: Record<string, unknown>;
    };
    error?: {
      message: string;
      code?: string;
      status?: number;
    };
    delayMs?: number;
  };
}

export interface MockScript {
  version?: string;
  scenarios: MockScenarioRule[];
  defaultBehavior?: MockScenarioRule["behavior"];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface PromptRequest {
  messages: PromptMessage[];
  tools?: ToolDefinition[];
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  requestId?: string;
  timeoutMs?: number;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls?: ToolCall[] | undefined;
  citations?: CitationRef[] | undefined;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: {
    provider: string;
    modelId: string;
    version: string;
  };
  durationMs: number;
}
