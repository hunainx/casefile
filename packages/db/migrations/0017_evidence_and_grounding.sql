-- Migration 0017: Evidence System, Citation Resolution & Grounding (Epic E7)
-- Enforces forced Row Level Security (RLS) on all tables with tenant isolation.

-- 1. Evidence Table (PRD §19.2)
CREATE TABLE IF NOT EXISTS evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
    content_block_id UUID REFERENCES content_blocks(id) ON DELETE SET NULL,
    locator JSONB NOT NULL DEFAULT '{}'::jsonb,
    cited_text TEXT NOT NULL,
    span_hash VARCHAR(64) NOT NULL,
    context_before TEXT NOT NULL DEFAULT '',
    context_after TEXT NOT NULL DEFAULT '',
    evidence_type VARCHAR(50) NOT NULL DEFAULT 'documentary'
        CHECK (evidence_type IN ('direct', 'circumstantial', 'testimonial', 'documentary', 'derived')),
    weight VARCHAR(50) NOT NULL DEFAULT 'moderate'
        CHECK (weight IN ('strong', 'moderate', 'weak')),
    weight_rationale TEXT,
    source_assessment_id UUID,
    integrity_status VARCHAR(50) NOT NULL DEFAULT 'intact'
        CHECK (integrity_status IN ('intact', 'source_withdrawn', 'span_drift', 'source_purged')),
    status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'superseded', 'withdrawn', 'excluded')),
    exclusion_reason TEXT,
    review_state VARCHAR(50) NOT NULL DEFAULT 'unreviewed'
        CHECK (review_state IN ('unreviewed', 'reviewed', 'disputed')),
    version INTEGER NOT NULL DEFAULT 1,
    supersedes_id UUID REFERENCES evidence(id) ON DELETE SET NULL,
    admitted_by UUID NOT NULL REFERENCES users(id),
    admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_evidence_tenant_inv ON evidence (tenant_id, investigation_id);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence (tenant_id, source_id);
CREATE INDEX IF NOT EXISTS idx_evidence_block ON evidence (tenant_id, content_block_id);
CREATE INDEX IF NOT EXISTS idx_evidence_span_hash ON evidence (tenant_id, span_hash);
CREATE INDEX IF NOT EXISTS idx_evidence_status ON evidence (tenant_id, investigation_id, status, integrity_status);

ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON evidence
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON evidence TO casefile_app;


-- 2. Evidence Links Table (PRD §19.2 / supports & contradicts relations)
CREATE TABLE IF NOT EXISTS evidence_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    target_type VARCHAR(50) NOT NULL
        CHECK (target_type IN ('assertion', 'claim', 'finding', 'question', 'hypothesis', 'entity', 'relationship')),
    target_id UUID NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'supports'
        CHECK (role IN ('supports', 'contradicts')),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_evidence_target UNIQUE (evidence_id, target_type, target_id, role)
);

CREATE INDEX IF NOT EXISTS idx_evidence_links_target ON evidence_links (tenant_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_evidence_links_evidence ON evidence_links (tenant_id, evidence_id);

ALTER TABLE evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_links FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON evidence_links
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON evidence_links TO casefile_app;
