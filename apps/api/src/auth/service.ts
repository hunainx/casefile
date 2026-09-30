import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Tx } from "@casefile/db";
import type { Sql } from "postgres";
import { writeAuditEvent } from "@casefile/audit";
import { MATRIX_ROLES, type MatrixRole } from "@casefile/policy";
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  generateRefreshToken,
  hashToken,
  verifyTotpStep,
} from "./crypto.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

export interface RegisterRootInput {
  email: string;
  password: string;
  name: string;
  orgName: string;
  tenantId?: string | undefined;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: "Bearer";
  user: {
    id: string;
    email: string;
    name: string;
    tenantId: string;
  };
}

export class AuthError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code = "AUTH_ERROR", status = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

/**
 * AuthService handles identity, credentials, multi-factor authentication,
 * session families, and refresh token rotation with reuse detection (PRD §40.1, §40.2).
 */
export const ADMIN_CLI_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The audience of the 5-minute token the password step returns when TOTP is required (D75,
 * DEV-022). The REST API refuses every token that has an audience, and /mcp accepts only its
 * own, so this token is good for exactly one thing: POST /v1/auth/mfa/verify.
 */
export const MFA_CHALLENGE_AUDIENCE = "urn:casefile:mfa-challenge";
const MFA_CHALLENGE_SID = "mfa_challenge";

/**
 * Accepts a TOTP code for an account at most once (D75). The code must match a time step
 * within the verification window AND be later than the last step this account used; the
 * single conditional UPDATE records it, so two requests racing with the same code cannot both
 * succeed. Returns false for a wrong, stale or reused code.
 */
async function consumeTotpCode(
  tx: Tx,
  input: { userId: string; tenantId: string; secret: string; code: string },
): Promise<boolean> {
  const step = verifyTotpStep(input.secret, input.code);
  if (step === null) return false;
  const rows = await tx`
    UPDATE auth_credentials SET totp_last_step = ${step}, updated_at = NOW()
    WHERE user_id = ${input.userId} AND tenant_id = ${input.tenantId}
      AND (totp_last_step IS NULL OR totp_last_step < ${step})
    RETURNING user_id;
  `;
  return rows.length === 1;
}

/**
 * Stores (or refreshes) a verified passkey credential (AUTH-03). A separate function so the
 * statement is tested directly: registration itself needs a real authenticator. It accepts a
 * transaction or a plain client (packages/db/test/array-params-first-query.integration.test.ts
 * runs it as the first query of a new client).
 */
export async function storeWebAuthnCredential(
  sql: Tx | Sql,
  cred: {
    id: string;
    tenantId: string;
    userId: string;
    publicKey: Uint8Array;
    counter: number;
    deviceType: string;
    backedUp: boolean;
    transports: string[];
    name: string;
  },
): Promise<void> {
  await sql`
      INSERT INTO webauthn_credentials (
        id, tenant_id, user_id, public_key, counter, device_type, backed_up, transports, name
      ) VALUES (
        ${cred.id},
        ${cred.tenantId},
        ${cred.userId},
        ${Buffer.from(cred.publicKey)},
        ${cred.counter},
        ${cred.deviceType},
        ${cred.backedUp},
        ${cred.transports},
        ${cred.name}
      )
      ON CONFLICT (id) DO UPDATE SET
        counter = EXCLUDED.counter,
        backed_up = EXCLUDED.backed_up;
    `;
}

export class AuthService {
  /**
   * Registers a root organization, admin user, and credentials.
   */
  static async registerRoot(tx: Tx, input: RegisterRootInput): Promise<AuthTokens> {
    const orgId = input.tenantId || randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const memberId = randomUUID();

    // Scope transaction to new organization tenant_id for RLS
    await tx`SELECT set_config('app.tenant_id', ${orgId}, true);`;

    // 1. Create Organization (tenant root where tenant_id = id per REQ-M-DB-010)
    await tx`
      INSERT INTO organizations (id, tenant_id, name)
      VALUES (${orgId}, ${orgId}, ${input.orgName});
    `;

    // 2. Create User
    await tx`
      INSERT INTO users (id, tenant_id, email, name)
      VALUES (${userId}, ${orgId}, ${input.email.toLowerCase()}, ${input.name});
    `;

    // 3. Create Default Workspace
    await tx`
      INSERT INTO workspaces (id, tenant_id, name)
      VALUES (${workspaceId}, ${orgId}, 'Primary Workspace');
    `;

    // 4. Assign Admin Member
    await tx`
      INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
      VALUES (${memberId}, ${orgId}, ${workspaceId}, ${userId}, 'ws_admin');
    `;

    // 5. Store Credentials
    const passwordHash = await hashPassword(input.password);
    await tx`
      INSERT INTO auth_credentials (user_id, tenant_id, password_hash)
      VALUES (${userId}, ${orgId}, ${passwordHash});
    `;

    // 6. Create initial Session Family
    const sessionFamilyId = randomUUID();
    const sessionId = randomUUID();
    const { token: refreshToken, hash: refreshHash } = generateRefreshToken(orgId);
    const absoluteExpiry = new Date(Date.now() + 12 * 3600 * 1000); // 12h absolute timeout

    await tx`
      INSERT INTO auth_sessions (
        id, tenant_id, user_id, session_family_id, refresh_token_hash, expires_at
      ) VALUES (
        ${sessionId}, ${orgId}, ${userId}, ${sessionFamilyId}, ${refreshHash}, ${absoluteExpiry}
      );
    `;

    await tx`
      INSERT INTO sign_in_history (
        tenant_id, user_id, ip_address, user_agent, location, status
      ) VALUES (
        ${orgId}, ${userId}, '127.0.0.1', 'Registration', ${JSON.stringify({ country: "US", city: "Local" })}, 'success'
      );
    `;

    const accessToken = signJwt({
      sub: userId,
      tid: orgId,
      sid: sessionId,
      roles: ["org_admin", "ws_admin"],
      mfa: false,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      tokenType: "Bearer",
      user: {
        id: userId,
        email: input.email.toLowerCase(),
        name: input.name,
        tenantId: orgId,
      },
    };
  }

  /**
   * Authenticates email + password with brute-force lockout and MFA checks.
   */
  static async login(
    tx: Tx,
    input: {
      email: string;
      password: string;
      tenantId?: string | undefined;
      ipHash?: string | undefined;
      userAgent?: string | undefined;
      requestId?: string | undefined;
      /**
       * false: check the password (with the lockout) and stop — no session, no challenge
       * token. The OAuth sign-in page (D69) runs its own TOTP step and issues nothing until
       * consent.
       */
      issueSession?: boolean | undefined;
    },
  ): Promise<{
    tokens?: AuthTokens | undefined;
    mfaRequired?: boolean | undefined;
    challengeToken?: string | undefined;
    userId?: string | undefined;
    tenantId?: string | undefined;
    passwordVerified?: boolean | undefined;
    totpEnabled?: boolean | undefined;
  }> {
    const email = input.email.toLowerCase();

    if (input.tenantId) {
      await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;
    }

    // Fetch user and credentials
    const rows = await tx<{
      id: string;
      tenant_id: string;
      name: string;
      email: string;
      password_hash: string;
      totp_enabled: boolean;
      failed_attempts: number;
      locked_until: Date | null;
      status: string;
    }[]>`
      SELECT u.id, u.tenant_id, u.name, u.email, c.password_hash, c.totp_enabled, c.failed_attempts, c.locked_until, u.status
      FROM users u
      JOIN auth_credentials c ON c.user_id = u.id AND c.tenant_id = u.tenant_id
      WHERE u.email = ${email} AND u.deleted_at IS NULL;
    `;

    if (rows.length === 0) {
      throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS", 401);
    }

    const user = rows[0]!;

    // Re-scope transaction to verified user's tenant_id
    await tx`SELECT set_config('app.tenant_id', ${user.tenant_id}, true);`;

    // Check account lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new AuthError(
        "Account locked due to excessive failed attempts. Please try again later.",
        "ACCOUNT_LOCKED",
        429,
      );
    }

    // Verify password
    const valid = await verifyPassword(input.password, user.password_hash);
    if (!valid) {
      const attempts = user.failed_attempts + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

      await tx`
        UPDATE auth_credentials
        SET failed_attempts = ${attempts},
            locked_until = ${lockedUntil},
            updated_at = NOW()
        WHERE user_id = ${user.id} AND tenant_id = ${user.tenant_id};
      `;

      throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS", 401);
    }

    // DEV-025 (D80): an account that is not active (suspended, or any other status) cannot sign
    // in. It gets exactly the wrong-password answer, only after the password was checked, and
    // leaves the lockout counters alone, so neither the answer nor its timing reveals the state.
    if (user.status !== "active") {
      throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS", 401);
    }

    // Reset failed attempts on success
    await tx`
      UPDATE auth_credentials
      SET failed_attempts = 0, locked_until = NULL, updated_at = NOW()
      WHERE user_id = ${user.id} AND tenant_id = ${user.tenant_id};
    `;

    if (input.issueSession === false) {
      return { passwordVerified: true, totpEnabled: user.totp_enabled, userId: user.id, tenantId: user.tenant_id };
    }

    // Fetch user roles in tenant
    const memberRows = await tx<{ role: string }[]>`
      SELECT role FROM workspace_members
      WHERE user_id = ${user.id} AND tenant_id = ${user.tenant_id};
    `;
    const memberRoles = memberRows.map((r) => r.role);
    const roles = memberRoles.includes("ws_admin")
      ? ["org_admin", ...memberRoles]
      : memberRoles;

    const requiresMfa = user.totp_enabled || roles.some((r) => r !== "viewer");

    if (requiresMfa && user.totp_enabled) {
      // No roles, and an audience the REST API and /mcp both refuse (DEV-022): this token only
      // completes the TOTP step at /v1/auth/mfa/verify.
      const challengeToken = signJwt(
        {
          sub: user.id,
          tid: user.tenant_id,
          sid: MFA_CHALLENGE_SID,
          roles: [],
          mfa: false,
          aud: MFA_CHALLENGE_AUDIENCE,
        },
        300, // 5 minutes challenge validity
      );

      return { mfaRequired: true, challengeToken, userId: user.id, tenantId: user.tenant_id };
    }

    // Create session family & session
    const sessionFamilyId = randomUUID();
    const sessionId = randomUUID();
    const { token: refreshToken, hash: refreshHash } = generateRefreshToken(user.tenant_id);
    const absoluteExpiry = new Date(Date.now() + 12 * 3600 * 1000);

    await tx`
      INSERT INTO auth_sessions (
        id, tenant_id, user_id, session_family_id, refresh_token_hash,
        ip_hash, user_agent, expires_at
      ) VALUES (
        ${sessionId}, ${user.tenant_id}, ${user.id}, ${sessionFamilyId}, ${refreshHash},
        ${input.ipHash ?? null}, ${input.userAgent ?? null}, ${absoluteExpiry}
      );
    `;

    await tx`
      INSERT INTO sign_in_history (
        tenant_id, user_id, ip_address, user_agent, location, status
      ) VALUES (
        ${user.tenant_id}, ${user.id}, ${input.ipHash || "127.0.0.1"},
        ${input.userAgent ?? null}, ${JSON.stringify({ country: "US", city: "Local" })}, 'success'
      );
    `;

    const accessToken = signJwt({
      sub: user.id,
      tid: user.tenant_id,
      sid: sessionId,
      roles,
      mfa: false,
    });

    return {
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 900,
        tokenType: "Bearer",
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: user.tenant_id,
        },
      },
    };
  }

  /**
   * Checks a TOTP code for an account that has enrolled TOTP, and uses it up (D75). Creates no
   * session: the OAuth sign-in page (D69) uses it between the password step and consent.
   */
  static async verifyTotpCode(
    tx: Tx,
    input: { userId: string; tenantId: string; totpCode: string },
  ): Promise<boolean> {
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;
    const rows = await tx<{ totp_secret: string | null; totp_enabled: boolean }[]>`
      SELECT totp_secret, totp_enabled FROM auth_credentials
      WHERE user_id = ${input.userId} AND tenant_id = ${input.tenantId};
    `;
    const cred = rows[0];
    if (!cred?.totp_enabled || !cred.totp_secret) return false;
    return consumeTotpCode(tx, { userId: input.userId, tenantId: input.tenantId, secret: cred.totp_secret, code: input.totpCode });
  }

  /**
   * Completes the MFA sign-in challenge for an account that has enrolled TOTP.
   *
   * The account is the one named by the challenge token the password step returned (D75,
   * DEV-023): a user ID and a code alone sign nobody in. A `userId` or `tenantId` sent with it
   * must match the token.
   *
   * It never enrols: TOTP is switched on only by completing the admin-issued one-time link
   * (D71, AuthService.completeAccountSetup), so a password alone can never add an
   * authenticator.
   */
  static async verifyMfa(
    tx: Tx,
    input: {
      challengeToken: string;
      totpCode: string;
      userId?: string | undefined;
      tenantId?: string | undefined;
      ipHash?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<AuthTokens> {
    const refused = () => new AuthError("Invalid or expired MFA challenge. Sign in with your password again.", "INVALID_MFA_CHALLENGE", 401);
    let claims;
    try {
      claims = verifyJwt(input.challengeToken);
    } catch {
      throw refused();
    }
    if (claims.aud !== MFA_CHALLENGE_AUDIENCE || claims.sid !== MFA_CHALLENGE_SID) throw refused();
    if (input.userId !== undefined && input.userId !== claims.sub) throw refused();
    if (input.tenantId !== undefined && input.tenantId !== claims.tid) throw refused();
    const userId = claims.sub;
    const tenantId = claims.tid;

    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;

    // The account may have been suspended since the password step (D80): refused like an
    // invalid challenge, before the code is used up.
    const active = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} AND tenant_id = ${tenantId} AND deleted_at IS NULL AND status = 'active';
    `;
    if (active.length === 0) throw refused();

    const credRows = await tx<{ totp_secret: string | null; totp_enabled: boolean }[]>`
      SELECT totp_secret, totp_enabled FROM auth_credentials
      WHERE user_id = ${userId} AND tenant_id = ${tenantId};
    `;

    if (credRows.length === 0 || !credRows[0]?.totp_secret || !credRows[0].totp_enabled) {
      throw new AuthError(
        "MFA not configured for user. TOTP is enrolled through the administrator's one-time setup link.",
        "MFA_NOT_CONFIGURED",
        400,
      );
    }

    const valid = await consumeTotpCode(tx, { userId, tenantId, secret: credRows[0].totp_secret, code: input.totpCode });
    if (!valid) {
      throw new AuthError("Invalid TOTP code", "INVALID_MFA_CODE", 401);
    }

    // Fetch user details & roles
    const userRows = await tx<{ id: string; email: string; name: string }[]>`
      SELECT id, email, name FROM users WHERE id = ${userId} AND tenant_id = ${tenantId};
    `;
    const user = userRows[0]!;

    const memberRows = await tx<{ role: string }[]>`
      SELECT role FROM workspace_members
      WHERE user_id = ${userId} AND tenant_id = ${tenantId};
    `;
    const memberRoles = memberRows.map((r) => r.role);
    const roles = memberRoles.includes("ws_admin")
      ? ["org_admin", ...memberRoles]
      : memberRoles;

    // Create session
    const sessionFamilyId = randomUUID();
    const sessionId = randomUUID();
    const { token: refreshToken, hash: refreshHash } = generateRefreshToken(tenantId);
    const absoluteExpiry = new Date(Date.now() + 12 * 3600 * 1000);

    await tx`
      INSERT INTO auth_sessions (
        id, tenant_id, user_id, session_family_id, refresh_token_hash,
        mfa_verified_at, ip_hash, user_agent, expires_at
      ) VALUES (
        ${sessionId}, ${tenantId}, ${userId}, ${sessionFamilyId}, ${refreshHash},
        NOW(), ${input.ipHash ?? null}, ${input.userAgent ?? null}, ${absoluteExpiry}
      );
    `;

    const accessToken = signJwt({
      sub: user.id,
      tid: tenantId,
      sid: sessionId,
      roles,
      mfa: true,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      tokenType: "Bearer",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenantId,
      },
    };
  }

  /**
   * Step-up re-authentication: records fresh MFA timestamp on active session (PRD §40.1, D51).
   */
  static async stepUpMfa(
    tx: Tx,
    input: {
      userId: string;
      tenantId: string;
      sessionId: string;
      totpCode: string;
      requestId?: string;
    },
  ): Promise<{ stepUpAt: string; accessToken: string }> {
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;

    const credRows = await tx<{ totp_secret: string | null }[]>`
      SELECT totp_secret FROM auth_credentials
      WHERE user_id = ${input.userId};
    `;

    if (credRows.length === 0 || !credRows[0]?.totp_secret) {
      throw new AuthError("MFA secret not configured", "MFA_NOT_CONFIGURED", 400);
    }

    const valid = await consumeTotpCode(tx, { userId: input.userId, tenantId: input.tenantId, secret: credRows[0].totp_secret, code: input.totpCode });
    if (!valid) {
      throw new AuthError("Invalid step-up MFA code", "INVALID_STEP_UP_CODE", 401);
    }

    const now = new Date();
    await tx`
      UPDATE auth_sessions
      SET step_up_at = ${now}, last_active_at = ${now}, updated_at = ${now}
      WHERE id = ${input.sessionId} AND tenant_id = ${input.tenantId} AND is_revoked = false;
    `;

    // Fetch user roles in tenant
    const memberRows = await tx<{ role: string }[]>`
      SELECT role FROM workspace_members
      WHERE user_id = ${input.userId} AND tenant_id = ${input.tenantId};
    `;
    const memberRoles = memberRows.map((r) => r.role);
    const roles = memberRoles.includes("ws_admin")
      ? ["org_admin", ...memberRoles]
      : memberRoles;

    const accessToken = signJwt({
      sub: input.userId,
      tid: input.tenantId,
      sid: input.sessionId,
      roles,
      mfa: true,
      stepUpAt: now.toISOString(),
    });

    return { stepUpAt: now.toISOString(), accessToken };
  }

  /**
   * Rotating refresh token with strict reuse detection (§40.1).
   *
   * Phase 2B (D76):
   * - Rotation is atomic. The presented session is claimed with one conditional UPDATE
   *   (`WHERE is_revoked = false RETURNING`), so of two requests racing with the same token
   *   exactly one rotates it. The other has presented a token that is no longer live, which is
   *   what reuse looks like, and is handled as reuse: the whole family is revoked.
   * - The user is re-checked on every refresh: an account that is no longer active (suspended,
   *   deleted) is refused and the family revoked. OAuth refreshes also re-run the MCP
   *   eligibility check (`oauth.eligible`: role, workspace membership, ethical wall).
   */
  static async rotateRefreshToken(
    tx: Tx,
    input: {
      refreshToken: string;
      tenantId?: string;
      requestId?: string;
      /**
       * Set by the OAuth token endpoint (D69): the session must belong to this client and
       * audience, and it dies after `idleSeconds` without a refresh. Without it (the REST
       * endpoint) sessions that have an audience are refused and left untouched.
       * `eligible` re-checks that the user may still use MCP on this matter (D76).
       */
      oauth?:
        | {
            audience: string;
            clientId: string;
            scope: string;
            idleSeconds: number;
            eligible: (tx: Tx, userId: string) => Promise<boolean>;
          }
        | undefined;
    },
  ): Promise<AuthTokens | { isError: true; error: AuthError }> {
    let rawToken = input.refreshToken;
    let tenantId = input.tenantId;

    if (rawToken.includes("_")) {
      const parts = rawToken.split("_");
      tenantId = parts[0];
      rawToken = parts.slice(1).join("_");
    }

    if (tenantId) {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
    }

    const tokenHash = hashToken(rawToken);

    // Look up session matching token hash
    const sessions = await tx<{
      id: string;
      tenant_id: string;
      user_id: string;
      session_family_id: string;
      is_revoked: boolean;
      expires_at: Date;
      mfa_verified_at: Date | null;
      step_up_at: Date | null;
      oauth_client_id: string | null;
      audience: string | null;
      expired: boolean;
      idle_seconds: number;
    }[]>`
      SELECT id, tenant_id, user_id, session_family_id, is_revoked, expires_at, mfa_verified_at, step_up_at,
             oauth_client_id, audience,
             -- Both ages come from the database clock, the clock that wrote the timestamps;
             -- the API host's clock may differ from it.
             expires_at <= NOW() AS expired,
             EXTRACT(EPOCH FROM (NOW() - last_active_at))::float8 AS idle_seconds
      FROM auth_sessions
      WHERE refresh_token_hash = ${tokenHash};
    `;

    const revokeFamily = async (s: { session_family_id: string; tenant_id: string }) => {
      await tx`
        UPDATE auth_sessions SET is_revoked = true, updated_at = NOW()
        WHERE session_family_id = ${s.session_family_id} AND tenant_id = ${s.tenant_id};
      `;
    };

    // REUSE DETECTION: a token that is no longer live, presented again, kills the whole family.
    const reuseDetected = async (s: { session_family_id: string; tenant_id: string; user_id: string }) => {
      await revokeFamily(s);
      await writeAuditEvent(tx, {
        tenantId: s.tenant_id,
        timestamp: new Date(),
        actorType: "system",
        actorId: s.user_id,
        actorDisplay: "Auth Security Monitor",
        action: "auth.session_family_revoked",
        objectType: "session_family",
        objectId: s.session_family_id,
        objectDisplay: `Session Family ${s.session_family_id}`,
        rationale: "Refresh token reuse attempt detected",
        requestId: input.requestId ?? "req_token_reuse",
        outcome: "denied",
        denialReason: "token_reuse_detected",
      });
      return {
        isError: true as const,
        error: new AuthError("Invalid or reused refresh token. Session revoked.", "TOKEN_REUSE_DETECTED", 401),
      };
    };

    const found = sessions[0];
    if (!found) {
      return {
        isError: true,
        error: new AuthError("Invalid or reused refresh token. Session revoked.", "TOKEN_REUSE_DETECTED", 401),
      };
    }
    if (found.is_revoked) return reuseDetected(found);

    const session = found;
    await tx`SELECT set_config('app.tenant_id', ${session.tenant_id}, true);`;

    // REST and OAuth (MCP) sessions never cross over. A mismatch is refused without rotating
    // or revoking, so presenting a token at the wrong endpoint does not break the connection.
    if (!input.oauth && session.audience !== null) {
      return {
        isError: true,
        error: new AuthError("This refresh token belongs to an MCP connection", "INVALID_REFRESH_TOKEN", 401),
      };
    }
    if (input.oauth && (session.audience !== input.oauth.audience || session.oauth_client_id !== input.oauth.clientId)) {
      return {
        isError: true,
        error: new AuthError("Refresh token was not issued to this client", "INVALID_GRANT", 400),
      };
    }
    // An MCP connection unused for idleSeconds is over (plan section 2: 30 days unused).
    if (input.oauth && session.idle_seconds > input.oauth.idleSeconds) {
      await revokeFamily(session);
      return {
        isError: true,
        error: new AuthError("Session expired after inactivity", "SESSION_EXPIRED", 400),
      };
    }

    // Check expiration
    if (session.expired) {
      await tx`
        UPDATE auth_sessions SET is_revoked = true, updated_at = NOW()
        WHERE id = ${session.id} AND tenant_id = ${session.tenant_id};
      `;
      return {
        isError: true,
        error: new AuthError("Session expired", "SESSION_EXPIRED", 401),
      };
    }

    // The user must still be active (D76) and, for an MCP connection, still eligible for MCP
    // on this matter. Either failure ends the session family, not just this refresh.
    const userRows = await tx<{ id: string; email: string; name: string; status: string; deleted: boolean }[]>`
      SELECT id, email, name, status, deleted_at IS NOT NULL AS deleted
      FROM users WHERE id = ${session.user_id} AND tenant_id = ${session.tenant_id};
    `;
    const user = userRows[0];
    if (!user || user.deleted || user.status !== "active") {
      await revokeFamily(session);
      return { isError: true, error: new AuthError("Account inactive or deleted", "ACCOUNT_INACTIVE", 401) };
    }
    if (input.oauth && !(await input.oauth.eligible(tx, session.user_id))) {
      await revokeFamily(session);
      return {
        isError: true,
        error: new AuthError("The user no longer has access to this matter", "INVALID_GRANT", 400),
      };
    }

    // 1. Claim the presented session atomically. Zero rows: another request rotated it first.
    const claimed = await tx`
      UPDATE auth_sessions
      SET is_revoked = true, updated_at = NOW()
      WHERE id = ${session.id} AND tenant_id = ${session.tenant_id} AND is_revoked = false
      RETURNING id;
    `;
    if (claimed.length === 0) return reuseDetected(session);

    // 2. Create new session within the same session_family_id
    const newSessionId = randomUUID();
    const { token: newRefreshToken, hash: newHash } = generateRefreshToken(session.tenant_id);

    await tx`
      INSERT INTO auth_sessions (
        id, tenant_id, user_id, session_family_id, refresh_token_hash,
        mfa_verified_at, step_up_at, expires_at, oauth_client_id, audience
      ) VALUES (
        ${newSessionId}, ${session.tenant_id}, ${session.user_id}, ${session.session_family_id}, ${newHash},
        ${session.mfa_verified_at}, ${session.step_up_at}, ${session.expires_at},
        ${session.oauth_client_id}, ${session.audience}
      );
    `;

    const memberRows = await tx<{ role: string }[]>`
      SELECT role FROM workspace_members
      WHERE user_id = ${session.user_id} AND tenant_id = ${session.tenant_id};
    `;
    const memberRoles = memberRows.map((r) => r.role);
    const roles = memberRoles.includes("ws_admin")
      ? ["org_admin", ...memberRoles]
      : memberRoles;

    const accessToken = signJwt({
      sub: user.id,
      tid: session.tenant_id,
      sid: newSessionId,
      roles,
      mfa: session.mfa_verified_at !== null,
      stepUpAt: session.step_up_at ? session.step_up_at.toISOString() : undefined,
      ...(input.oauth ? { aud: input.oauth.audience, scope: input.oauth.scope, cid: input.oauth.clientId } : {}),
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
      tokenType: "Bearer",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenantId: session.tenant_id,
      },
    };
  }

  /**
   * Revokes one of the user's own sessions (logout, or signing out a device or a Claude
   * connection). DEV-027 (D81): a session of another user is not touched; the caller gets
   * false, exactly as for a session that does not exist. There is no administrator path: the
   * permission matrix has no session-management permission.
   */
  static async revokeSession(
    tx: Tx,
    sessionId: string,
    tenantId: string,
    userId: string,
  ): Promise<boolean> {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
    const rows = await tx`
      UPDATE auth_sessions
      SET is_revoked = true, updated_at = NOW()
      WHERE id = ${sessionId} AND tenant_id = ${tenantId} AND user_id = ${userId}
      RETURNING id;
    `;
    return rows.length === 1;
  }

  /**
   * Lists all active sessions for a user (AUTH-05).
   */
  static async listSessions(
    tx: Tx,
    userId: string,
    tenantId: string,
  ): Promise<Array<{ id: string; lastActiveAt: string; createdAt: string; isCurrent?: boolean }>> {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
    const rows = await tx<{ id: string; last_active_at: Date; created_at: Date }[]>`
      SELECT id, last_active_at, created_at
      FROM auth_sessions
      WHERE user_id = ${userId} AND tenant_id = ${tenantId} AND is_revoked = false AND expires_at > NOW()
      ORDER BY last_active_at DESC;
    `;

    return rows.map((r) => ({
      id: r.id,
      lastActiveAt: r.last_active_at.toISOString(),
      createdAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Issues a single-use password reset token for one user (AUTH-07, D65).
   *
   * Only an administrator calls this, through scripts/issue-password-reset.ts; there is no
   * HTTP route that returns a token. The token is valid for 60 minutes, only its SHA-256
   * digest is stored, and the issue is written to the audit log (without the token).
   */
  static async issuePasswordResetToken(
    tx: Tx,
    input: { tenantId: string; email: string; issuedBy: string; requestId: string },
  ): Promise<{ token: string; userId: string; email: string; expiresAt: Date }> {
    const normEmail = input.email.trim().toLowerCase();
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;

    const rows = await tx<{ id: string }[]>`
      SELECT id FROM users
      WHERE tenant_id = ${input.tenantId} AND email = ${normEmail} AND deleted_at IS NULL;
    `;
    const user = rows[0];
    if (!user) {
      throw new AuthError(`No active user with email ${normEmail} in tenant ${input.tenantId}`, "USER_NOT_FOUND", 404);
    }

    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    // Expiry comes from the database clock, the same clock as created_at.
    const inserted = await tx<{ expires_at: Date }[]>`
      INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at)
      VALUES (${input.tenantId}, ${user.id}, ${tokenHash}, NOW() + INTERVAL '60 minutes')
      RETURNING expires_at;
    `;
    const expiresAt = new Date(inserted[0]!.expires_at);

    await writeAuditEvent(tx, {
      tenantId: input.tenantId,
      actorType: "system",
      // audit_events.actor_id is a UUID and the CLI has no user row; the nil UUID marks a
      // system actor and actor_display records which administrator ran it.
      actorId: ADMIN_CLI_ACTOR_ID,
      actorDisplay: `Admin CLI (${input.issuedBy})`,
      action: "auth.password_reset_issued",
      objectType: "user",
      objectId: user.id,
      objectDisplay: normEmail,
      after: { expires_at: expiresAt.toISOString(), single_use: true, channel: "admin-cli" },
      requestId: input.requestId,
      outcome: "success",
    });

    return { token, userId: user.id, email: normEmail, expiresAt };
  }

  /**
   * Adds a person to the matter (DEV-030, D87): a user in the tenant with NO password and NO
   * TOTP, and a membership of the workspace that owns the matter's investigation with `role`,
   * which must be a role of the policy matrix. Refuses an email that already has an account in
   * the tenant (in any letter case, deleted accounts included: emails are unique per tenant).
   * Audited as `user.create`. The person gets in only through the one-time setup link (D71),
   * which the caller issues in the same transaction.
   */
  static async addMatterUser(
    tx: Tx,
    input: { tenantId: string; investigationId: string; email: string; name: string; role: string; issuedBy: string; requestId: string },
  ): Promise<{ userId: string; email: string; workspaceId: string; role: MatrixRole }> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(`${input.email} is not an email address`, "INVALID_EMAIL", 400);
    if (!name) throw new AuthError("A name is required", "INVALID_NAME", 400);
    if (!(MATRIX_ROLES as readonly string[]).includes(input.role)) {
      throw new AuthError(`"${input.role}" is not a role. Roles: ${MATRIX_ROLES.join(", ")}`, "INVALID_ROLE", 400);
    }
    const role = input.role as MatrixRole;
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;

    const inv = await tx<{ workspace_id: string }[]>`
      SELECT workspace_id FROM investigations
      WHERE id = ${input.investigationId} AND tenant_id = ${input.tenantId} AND deleted_at IS NULL;
    `;
    if (!inv[0]) throw new AuthError("MATTER_INVESTIGATION_ID does not name an investigation of MATTER_TENANT_ID", "INVESTIGATION_NOT_FOUND", 404);
    const workspaceId = inv[0].workspace_id;

    const existing = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE tenant_id = ${input.tenantId} AND lower(email) = ${email};
    `;
    if (existing.length > 0) throw new AuthError(`${email} already has an account in this matter`, "USER_EXISTS", 409);

    const userId = randomUUID();
    await tx`
      INSERT INTO users (id, tenant_id, email, name, status)
      VALUES (${userId}, ${input.tenantId}, ${email}, ${name}, 'active');
    `;
    await tx`
      INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
      VALUES (${randomUUID()}, ${input.tenantId}, ${workspaceId}, ${userId}, ${role});
    `;
    await writeAuditEvent(tx, {
      tenantId: input.tenantId,
      workspaceId,
      actorType: "system",
      actorId: ADMIN_CLI_ACTOR_ID,
      actorDisplay: `Admin CLI (${input.issuedBy})`,
      action: "user.create",
      objectType: "user",
      objectId: userId,
      objectDisplay: email,
      after: { email, name, role, workspace_id: workspaceId, password_set: false, totp_enrolled: false, channel: "admin-cli" },
      requestId: input.requestId,
      outcome: "success",
    });
    return { userId, email, workspaceId, role };
  }

  /**
   * Confirms password reset with single-use token (AUTH-07).
   * Verifies expiry, updates password, marks token used, and revokes all user sessions.
   */
  static async confirmPasswordReset(
    tx: Tx,
    token: string,
    newPassword: string,
    tenantId?: string | undefined,
  ): Promise<{ success: boolean; message: string }> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (tenantId) {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
    }

    const rows = await tx<{
      id: string;
      tenant_id: string;
      user_id: string;
      expires_at: Date;
      used_at: Date | null;
    }[]>`
      SELECT id, tenant_id, user_id, expires_at, used_at
      FROM password_reset_tokens
      WHERE token_hash = ${tokenHash};
    `;

    if (rows.length === 0 || rows[0]!.used_at !== null || new Date(rows[0]!.expires_at) <= new Date()) {
      throw new AuthError("Invalid or expired password reset token", "INVALID_RESET_TOKEN", 400);
    }

    const resetRecord = rows[0]!;
    await tx`SELECT set_config('app.tenant_id', ${resetRecord.tenant_id}, true);`;

    // 1. Mark token used (single-use)
    await tx`
      UPDATE password_reset_tokens
      SET used_at = NOW()
      WHERE id = ${resetRecord.id} AND tenant_id = ${resetRecord.tenant_id};
    `;

    // 2. Hash new password and update credentials
    const newHash = await hashPassword(newPassword);
    await tx`
      UPDATE auth_credentials
      SET password_hash = ${newHash},
          failed_attempts = 0,
          locked_until = NULL,
          updated_at = NOW()
      WHERE user_id = ${resetRecord.user_id} AND tenant_id = ${resetRecord.tenant_id};
    `;

    // 3. Invalidate all active sessions for this user across all devices
    await tx`
      UPDATE auth_sessions
      SET is_revoked = true, updated_at = NOW()
      WHERE user_id = ${resetRecord.user_id} AND tenant_id = ${resetRecord.tenant_id};
    `;

    return { success: true, message: "Password reset successfully. All sessions revoked." };
  }

  /**
   * The account behind a one-time setup token (the admin-issued reset link, D71), if the token
   * is unused and unexpired. Does not consume it.
   */
  static async inspectResetToken(
    tx: Tx,
    input: { tenantId: string; token: string },
  ): Promise<{ userId: string; email: string; expiresAt: Date } | null> {
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;
    const rows = await tx<{ user_id: string; email: string; expires_at: Date }[]>`
      SELECT t.user_id, u.email, t.expires_at
      FROM password_reset_tokens t
      JOIN users u ON u.id = t.user_id AND u.tenant_id = t.tenant_id
      WHERE t.token_hash = ${createHash("sha256").update(input.token).digest("hex")}
        AND t.tenant_id = ${input.tenantId} AND t.used_at IS NULL AND t.expires_at > NOW()
        AND u.deleted_at IS NULL;
    `;
    const row = rows[0];
    return row ? { userId: row.user_id, email: row.email, expiresAt: new Date(row.expires_at) } : null;
  }

  /**
   * Completes the admin-issued one-time link (D71): sets the password AND enrols TOTP in one
   * step, only after the user has proved the new authenticator with a valid code (the caller
   * checks it against `totpSecret`; `totpStep` is that code's time step, recorded so the same
   * code cannot then sign in, D75). This is the only place TOTP is switched on; a new link
   * replaces an existing authenticator. The token is consumed exactly once, every session of
   * the user is revoked, and the use is audited (the issue was audited when the link was made).
   */
  static async completeAccountSetup(
    tx: Tx,
    input: { tenantId: string; token: string; newPassword: string; totpSecret: string; totpStep: number; requestId: string },
  ): Promise<{ userId: string; email: string; reenrolled: boolean }> {
    await tx`SELECT set_config('app.tenant_id', ${input.tenantId}, true);`;
    const consumed = await tx<{ id: string; user_id: string }[]>`
      UPDATE password_reset_tokens SET used_at = NOW()
      WHERE token_hash = ${createHash("sha256").update(input.token).digest("hex")}
        AND tenant_id = ${input.tenantId} AND used_at IS NULL AND expires_at > NOW()
      RETURNING id, user_id;
    `;
    const tokenRow = consumed[0];
    if (!tokenRow) throw new AuthError("Invalid or expired setup link", "INVALID_RESET_TOKEN", 400);

    const users = await tx<{ email: string }[]>`
      SELECT email FROM users WHERE id = ${tokenRow.user_id} AND tenant_id = ${input.tenantId};
    `;
    const prior = await tx<{ totp_enabled: boolean }[]>`
      SELECT totp_enabled FROM auth_credentials WHERE user_id = ${tokenRow.user_id} AND tenant_id = ${input.tenantId};
    `;
    const reenrolled = prior[0]?.totp_enabled === true;

    const passwordHash = await hashPassword(input.newPassword);
    await tx`
      INSERT INTO auth_credentials (user_id, tenant_id, password_hash, totp_secret, totp_enabled, totp_last_step, failed_attempts, locked_until, updated_at)
      VALUES (${tokenRow.user_id}, ${input.tenantId}, ${passwordHash}, ${input.totpSecret}, true, ${input.totpStep}, 0, NULL, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        totp_secret = EXCLUDED.totp_secret,
        totp_enabled = true,
        totp_last_step = EXCLUDED.totp_last_step,
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = NOW();
    `;
    await tx`
      UPDATE auth_sessions SET is_revoked = true, updated_at = NOW()
      WHERE user_id = ${tokenRow.user_id} AND tenant_id = ${input.tenantId} AND is_revoked = false;
    `;
    await writeAuditEvent(tx, {
      tenantId: input.tenantId,
      actorType: "user",
      actorId: tokenRow.user_id,
      actorDisplay: users[0]?.email ?? "account setup",
      action: "auth.account_setup_completed",
      objectType: "user",
      objectId: tokenRow.user_id,
      objectDisplay: users[0]?.email ?? tokenRow.user_id,
      after: { password_set: true, totp_enrolled: true, totp_replaced: reenrolled, sessions_revoked: true, reset_token_id: tokenRow.id },
      requestId: input.requestId,
      outcome: "success",
    });
    return { userId: tokenRow.user_id, email: users[0]?.email ?? "", reenrolled };
  }

  /**
   * Lists sign-in history with IP and location metadata (AUTH-10).
   */
  static async listSignInHistory(
    tx: Tx,
    userId: string,
    tenantId: string,
  ): Promise<Array<{ id: string; ipAddress: string; userAgent: string | null; location: unknown; status: string; createdAt: string }>> {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
    const rows = await tx<{
      id: string;
      ip_address: string;
      user_agent: string | null;
      location: unknown;
      status: string;
      created_at: Date;
    }[]>`
      SELECT id, ip_address, user_agent, location, status, created_at
      FROM sign_in_history
      WHERE user_id = ${userId} AND tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 50;
    `;

    return rows.map((r) => ({
      id: r.id,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      location: r.location,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Generates WebAuthn Passkey registration options (AUTH-03).
   */
  static async generateWebAuthnRegistrationOptions(
    tx: Tx,
    userId: string,
    tenantId: string,
  ) {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
    const users = await tx<{ id: string; email: string; name: string }[]>`
      SELECT id, email, name FROM users WHERE id = ${userId} AND tenant_id = ${tenantId};
    `;
    if (users.length === 0) {
      throw new AuthError("User not found", "USER_NOT_FOUND", 404);
    }
    const user = users[0]!;

    const existingCreds = await tx<{ id: string; transports: string[] }[]>`
      SELECT id, transports FROM webauthn_credentials WHERE user_id = ${userId} AND tenant_id = ${tenantId};
    `;

    const options = await generateRegistrationOptions({
      rpName: "Casefile",
      rpID: process.env.RP_ID || "localhost",
      userID: Uint8Array.from(Buffer.from(user.id)),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: "none",
      excludeCredentials: existingCreds.map((c) => ({
        id: c.id,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    await tx`
      INSERT INTO webauthn_challenges (tenant_id, user_id, challenge, purpose, expires_at)
      VALUES (${tenantId}, ${userId}, ${options.challenge}, 'registration', NOW() + INTERVAL '5 minutes');
    `;

    return options;
  }

  /**
   * Verifies WebAuthn Passkey registration response and stores credential (AUTH-03).
   */
  static async verifyWebAuthnRegistration(
    tx: Tx,
    userId: string,
    tenantId: string,
    response: RegistrationResponseJSON,
    name?: string,
  ) {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
    const challenges = await tx<{ id: string; challenge: string }[]>`
      SELECT id, challenge FROM webauthn_challenges
      WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND purpose = 'registration' AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1;
    `;

    if (challenges.length === 0) {
      throw new AuthError("Registration challenge expired or not found", "CHALLENGE_EXPIRED", 400);
    }

    const currentChallenge = challenges[0]!;
    // Single-use challenge: delete immediately
    await tx`DELETE FROM webauthn_challenges WHERE id = ${currentChallenge.id};`;

    const rpID = process.env.RP_ID || "localhost";
    const expectedOrigins = [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "http://localhost",
      "https://app.casefile.com",
    ];

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: currentChallenge.challenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
      });
    } catch (err) {
      throw new AuthError(`WebAuthn registration failed: ${(err as Error).message}`, "WEBAUTHN_VERIFICATION_FAILED", 400);
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new AuthError("WebAuthn verification could not be completed", "WEBAUTHN_VERIFICATION_FAILED", 400);
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    await storeWebAuthnCredential(tx, {
      id: credential.id,
      tenantId,
      userId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: (credential.transports || []) as string[],
      name: name || "Default Passkey",
    });

    await tx`
      UPDATE users SET mfa_enabled = true, updated_at = NOW()
      WHERE id = ${userId} AND tenant_id = ${tenantId};
    `;

    return { verified: true, credentialId: credential.id };
  }

  /**
   * Generates WebAuthn authentication options (AUTH-03).
   */
  static async generateWebAuthnAuthenticationOptions(
    tx: Tx,
    input: { email?: string | undefined; tenantId?: string | undefined },
  ) {
    let allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }> = [];
    let userId: string | null = null;
    const tenantId = input.tenantId;

    if (input.email && tenantId) {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true);`;
      const users = await tx<{ id: string }[]>`
        SELECT id FROM users WHERE tenant_id = ${tenantId} AND email = ${input.email.toLowerCase()};
      `;
      if (users.length > 0) {
        userId = users[0]!.id;
        const creds = await tx<{ id: string; transports: string[] }[]>`
          SELECT id, transports FROM webauthn_credentials WHERE user_id = ${userId} AND tenant_id = ${tenantId};
        `;
        allowCredentials = creds.map((c) => ({
          id: c.id,
          transports: c.transports as AuthenticatorTransportFuture[],
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: process.env.RP_ID || "localhost",
      ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
      userVerification: "preferred",
    });

    if (tenantId) {
      await tx`
        INSERT INTO webauthn_challenges (tenant_id, user_id, challenge, purpose, expires_at)
        VALUES (${tenantId}, ${userId}, ${options.challenge}, 'authentication', NOW() + INTERVAL '5 minutes');
      `;
    }

    return options;
  }

  /**
   * Verifies WebAuthn authentication assertion and issues tokens (AUTH-03).
   */
  static async verifyWebAuthnAuthentication(
    tx: Tx,
    input: {
      response: AuthenticationResponseJSON;
      email?: string | undefined;
      tenantId?: string | undefined;
      ipHash?: string | undefined;
      userAgent?: string | undefined;
      requestId?: string | undefined;
    },
  ): Promise<AuthTokens> {
    const credRows = await tx<{
      id: string;
      tenant_id: string;
      user_id: string;
      public_key: Buffer;
      counter: string | number;
      transports: string[];
    }[]>`
      SELECT id, tenant_id, user_id, public_key, counter, transports
      FROM webauthn_credentials
      WHERE id = ${input.response.id};
    `;

    if (credRows.length === 0) {
      throw new AuthError("Passkey credential not found", "CREDENTIAL_NOT_FOUND", 404);
    }

    const cred = credRows[0]!;

    if (input.tenantId && input.tenantId !== cred.tenant_id) {
      throw new AuthError("Passkey credential does not belong to specified tenant", "CROSS_TENANT_CREDENTIAL", 404);
    }

    await tx`SELECT set_config('app.tenant_id', ${cred.tenant_id}, true);`;

    const challenges = await tx<{ id: string; challenge: string }[]>`
      SELECT id, challenge FROM webauthn_challenges
      WHERE tenant_id = ${cred.tenant_id} AND purpose = 'authentication' AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1;
    `;

    if (challenges.length === 0) {
      throw new AuthError("Authentication challenge expired or not found", "CHALLENGE_EXPIRED", 400);
    }

    const currentChallenge = challenges[0]!;
    // Single-use challenge: delete immediately to prevent assertion replay
    await tx`DELETE FROM webauthn_challenges WHERE id = ${currentChallenge.id};`;

    const rpID = process.env.RP_ID || "localhost";
    const expectedOrigins = [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "http://localhost",
      "https://app.casefile.com",
    ];

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: currentChallenge.challenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: Number(cred.counter),
          transports: cred.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch (err) {
      throw new AuthError(`Passkey assertion rejected: ${(err as Error).message}`, "ASSERTION_REJECTED", 401);
    }

    if (!verification.verified) {
      throw new AuthError("Passkey assertion verification failed", "ASSERTION_FAILED", 401);
    }

    // Update credential counter to detect clone/replay attacks
    await tx`
      UPDATE webauthn_credentials
      SET counter = ${verification.authenticationInfo.newCounter},
          last_used_at = NOW()
      WHERE id = ${cred.id};
    `;

    const userRows = await tx<{
      id: string;
      tenant_id: string;
      email: string;
      name: string;
      status: string;
    }[]>`
      SELECT id, tenant_id, email, name, status FROM users WHERE id = ${cred.user_id} AND tenant_id = ${cred.tenant_id};
    `;

    if (userRows.length === 0 || userRows[0]!.status !== "active") {
      throw new AuthError("Account inactive or deleted", "ACCOUNT_INACTIVE", 403);
    }

    const user = userRows[0]!;

    const rolesRows = await tx<{ role: string }[]>`
      SELECT role FROM workspace_members WHERE user_id = ${user.id} AND tenant_id = ${user.tenant_id};
    `;
    const roles = Array.from(new Set(["viewer", ...rolesRows.map((r) => r.role)]));

    const sessionId = randomUUID();
    const familyId = randomUUID();
    const { token: refreshToken, hash: hashedRefresh } = generateRefreshToken(user.tenant_id);

    await tx`
      INSERT INTO auth_sessions (
        id, tenant_id, user_id, session_family_id, refresh_token_hash,
        ip_hash, user_agent, expires_at, is_revoked
      ) VALUES (
        ${sessionId}, ${user.tenant_id}, ${user.id}, ${familyId}, ${hashedRefresh},
        ${input.ipHash || "127.0.0.1"}, ${input.userAgent ?? null},
        NOW() + INTERVAL '30 days', false
      );
    `;

    await tx`
      INSERT INTO sign_in_history (
        tenant_id, user_id, ip_address, user_agent, location, status
      ) VALUES (
        ${user.tenant_id}, ${user.id}, ${input.ipHash || "127.0.0.1"},
        ${input.userAgent ?? null}, ${JSON.stringify({ country: "US", city: "Local", method: "passkey" })}, 'success'
      );
    `;

    const accessToken = signJwt({
      sub: user.id,
      tid: user.tenant_id,
      sid: sessionId,
      roles,
      mfa: true,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      tokenType: "Bearer",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenantId: user.tenant_id,
      },
    };
  }
}

