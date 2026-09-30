import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getJwtSecret } from "../auth/crypto.js";

/**
 * Signed, short-lived form state for the sign-in and account-setup pages.
 *
 * The pages run on any Cloud Run instance, so a flow keeps no server memory: each step hands
 * the browser a token carrying what the next step needs, signed with a key DERIVED from
 * JWT_SECRET for this purpose only. A flow token therefore never verifies as an access token
 * (verifyJwt uses JWT_SECRET itself), and an access token never verifies as a flow token.
 * Each token is bound to the browser's CSRF cookie by its SHA-256 digest.
 */

export type FlowPurpose = "oauth-authorize" | "account-setup";

export interface FlowBase {
  purpose: FlowPurpose;
  /** SHA-256 (hex) of the CSRF cookie value this flow is bound to. */
  csrf: string;
  /** Expiry, unix seconds. */
  exp: number;
}

const PREFIX = "cf1";

function key(): Buffer {
  return createHmac("sha256", getJwtSecret()).update("casefile/oauth-flow-state/v1").digest();
}

export function signFlow<T extends FlowBase>(payload: T): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key()).update(`${PREFIX}.${body}`).digest("base64url");
  return `${PREFIX}.${body}.${sig}`;
}

/** The payload, or null if the token is malformed, forged, expired or for another purpose. */
export function verifyFlow<T extends FlowBase>(token: string | undefined, purpose: FlowPurpose, csrfCookie: string | undefined): T | null {
  if (!token || !csrfCookie) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const expected = createHmac("sha256", key()).update(`${PREFIX}.${parts[1]}`).digest("base64url");
  const a = Buffer.from(parts[2]!);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
  if (payload.purpose !== purpose) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!safeEqual(payload.csrf, sha256(csrfCookie))) return null;
  return payload;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const CSRF_COOKIE = "__Host-cf_csrf";

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Set-Cookie value for the CSRF cookie: host-only, HTTPS-only, script-proof, same-site only. */
export function csrfCookieHeader(value: string): string {
  return `${CSRF_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800`;
}
