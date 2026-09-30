-- 0007_auth_sessions.sql
-- Authentication credentials, session management, and idempotency tracking (PRD §40.1, §40.2, §45.1, D51).

-- 1. Credentials table (Argon2id password hashes, TOTP MFA, brute-force locking)
CREATE TABLE IF NOT EXISTS auth_credentials (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    totp_secret VARCHAR(255),
    totp_enabled BOOLEAN NOT NULL DEFAULT false,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_auth_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_auth_credentials_tenant_user ON auth_credentials(tenant_id, user_id);

-- 2. Sessions table (JWT access + rotating refresh token family reuse detection, step-up MFA per D51)
CREATE TABLE IF NOT EXISTS auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_family_id UUID NOT NULL,
    refresh_token_hash VARCHAR(64) NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    mfa_verified_at TIMESTAMPTZ,
    step_up_at TIMESTAMPTZ,
    ip_hash VARCHAR(64),
    user_agent VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_auth_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_tenant_user ON auth_sessions(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_family ON auth_sessions(tenant_id, session_family_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(tenant_id, refresh_token_hash);

-- 3. Idempotency table (PRD §45.1)
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(255) NOT NULL,
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    status_code INT NOT NULL,
    headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_body JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, key),
    CONSTRAINT fk_idempotency_keys_tenant FOREIGN KEY (tenant_id) REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);

-- 4. Enable and FORCE Row Level Security on all tenant tables
ALTER TABLE auth_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_credentials FORCE ROW LEVEL SECURITY;

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

-- 5. Strict Tenant Isolation Policies
CREATE POLICY tenant_isolation ON auth_credentials
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON auth_sessions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON idempotency_keys
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 6. Application Role Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_credentials TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO casefile_app;
