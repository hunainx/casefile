-- 0003_audit.sql
-- Audit schema: audit_events (Invariant I8, Append-only, SELECT and INSERT grants only)

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(26) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  investigation_id UUID,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_type TEXT NOT NULL,
  actor_id UUID NOT NULL,
  actor_display TEXT NOT NULL,
  on_behalf_of UUID,
  session_id UUID,
  ip_hash TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id UUID NOT NULL,
  object_display TEXT NOT NULL,
  before JSONB,
  after JSONB,
  rationale TEXT,
  ai_involvement JSONB,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  denial_reason TEXT,
  prev_hash CHAR(64),
  hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_time ON audit_events(tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_investigation_time ON audit_events(investigation_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_time ON audit_events(actor_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_object ON audit_events(object_type, object_id);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_events
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Invariant I8: Insert-only, immutable by any application role. No UPDATE or DELETE grants, ever.
GRANT SELECT, INSERT ON audit_events TO casefile_app;
