-- 0026_oauth_mcp.sql
-- MCP sign-in, Phase 2A (docs/PLAN-MCP-AUTH.md section 2): Casefile is its own OAuth 2.1
-- authorization server for the /mcp connector. Additive only; existing migrations and the
-- existing session rows are untouched, so code deployed before this migration keeps working.

-- 1. A Claude connection is a session family in the existing auth_sessions table.
--    Both columns stay NULL for REST sessions; OAuth sessions carry the client_id (a Client
--    ID Metadata Document URL) and the audience their access tokens are issued for
--    (MCP_PUBLIC_URL). The REST refresh endpoint refuses rows with an audience, and the
--    OAuth token endpoint refuses rows without one.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS oauth_client_id TEXT;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS audience TEXT;

-- 2. Authorization codes. Only the SHA-256 digest of a code is stored, never the code.
--    A code is redeemed once (used_at) and expires 60 seconds after it is issued.
--    session_family_id records the session a code was redeemed for, so a second
--    redemption attempt can revoke it (OAuth 2.1 section 4.1.3).
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash             VARCHAR(64) NOT NULL UNIQUE,
    client_id             TEXT        NOT NULL,
    redirect_uri          TEXT        NOT NULL,
    code_challenge        TEXT        NOT NULL,
    code_challenge_method TEXT        NOT NULL CHECK (code_challenge_method = 'S256'),
    resource              TEXT        NOT NULL,
    scope                 TEXT        NOT NULL,
    expires_at            TIMESTAMPTZ NOT NULL,
    used_at               TIMESTAMPTZ,
    session_family_id     UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at <= created_at + INTERVAL '60 seconds')
);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_tenant_user
    ON oauth_authorization_codes (tenant_id, user_id);

ALTER TABLE oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorization_codes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oauth_authorization_codes;
CREATE POLICY tenant_isolation ON oauth_authorization_codes
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Codes are marked used, never deleted by the application.
REVOKE ALL ON oauth_authorization_codes FROM casefile_app;
GRANT SELECT, INSERT, UPDATE ON oauth_authorization_codes TO casefile_app;
