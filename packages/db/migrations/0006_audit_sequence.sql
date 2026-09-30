-- 0006_audit_sequence.sql
-- Add contiguous per-tenant sequence and audit_chain_heads table for tail-truncation protection (D52, I8).

-- 1. Alter audit_events id to VARCHAR(26) for ULIDs and add seq column with unique constraint
TRUNCATE audit_events;

ALTER TABLE audit_events ALTER COLUMN id TYPE VARCHAR(26);
ALTER TABLE audit_events ADD COLUMN seq BIGINT NOT NULL DEFAULT 1;
ALTER TABLE audit_events ALTER COLUMN seq DROP DEFAULT;

ALTER TABLE audit_events ADD CONSTRAINT uq_audit_events_tenant_seq UNIQUE (tenant_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_seq ON audit_events (tenant_id, seq ASC);

-- 2. Create audit_chain_heads table to record expected chain termination point per tenant
CREATE TABLE IF NOT EXISTS audit_chain_heads (
  tenant_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_seq BIGINT NOT NULL DEFAULT 0,
  last_hash CHAR(64) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_chain_heads_tenant ON audit_chain_heads(tenant_id);

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_chain_heads
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Grant SELECT, INSERT, UPDATE only. No DELETE or TRUNCATE grants.
GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO casefile_app;
