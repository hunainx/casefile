import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { clientIdProblem, HOSTED_CALLBACKS } from "./config.js";

/**
 * OAuth Client ID Metadata Documents (CIMD) — the only way a client identifies itself here;
 * there is no Dynamic Client Registration (D70). Requirements:
 * - MCP spec 2026-07-28, Client Registration: the fetched document's client_id MUST equal
 *   its URL exactly; redirect URIs MUST be validated against it; cache per HTTP headers.
 * - Security considerations: SSRF protection when fetching.
 *
 * Only client_ids on the MCP_OAUTH_TRUSTED_CLIENTS allowlist are ever fetched. The fetch is
 * HTTPS only, gives up after 5 seconds, reads at most MAX_DOCUMENT_BYTES, follows no
 * redirects, and connects only if EVERY address the host resolves to is publicly routable —
 * to the exact address that was checked, so a second DNS answer cannot swap it for a private
 * one.
 */

export const CIMD_TIMEOUT_MS = 5_000;
export const MAX_DOCUMENT_BYTES = 64 * 1024;
const DEFAULT_CACHE_SECONDS = 300;
const MAX_CACHE_SECONDS = 24 * 60 * 60;

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export class CimdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CimdError";
  }
}

/**
 * The network layer, replaceable only in code (BuildAppOptions.oauth.cimdTransport) so tests
 * can serve documents without a real HTTPS host. Every check in this module — allowlist,
 * scheme, resolved-address classes, size, timeout, status, document shape, cache — runs on
 * whatever a transport returns.
 */
export interface CimdTransport {
  /** Every address the host name resolves to. */
  resolve(hostname: string): Promise<string[]>;
  /** GET `url`, connecting to `address`. */
  get(
    url: URL,
    address: string,
    limits: { timeoutMs: number; maxBytes: number },
  ): Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }>;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is decoded and checked as IPv4. It must not be a rule in
// `blocked`: BlockList also matches IPv4 addresses against IPv6 rules in their mapped form,
// so a ::ffff:0:0/96 rule there would block every IPv4 address.
const mapped = new BlockList();
mapped.addSubnet("::ffff:0:0", 96, "ipv6");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 (embeds an IPv4 address)
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** The eight 16-bit groups of an IPv6 address. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const h = head ? head.split(":").filter((g) => g !== "") : [];
  const t = tail !== undefined ? tail.split(":").filter((g) => g !== "") : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

/** True only for a globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    if (mapped.check(address, "ipv6")) {
      const g = ipv6Groups(address);
      return isPublicAddress(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
    }
    return !blocked.check(address, "ipv6");
  }
  return false;
}

/**
 * A DNS lookup for https.request that always answers with the one address that was checked,
 * so the connection cannot go anywhere else.
 */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_host, opts, cb) => {
    // Node asks for every address (all: true) when it may race IPv4 and IPv6 connections.
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

export const defaultCimdTransport: CimdTransport = {
  async resolve(hostname) {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    return results.map((r) => r.address);
  },
  get(url, address, { timeoutMs, maxBytes }) {
    return new Promise((resolvePromise, reject) => {
      const req = httpsRequest(
        {
          host: url.hostname,
          servername: url.hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { accept: "application/json" },
          // Connect to the address that was checked, not to a fresh DNS answer.
          lookup: pinnedLookup(address),
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy(new CimdError(`client metadata document is larger than ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const headers: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
            resolvePromise({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new CimdError("client metadata fetch timed out")));
      req.on("error", reject);
      req.end();
    });
  },
};

interface CacheEntry {
  metadata: ClientMetadata;
  expiresAt: number;
}

export interface CimdFetcherOptions {
  trustedClients: readonly string[];
  transport?: CimdTransport | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

/** Cache lifetime from Cache-Control, capped. Null means "do not cache". */
function cacheSeconds(cacheControl: string | undefined): number | null {
  if (!cacheControl) return DEFAULT_CACHE_SECONDS;
  const directives = cacheControl.toLowerCase().split(",").map((d) => d.trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache" || d === "private")) return null;
  const maxAge = directives.find((d) => d.startsWith("max-age="));
  if (maxAge) {
    const n = Number(maxAge.slice("max-age=".length));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(n, MAX_CACHE_SECONDS);
  }
  return DEFAULT_CACHE_SECONDS;
}

export function createCimdFetcher(options: CimdFetcherOptions) {
  const transport = options.transport ?? defaultCimdTransport;
  const timeoutMs = options.timeoutMs ?? CIMD_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  async function fetchClient(clientId: string): Promise<ClientMetadata> {
    const idProblem = clientIdProblem(clientId);
    if (idProblem) throw new CimdError(`client_id ${idProblem}`);
    if (!options.trustedClients.includes(clientId)) throw new CimdError("client_id is not on the trusted client list");

    const cached = cache.get(clientId);
    if (cached && cached.expiresAt > now()) return cached.metadata;

    const url = new URL(clientId);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : await withTimeout(transport.resolve(host), timeoutMs);
    if (addresses.length === 0) throw new CimdError("client_id host does not resolve");
    const refused = addresses.filter((a) => !isPublicAddress(a));
    if (refused.length > 0) {
      throw new CimdError(`client_id host resolves to a non-public address (${refused.join(", ")})`);
    }

    const res = await withTimeout(transport.get(url, addresses[0]!, { timeoutMs, maxBytes: MAX_DOCUMENT_BYTES }), timeoutMs);
    if (res.status !== 200) throw new CimdError(`client metadata document returned HTTP ${res.status}`);
    if (res.body.length > MAX_DOCUMENT_BYTES) {
      throw new CimdError(`client metadata document is larger than ${MAX_DOCUMENT_BYTES} bytes`);
    }
    const contentType = res.headers["content-type"] ?? "";
    if (!/\bjson\b/i.test(contentType)) throw new CimdError("client metadata document is not JSON");

    let doc: unknown;
    try {
      doc = JSON.parse(res.body.toString("utf8"));
    } catch {
      throw new CimdError("client metadata document is not valid JSON");
    }
    const metadata = validateDocument(doc, clientId);

    const seconds = cacheSeconds(res.headers["cache-control"]);
    if (seconds !== null) cache.set(clientId, { metadata, expiresAt: now() + seconds * 1000 });
    else cache.delete(clientId);
    return metadata;
  }

  return { fetchClient };
}

function validateDocument(doc: unknown, clientId: string): ClientMetadata {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new CimdError("client metadata document is not a JSON object");
  }
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) throw new CimdError("client metadata document's client_id does not match its URL");
  if (typeof d.client_name !== "string" || d.client_name.trim() === "") {
    throw new CimdError("client metadata document has no client_name");
  }
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0 || !d.redirect_uris.every((u) => typeof u === "string")) {
    throw new CimdError("client metadata document has no redirect_uris");
  }
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none") {
    throw new CimdError("only public clients (token_endpoint_auth_method \"none\") are supported");
  }
  return { clientId, clientName: d.client_name, redirectUris: d.redirect_uris as string[] };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CimdError("client metadata fetch timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function loopbackParts(uri: string): { host: string; rest: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.hash) return null;
  return { host: url.hostname, rest: `${url.pathname}${url.search}` };
}

/**
 * A redirect URI is accepted only if the server allows it AND the client's document lists it.
 * - Server: one of HOSTED_CALLBACKS exactly, or an http loopback URI (localhost, 127.0.0.1,
 *   [::1]) on any port, for Claude Code (RFC 8252 section 7.3; Claude's docs require the same
 *   for localhost).
 * - Document: exact string match; for loopback URIs the port is ignored, host, path and query
 *   must match.
 */
export function redirectUriAllowed(requested: string, registered: readonly string[]): boolean {
  if (HOSTED_CALLBACKS.includes(requested)) return registered.includes(requested);
  const want = loopbackParts(requested);
  if (!want) return false;
  return registered.some((r) => {
    const have = loopbackParts(r);
    return have !== null && have.host === want.host && have.rest === want.rest;
  });
}

export function isLoopbackRedirect(uri: string): boolean {
  return loopbackParts(uri) !== null;
}
