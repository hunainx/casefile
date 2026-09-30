import { describe, it, expect } from "vitest";
import { isPublicAddress, pinnedLookup, redirectUriAllowed } from "../src/oauth/cimd.js";
import { canonicalUrlProblem, resourceMatches } from "../src/oauth/config.js";

/**
 * Pure pieces of the OAuth server (D69, D70). The network layer is replaced in the integration
 * tests, so what it hands to Node's https client is checked here.
 */
describe("OAuth server — pure checks", () => {
  it("the pinned lookup answers both forms Node uses (single address, and all: true)", () => {
    const lookup = pinnedLookup("160.79.104.10");
    const single = new Promise<unknown[]>((resolve) => lookup("claude.ai", {}, (...args: unknown[]) => resolve(args)));
    const all = new Promise<unknown[]>((resolve) => lookup("claude.ai", { all: true }, (...args: unknown[]) => resolve(args)));
    return Promise.all([single, all]).then(([s, a]) => {
      expect(s).toEqual([null, "160.79.104.10", 4]);
      expect(a).toEqual([null, [{ address: "160.79.104.10", family: 4 }]]);
    });
  });

  it("classifies addresses: only globally routable unicast is public", () => {
    const pub = ["93.184.215.14", "8.8.8.8", "160.79.104.10", "2606:4700::1111", "::ffff:8.8.8.8"];
    const priv = [
      "10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.1.1", "172.16.5.4", "192.168.1.1", "0.0.0.0", "224.0.0.1",
      "192.0.2.1", "198.18.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.5", "::ffff:a00:5", "64:ff9b::a00:5",
      "2001:db8::1", "not-an-ip",
    ];
    for (const a of pub) expect(isPublicAddress(a), a).toBe(true);
    for (const a of priv) expect(isPublicAddress(a), a).toBe(false);
  });

  it("MCP_PUBLIC_URL must be canonical HTTPS", () => {
    expect(canonicalUrlProblem("https://mcp.example.com/mcp")).toBeNull();
    expect(canonicalUrlProblem("https://mcp.example.com")).toBeNull();
    for (const bad of [
      "http://mcp.example.com/mcp",
      "https://mcp.example.com/mcp/",
      "https://MCP.example.com/mcp",
      "https://mcp.example.com:443/mcp",
      "https://mcp.example.com/mcp?x=1",
      "https://mcp.example.com/mcp#f",
      "mcp.example.com/mcp",
    ]) {
      expect(canonicalUrlProblem(bad), bad).not.toBeNull();
    }
  });

  it("compares resource with case-insensitive scheme and host only", () => {
    const r = "https://mcp.example.com/mcp";
    expect(resourceMatches("https://mcp.example.com/mcp", r)).toBe(true);
    expect(resourceMatches("HTTPS://MCP.Example.COM/mcp", r)).toBe(true);
    expect(resourceMatches("https://mcp.example.com/MCP", r)).toBe(false);
    expect(resourceMatches("https://mcp.example.com/mcp/", r)).toBe(false);
    expect(resourceMatches(undefined, r)).toBe(false);
  });

  it("allows a redirect URI only if the server allows it and the client lists it", () => {
    const claudeCode = ["http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectUriAllowed("http://localhost:3118/callback", claudeCode)).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:49152/callback", claudeCode)).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:49152/other", claudeCode)).toBe(false);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", claudeCode)).toBe(false);
    const hosted = ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"];
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", hosted)).toBe(true);
    expect(redirectUriAllowed("https://evil.example/cb", hosted)).toBe(false);
  });
});
