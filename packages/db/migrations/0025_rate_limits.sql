-- 0025_rate_limits.sql
-- D66: request rate limits, shared by every API instance.
--
-- This table is deliberately NOT tenant-scoped: per-IP limits apply before any tenant is
-- known, and a per-account limit must hold across tenants guessed by an attacker. It holds
-- no tenant data. Keys are SHA-256 digests of the rule name plus the IP address or account
-- identifier, so neither addresses nor emails are stored.
--
-- RLS is still enabled and forced, like every other table, with a single policy that lets
-- the application role use it. Only SELECT, INSERT and UPDATE are granted; counters are
-- reused per key rather than deleted.

CREATE TABLE IF NOT EXISTS rate_limit_counters (
    bucket_key     VARCHAR(64) PRIMARY KEY,
    window_start   TIMESTAMPTZ NOT NULL,
    window_seconds INTEGER     NOT NULL CHECK (window_seconds > 0),
    hits           INTEGER     NOT NULL CHECK (hits >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_counters FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rate_limit_counters_app_access ON rate_limit_counters;
CREATE POLICY rate_limit_counters_app_access ON rate_limit_counters
    FOR ALL
    TO casefile_app
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON rate_limit_counters FROM casefile_app;
GRANT SELECT, INSERT, UPDATE ON rate_limit_counters TO casefile_app;
