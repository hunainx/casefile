import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Tx } from "@casefile/db";
import { writeAuditEvent } from "@casefile/audit";
import { signJwt, generateRefreshToken } from "../auth/crypto.js";
import { randomToken, sha256 } from "./flow.js";
import { SCOPE_OFFLINE, SCOPE_READ } from "./config.js";

// Who may use MCP, and with which tools, is decided in packages/mcp/src/access.ts, shared with
// the /mcp auth gate and the stdio CLI (moved there in Phase 3, D77).
export {
  MCP_BASE_PERMISSIONS,
  REFUSAL_MESSAGES,
  OAuthConfigError,
  checkMcpEligibility,
  type McpAccess,
  type Refusal,
  type RefusalReason,
} from "@casefile/mcp";

/**
 * The OAuth 2.1 authorization server for /mcp (D69): who may sign in, one-time codes, and the
 * session and tokens a Claude connection gets. Tokens reuse the existing HS256 access tokens
 * (signJwt, 15 minutes) and refresh rotation (AuthService.rotateRefreshToken).
 */

export const CODE_TTL_SECONDS = 60;
export const ACCESS_TOKEN_SECONDS = 900;
export const SESSION_MAX_SECONDS = 90 * 24 * 60 * 60;
export const SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;

/** The roles an access token carries, computed as every other sign-in does. */
async function tokenRoles(tx: Tx, tenantId: string, userId: string): Promise<string[]> {
  const rows = await tx<{ role: string }[]>`
    SELECT role FROM workspace_members WHERE user_id = ${userId} AND tenant_id = ${tenantId};
  `;
  const roles = rows.map((r) => r.role);
  return roles.includes("ws_admin") ? ["org_admin", ...roles] : roles;
}

/** The requested scopes, or null if one is unknown. casefile.read is always granted. */
export function grantScopes(requested: string | undefined): string[] | null {
  const asked = (requested ?? "").split(" ").filter((s) => s !== "");
  if (asked.some((s) => s !== SCOPE_READ && s !== SCOPE_OFFLINE)) return null;
  return asked.includes(SCOPE_OFFLINE) ? [SCOPE_READ, SCOPE_OFFLINE] : [SCOPE_READ];
}

export async function issueAuthorizationCode(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scope: string;
  },
): Promise<string> {
  const code = randomToken(32);
  await tx`
    INSERT INTO oauth_authorization_codes (
      tenant_id, user_id, code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
      resource, scope, expires_at
    ) VALUES (
      ${input.tenantId}, ${input.userId}, ${sha256(code)}, ${input.clientId}, ${input.redirectUri},
      ${input.codeChallenge}, 'S256', ${input.resource}, ${input.scope}, NOW() + make_interval(secs => ${CODE_TTL_SECONDS})
    );
  `;
  return code;
}

/** RFC 7636: code_verifier is 43-128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function pkceS256Matches(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || !VERIFIER_PATTERN.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export type TokenError = { error: "invalid_grant" | "invalid_target" | "invalid_request"; description: string };

export interface RedeemedCode {
  id: string;
  userId: string;
  scope: string;
}

/**
 * Redeems a code exactly once. It is marked used before anything else is checked, so a
 * failed attempt (wrong verifier, wrong redirect_uri) burns it. A second redemption attempt
 * revokes the session the first one created (OAuth 2.1 section 4.1.3).
 */
export async function redeemAuthorizationCode(
  tx: Tx,
  input: {
    tenantId: string;
    code: string;
    clientId: string;
    redirectUri: string | undefined;
    codeVerifier: string | undefined;
    resourceOk: (stored: string) => boolean;
    requestId: string;
  },
): Promise<RedeemedCode | TokenError> {
  const hash = sha256(input.code);
  const rows = await tx<{
    id: string;
    user_id: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    scope: string;
    expired: boolean;
  }[]>`
    UPDATE oauth_authorization_codes SET used_at = NOW()
    WHERE code_hash = ${hash} AND tenant_id = ${input.tenantId} AND used_at IS NULL
    RETURNING id, user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at <= NOW() AS expired;
  `;
  const row = rows[0];
  if (!row) {
    const reused = await tx<{ id: string; user_id: string; session_family_id: string | null }[]>`
      SELECT id, user_id, session_family_id FROM oauth_authorization_codes
      WHERE code_hash = ${hash} AND tenant_id = ${input.tenantId};
    `;
    if (reused[0]) {
      if (reused[0].session_family_id) {
        await tx`
          UPDATE auth_sessions SET is_revoked = true, updated_at = NOW()
          WHERE session_family_id = ${reused[0].session_family_id} AND tenant_id = ${input.tenantId};
        `;
      }
      await writeAuditEvent(tx, {
        tenantId: input.tenantId,
        actorType: "system",
        actorId: reused[0].user_id,
        actorDisplay: "OAuth authorization server",
        action: "auth.oauth_code_reused",
        objectType: "oauth_authorization_code",
        objectId: reused[0].id,
        objectDisplay: "authorization code",
        rationale: "An authorization code was presented a second time; the session it created was revoked.",
        requestId: input.requestId,
        outcome: "denied",
        denialReason: "code_reuse",
      });
    }
    return { error: "invalid_grant", description: "The authorization code is invalid or has already been used." };
  }
  if (row.expired) return { error: "invalid_grant", description: "The authorization code has expired." };
  if (row.client_id !== input.clientId) return { error: "invalid_grant", description: "The code was issued to another client." };
  if (row.redirect_uri !== input.redirectUri) return { error: "invalid_grant", description: "redirect_uri does not match the authorization request." };
  if (!input.resourceOk(row.resource)) return { error: "invalid_target", description: "resource does not match this server." };
  if (!pkceS256Matches(input.codeVerifier, row.code_challenge)) return { error: "invalid_grant", description: "PKCE verification failed." };
  return { id: row.id, userId: row.user_id, scope: row.scope };
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/**
 * Starts a Claude connection: one new session family, valid at most 90 days, whose access
 * tokens carry aud = MCP_PUBLIC_URL, scope and cid. A refresh token is issued only when
 * offline_access was granted (MCP spec 2026-07-28, "Refresh Tokens": clients MUST NOT assume
 * one; Claude asks for offline_access when it is advertised).
 */
export async function startOAuthSession(
  tx: Tx,
  input: { tenantId: string; userId: string; clientId: string; audience: string; scope: string; codeId: string; requestId: string },
): Promise<OAuthTokenResponse> {
  const familyId = randomUUID();
  const sessionId = randomUUID();
  const { token: refreshToken, hash } = generateRefreshToken(input.tenantId);
  const offline = input.scope.split(" ").includes(SCOPE_OFFLINE);
  await tx`
    INSERT INTO auth_sessions (
      id, tenant_id, user_id, session_family_id, refresh_token_hash, mfa_verified_at, expires_at,
      oauth_client_id, audience
    ) VALUES (
      ${sessionId}, ${input.tenantId}, ${input.userId}, ${familyId}, ${hash}, NOW(),
      NOW() + make_interval(secs => ${SESSION_MAX_SECONDS}), ${input.clientId}, ${input.audience}
    );
  `;
  await tx`
    UPDATE oauth_authorization_codes SET session_family_id = ${familyId}
    WHERE id = ${input.codeId} AND tenant_id = ${input.tenantId};
  `;
  const accessToken = signJwt(
    {
      sub: input.userId,
      tid: input.tenantId,
      sid: sessionId,
      roles: await tokenRoles(tx, input.tenantId, input.userId),
      mfa: true,
      aud: input.audience,
      scope: SCOPE_READ,
      cid: input.clientId,
    },
    ACCESS_TOKEN_SECONDS,
  );
  await writeAuditEvent(tx, {
    tenantId: input.tenantId,
    actorType: "user",
    actorId: input.userId,
    actorDisplay: "OAuth sign-in",
    sessionId,
    action: "auth.oauth_token_issued",
    objectType: "session_family",
    objectId: familyId,
    objectDisplay: `Claude connection (${new URL(input.clientId).host})`,
    after: { client_id: input.clientId, scope: input.scope, refresh_token: offline },
    requestId: input.requestId,
    outcome: "success",
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    scope: input.scope,
    ...(offline ? { refresh_token: refreshToken } : {}),
  };
}

export async function auditOAuthEvent(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    action: "auth.oauth_signin_refused" | "auth.oauth_consent_granted" | "auth.oauth_consent_denied";
    clientId: string;
    redirectUri: string;
    requestId: string;
    reason?: string;
  },
): Promise<void> {
  await writeAuditEvent(tx, {
    tenantId: input.tenantId,
    actorType: "user",
    actorId: input.userId,
    actorDisplay: "OAuth sign-in",
    action: input.action,
    objectType: "oauth_client",
    objectId: input.userId,
    objectDisplay: new URL(input.clientId).host,
    after: { client_id: input.clientId, redirect_host: new URL(input.redirectUri).host },
    requestId: input.requestId,
    outcome: input.action === "auth.oauth_consent_granted" ? "success" : "denied",
    denialReason: input.reason ?? null,
  });
}
