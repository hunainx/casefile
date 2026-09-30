import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";

const JWT_SECRET_ENV = "JWT_SECRET";
const JWT_SECRET_MIN_LENGTH = 32;

/**
 * The HMAC key for access tokens. Read on every sign/verify, never at module load, so
 * importing this module (apps/api/src/index.ts re-exports it; tools/ingest-cli imports
 * signJwt) does not require the secret — using it does. There is no default: until
 * 2026-09-04 a literal fallback here meant any deployment without JWT_SECRET set
 * accepted tokens anyone could mint.
 */
export function getJwtSecret(): string {
  const value = process.env[JWT_SECRET_ENV];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${JWT_SECRET_ENV} is not set. Access tokens cannot be signed or verified without it; set it to the matter's Secret Manager value.`,
    );
  }
  if (value.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(
      `${JWT_SECRET_ENV} must be at least ${JWT_SECRET_MIN_LENGTH} characters (got ${value.length}).`,
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Password Hashing (Argon2id with Scrypt fallback)
// ─────────────────────────────────────────────────────────────────────────────

let argon2Promise: Promise<typeof import("argon2") | null> | null = null;

async function getArgon2() {
  if (!argon2Promise) {
    argon2Promise = import("argon2").catch(() => null);
  }
  return argon2Promise;
}

export async function hashPassword(password: string): Promise<string> {
  const argon2Module = await getArgon2();
  if (argon2Module?.hash) {
    return argon2Module.hash(password, { type: argon2Module.argon2id });
  }
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `$scrypt$N=16384,r=8,p=1$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const argon2Module = await getArgon2();
  if (hash.startsWith("$argon2") && argon2Module?.verify) {
    try {
      return await argon2Module.verify(hash, password);
    } catch {
      return false;
    }
  }
  if (hash.startsWith("$scrypt$")) {
    const parts = hash.split("$");
    const salt = parts[3];
    const originalKey = parts[4];
    if (!salt || !originalKey) return false;
    const derivedKey = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const originalBuf = Buffer.from(originalKey, "hex");
    if (derivedKey.length !== originalBuf.length) return false;
    return timingSafeEqual(derivedKey, originalBuf);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT Access Token Generation & Verification
// ─────────────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string; // user_id
  tid: string; // tenant_id
  sid: string; // session_id
  roles: string[];
  mfa: boolean;
  stepUpAt?: string | undefined;
  /** OAuth access tokens for /mcp only (D69): audience (MCP_PUBLIC_URL), scope, client_id. */
  aud?: string | undefined;
  scope?: string | undefined;
  cid?: string | undefined;
  exp: number; // unix epoch in seconds
  iat: number; // unix epoch in seconds
  jti: string;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64").toString("utf-8");
}

export function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp" | "jti">,
  expiresInSeconds = 900, // 15 minutes per PRD §40.1
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSeconds;
  const jti = randomBytes(16).toString("hex");

  const fullPayload: JwtPayload = { ...payload, iat, exp, jti };

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = createHmac("sha256", getJwtSecret())
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT token format");
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const expectedSig = createHmac("sha256", getJwtSecret())
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  const sigBuf = Buffer.from(signature!);
  const expBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid JWT signature");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload!)) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp && payload.exp < now) {
    throw new Error("JWT token expired");
  }

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh Token Utilities
// ─────────────────────────────────────────────────────────────────────────────

export function generateRefreshToken(tenantId?: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString("hex");
  const token = tenantId ? `${tenantId}_${secret}` : secret;
  const hash = hashToken(secret);
  return { token, hash };
}

export function hashToken(token: string): string {
  const secret = token.includes("_") ? token.split("_").slice(1).join("_") : token;
  return createHash("sha256").update(secret).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// TOTP Multi-Factor Authentication (RFC 6238)
// ─────────────────────────────────────────────────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * A new TOTP secret: 20 random bytes (160 bits, the length RFC 4226 section 4 recommends),
 * base32-encoded to 32 characters. Until Phase 2B (D75) this returned 20 base32 characters,
 * one per random byte, which is only 100 bits; secrets of that length keep working, since
 * base32Decode() takes any length.
 */
export function generateTotpSecret(byteLength = 20): string {
  const bytes = randomBytes(byteLength);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let result = "";
  for (let i = 0; i < bits.length; i += 5) {
    result += BASE32_CHARS[parseInt(bits.substring(i, i + 5).padEnd(5, "0"), 2)];
  }
  return result;
}

function base32Decode(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (let i = 0; i < cleaned.length; i++) {
    const val = BASE32_CHARS.indexOf(cleaned[i]!);
    bits += val.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, timestamp = Date.now(), timeStepSeconds = 30): string {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / timeStepSeconds);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 1_000_000;
  return otp.toString().padStart(6, "0");
}

/**
 * The time step (Unix time / 30) a code belongs to, or null if it matches none within `window`
 * steps of now. Callers that sign someone in must also refuse a step at or before the last one
 * the account used (AuthService.consumeTotpCode, D75); this function alone does not.
 */
export function verifyTotpStep(
  secret: string,
  token: string,
  window = 1,
  timestamp = Date.now(),
): number | null {
  if (!secret || !token || token.length !== 6) return null;
  const timeStep = 30;
  const now = Math.floor(timestamp / 1000 / timeStep);

  for (let step = now - window; step <= now + window; step++) {
    const expected = Buffer.from(generateTotp(secret, step * timeStep * 1000, timeStep));
    const given = Buffer.from(token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return step;
    }
  }
  return null;
}

export function verifyTotp(
  secret: string,
  token: string,
  window = 1,
  timestamp = Date.now(),
): boolean {
  return verifyTotpStep(secret, token, window, timestamp) !== null;
}
