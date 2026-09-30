-- 0008_auth_extensions.sql
-- Password reset tokens (AUTH-07) and sign-in history audit (AUTH-10).

-- 1. Password reset tokens table (single-use, expiring, invalidates all sessions on reset)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_lookup ON password_reset_tokens(tenant_id, token_hash);

-- 2. Sign-in history table (AUTH-10)
CREATE TABLE IF NOT EXISTS sign_in_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    location JSONB NOT NULL DEFAULT '{"country": "Unknown", "city": "Unknown"}'::jsonb,
    status TEXT NOT NULL DEFAULT 'success',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sign_in_history_user ON sign_in_history(tenant_id, user_id, created_at DESC);

-- 3. Row Level Security
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

ALTER TABLE sign_in_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_history FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON password_reset_tokens
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON sign_in_history
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO casefile_app;
GRANT SELECT, INSERT ON sign_in_history TO casefile_app;
