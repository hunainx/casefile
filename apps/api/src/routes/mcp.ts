import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerMatterTools } from "@casefile/mcp";
import "../types.js";
import type { createMcpAuthGate } from "../mcp/auth.js";

export interface McpRoutesOptions {
  /**
   * The /mcp auth gate (D73, D77), built by app.ts with the database client, so this route file
   * never holds one. It establishes req.mcpCaller or answers the request itself.
   */
  authGate: ReturnType<typeof createMcpAuthGate>;
}

export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (fastify, opts) => {
  const mcpAuthGate = opts.authGate;

  /**
   * POST /mcp — MCP Streamable HTTP transport from the official SDK, stateless (D67).
   *
   * Every request gets a fresh SDK server and transport: no Mcp-Session-Id, nothing kept in
   * memory between requests, so any Cloud Run instance can answer any request. Replies are
   * plain JSON (enableJsonResponse), never an SSE stream. The SDK negotiates the protocol
   * version and answers notifications with 202 and no body.
   *
   * The tools, their role checks and their audit rows come from packages/mcp/src/dispatch.ts,
   * the same code the stdio CLI runs (D74, D77); here they run in the request's tenant
   * transaction as the caller the auth gate established.
   *
   * D64 holds without hijacking the reply. The web-standard transport never touches the
   * socket: handleRequest() resolves to a Response once every JSON-RPC reply in the request
   * is ready, i.e. after the tool handlers (which query req.tx) have finished. Its body is
   * then passed to reply.send(), which the onRoute wrapper in app.ts holds back until the
   * tenant transaction has committed. Because Fastify still sends the reply, its onSend
   * hooks and error handler run for /mcp exactly as they do for every other route. The audit
   * rows a tool call writes are in that same transaction, so they are committed before the
   * reply leaves.
   */
  const handleMcpPost = async (req: FastifyRequest, reply: FastifyReply) => {
    const caller = req.mcpCaller!;
    const tx = req.tx!;
    let failure: unknown;
    const server = new Server({ name: "casefile-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    registerMatterTools(server, {
      caller: async () => caller,
      inTx: (fn) => fn(tx),
      requestId: () => req.id,
      onAuditFailure: (err) => {
        failure = err;
      },
    });
    // No sessionIdGenerator: that is the SDK's stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(toWebRequest(req), { parsedBody: req.body });
      // A failure to write an audit row fails the whole request: the transaction rolls back
      // and the error handler answers, so no tool output leaves without its audit row.
      if (failure !== undefined) throw failure;
      reply.status(response.status);
      response.headers.forEach((value, name) => {
        reply.header(name, value);
      });
      const body = await response.text();
      return reply.send(body === "" ? undefined : body);
    } finally {
      await server.close();
    }
  };

  // GET would open a standalone SSE stream and DELETE would end a session; a stateless
  // server has neither, so both are refused with 405. They sit behind the same auth gate,
  // so without a valid token they get 401 like every other /mcp route
  // (guardrails/mcp-auth.spec.ts checks every route under /mcp and /mcp/).
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(405).header("allow", "POST").send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed." },
    });
  };

  const gated = { config: { public: true }, preHandler: mcpAuthGate };
  fastify.post("/mcp", gated, handleMcpPost);
  fastify.post("/mcp/", gated, handleMcpPost);
  fastify.get("/mcp", gated, methodNotAllowed);
  fastify.get("/mcp/", gated, methodNotAllowed);
  fastify.delete("/mcp", gated, methodNotAllowed);
  fastify.delete("/mcp/", gated, methodNotAllowed);
};

/**
 * Streamable HTTP clients MUST send `Accept: application/json, text/event-stream`, and the
 * SDK answers 406 otherwise. This server only ever replies with JSON, so a client that
 * accepts JSON — or sends no Accept at all, like HTTP JSON-RPC callers written before the
 * SDK — loses nothing by being served. Anything else is left for the SDK to refuse.
 */
function acceptForTransport(accept: string | undefined): string | undefined {
  if (!accept || accept.includes("application/json") || accept.includes("*/*")) {
    return "application/json, text/event-stream";
  }
  return accept;
}

/**
 * The transport takes a web-standard Request. The body is already parsed by Fastify and is
 * passed separately, so only the headers the transport reads are copied. The URL is only
 * reported to handlers, which do not use it; its origin is a fixed placeholder so the
 * client-supplied Host header never reaches the SDK.
 */
function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const name of ["content-type", "mcp-protocol-version"] as const) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const accept = acceptForTransport(req.headers.accept);
  if (accept) headers.set("accept", accept);
  return new Request(new URL(req.url, "http://mcp.invalid"), { method: req.method, headers });
}

