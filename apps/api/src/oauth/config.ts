/**
 * Configuration of the OAuth 2.1 authorization server behind the /mcp connector (D69, D70).
 *
 * MCP_PUBLIC_URL is the full HTTPS URL of /mcp as users enter it in Claude. It is the
 * protected resource identifier (RFC 9728 `resource`), the access-token audience, and its
 * origin is the issuer (RFC 8414). It must already be in canonical form — lowercase scheme
 * and host, no default port, no trailing slash, no query or fragment — because Claude sends
 * the canonical form as the RFC 8707 `resource` parameter
 * (https://claude.com/docs/connectors/building/troubleshooting, "Audience mismatch").
 */

export const SCOPE_READ = "casefile.read";
export const SCOPE_OFFLINE = "offline_access";

/**
 * Claude Code's Client ID Metadata Document, as documented in
 * https://claude.com/docs/connectors/building/authentication ("Callback URLs").
 * Claude's docs do not publish the hosted apps' (claude.ai, Desktop, mobile) document URL,
 * so it is not a default; add it through MCP_OAUTH_TRUSTED_CLIENTS once confirmed.
 */
export const DEFAULT_TRUSTED_CLIENTS: readonly string[] = ["https://claude.ai/oauth/claude-code-client-metadata"];

/**
 * The hosted Claude apps' callback. claude.ai is documented; claude.com is kept as the plan
 * requires (docs/PLAN-MCP-AUTH.md section 1). A redirect URI must ALSO be listed in the
 * client's own metadata document.
 */
export const HOSTED_CALLBACKS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

export interface OAuthConfig {
  /** MCP_PUBLIC_URL, canonical. */
  resource: string;
  /** Origin of MCP_PUBLIC_URL. */
  issuer: string;
  trustedClients: readonly string[];
}

/** Why a URL is not a canonical HTTPS resource identifier, or null when it is. */
export function canonicalUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not an absolute URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not contain credentials";
  if (url.search || value.includes("?")) return "must not have a query string";
  if (url.hash || value.includes("#")) return "must not have a fragment";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) return "must not end with a slash";
  // new URL() lowercases the host and drops a default port; a canonical value is unchanged by it.
  const reserialised = url.pathname === "/" && !value.endsWith("/") ? url.origin : url.href;
  if (reserialised !== value) return `must be written in canonical form (${reserialised})`;
  return null;
}

/**
 * Compares a client's `resource` parameter with the configured resource. Scheme and host are
 * compared case-insensitively (MCP spec 2026-07-28, "Canonical Server URI": implementations
 * SHOULD accept uppercase scheme and host); everything else must match exactly.
 */
export function resourceMatches(candidate: string | undefined, resource: string): boolean {
  if (!candidate) return false;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/.exec(candidate);
  if (!m) return false;
  const normalised = `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3]}`;
  return normalised === resource;
}

/** Reads the OAuth settings, or returns the reason they are unusable. */
export function resolveOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig | { error: string } {
  const resource = env.MCP_PUBLIC_URL;
  if (resource === undefined || resource.trim() === "") return { error: "MCP_PUBLIC_URL is not set" };
  const problem = canonicalUrlProblem(resource);
  if (problem) return { error: `MCP_PUBLIC_URL ${problem}` };

  const raw = env.MCP_OAUTH_TRUSTED_CLIENTS;
  const trustedClients =
    raw === undefined || raw.trim() === ""
      ? DEFAULT_TRUSTED_CLIENTS
      : raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
  for (const client of trustedClients) {
    const p = clientIdProblem(client);
    if (p) return { error: `MCP_OAUTH_TRUSTED_CLIENTS entry ${client} ${p}` };
  }
  return { resource, issuer: new URL(resource).origin, trustedClients };
}

/** A Client ID Metadata Document URL must be https with a path component (MCP spec, Client Registration). */
export function clientIdProblem(clientId: string): string | null {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.pathname === "/" || url.pathname === "") return "must have a path component";
  if (url.hash || url.username || url.password) return "must not have a fragment or credentials";
  return null;
}
