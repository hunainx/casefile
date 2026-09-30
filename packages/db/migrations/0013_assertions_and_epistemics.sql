-- Migration: 0013_assertions_and_epistemics.sql
-- Epic: E4 Knowledge Core (Assertions, Epistemics & Provenance) (PRD §6, §7, §12, §13, §59.2)

-- 1. Assertions table (The Spine)
CREATE TABLE IF NOT EXISTS assertions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    kind VARCHAR(50) NOT NULL
        CHECK (kind IN ('attribute', 'relationship', 'event', 'claim', 'membership', 'identity')),
    subject_type VARCHAR(100) NOT NULL,
    subject_id UUID NOT NULL,
    predicate VARCHAR(255) NOT NULL,
    object_type VARCHAR(100) NOT NULL,
    object_id UUID,
    object_literal JSONB,
    valid_from JSONB,
    valid_to JSONB,
    asserter_type VARCHAR(50) NOT NULL
        CHECK (asserter_type IN ('source', 'human', 'model', 'deterministic')),
    asserter_id UUID NOT NULL,
    epistemic_state VARCHAR(50) NOT NULL DEFAULT 'Supported'
        CHECK (epistemic_state IN ('Unknown', 'Possible', 'Likely', 'Supported', 'Verified', 'Contradicted', 'Refuted')),
    confidence NUMERIC(5, 4) NOT NULL DEFAULT 0.80,
    confidence_basis JSONB NOT NULL DEFAULT '{}'::jsonb,
    plane VARCHAR(50) NOT NULL DEFAULT 'machine'
        CHECK (plane IN ('machine', 'record')),
    evidence_ids UUID[] NOT NULL DEFAULT '{}',
    derivation JSONB NOT NULL DEFAULT '{}'::jsonb,
    review_state VARCHAR(50) NOT NULL DEFAULT 'unreviewed'
        CHECK (review_state IN ('unreviewed', 'in_review', 'accepted', 'rejected', 'superseded')),
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    review_rationale TEXT,
    supersedes UUID REFERENCES assertions(id) ON DELETE SET NULL,
    superseded_by UUID REFERENCES assertions(id) ON DELETE SET NULL,
    discovery_channel VARCHAR(100),
    inference_pattern VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ,
    
    -- Invariant I2 (PRD §6.5 & §59.2): Model or deterministic asserters cannot write Verified or Refuted
    CONSTRAINT check_invariant_i2_epistemic_authority
        CHECK (asserter_type NOT IN ('model', 'deterministic') OR epistemic_state NOT IN ('Verified', 'Refuted')),
        
    -- Verified / Refuted must have reviewed_by set
    CONSTRAINT check_verified_requires_reviewer
        CHECK (epistemic_state NOT IN ('Verified', 'Refuted') OR reviewed_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_assertions_tenant_inv_kind_state ON assertions(tenant_id, investigation_id, kind, epistemic_state);
CREATE INDEX IF NOT EXISTS idx_assertions_subject ON assertions(tenant_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_assertions_object ON assertions(tenant_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_assertions_plane ON assertions(tenant_id, investigation_id, plane);

-- 2. Assertion evidence junction table
CREATE TABLE IF NOT EXISTS assertion_evidence (
    assertion_id UUID NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
    evidence_id UUID NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('supports', 'contradicts')),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (assertion_id, evidence_id, role)
);

CREATE INDEX IF NOT EXISTS idx_assertion_evidence_tenant ON assertion_evidence(tenant_id, assertion_id);

-- 3. Divergence Notices table (PRD §6.3 / AC-EPI-03)
CREATE TABLE IF NOT EXISTS divergence_notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    record_assertion_id UUID NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
    machine_assertion_id UUID NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
    divergence_type VARCHAR(100) NOT NULL DEFAULT 'value_mismatch',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_divergence_notices_tenant ON divergence_notices(tenant_id, investigation_id, status);

-- 4. Contradiction Alerts table (PRD §6.5 / AC-EPI-04)
CREATE TABLE IF NOT EXISTS contradiction_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    verified_assertion_id UUID NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
    conflicting_assertion_id UUID NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
    severity VARCHAR(50) NOT NULL DEFAULT 'high'
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'adjudicated', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contradiction_alerts_tenant ON contradiction_alerts(tenant_id, investigation_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Enable Row Level Security (RLS) on all new tables
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assertions FORCE ROW LEVEL SECURITY;

ALTER TABLE assertion_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE assertion_evidence FORCE ROW LEVEL SECURITY;

ALTER TABLE divergence_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE divergence_notices FORCE ROW LEVEL SECURITY;

ALTER TABLE contradiction_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contradiction_alerts FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- Define RLS Policies
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY tenant_isolation_assertions ON assertions
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_assertion_evidence ON assertion_evidence
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_divergence_notices ON divergence_notices
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_contradiction_alerts ON contradiction_alerts
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- Grant Permissions to casefile_app
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON assertions TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON assertion_evidence TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON divergence_notices TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON contradiction_alerts TO casefile_app;
