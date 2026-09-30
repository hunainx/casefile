-- ============================================================================
-- 0010_break_glass.sql
-- Break-glass access grants and dual-approval protocol (AC-SEC-05, SEC-06, SEC-07)
-- ============================================================================

CREATE TABLE IF NOT EXISTS break_glass_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  staff_user_id UUID NOT NULL,
  reason TEXT NOT NULL,
  requested_by UUID NOT NULL,
  approved_by UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'expired')),
  duration_minutes INT NOT NULL DEFAULT 60,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  customer_notified BOOLEAN NOT NULL DEFAULT false,
  session_recording_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_break_glass_grants_tenant ON break_glass_grants (tenant_id);

ALTER TABLE break_glass_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON break_glass_grants;
CREATE POLICY tenant_isolation ON break_glass_grants
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON break_glass_grants TO casefile_app;
