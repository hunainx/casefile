-- Migration 0019: Contradictions, Suppression Rules, and Research Gaps (Epic E9)
-- Enforces forced Row Level Security (RLS) on all tables with tenant isolation.

-- 1. Suppression Rules Table (PRD §24.5 / CON-07 / CON-08)
CREATE TABLE IF NOT EXISTS suppression_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    rule_type VARCHAR(50) NOT NULL, -- 'assertion_pair', 'entity_pattern', 'detector_pattern'
    pattern JSONB NOT NULL DEFAULT '{}'::jsonb,
    assertion_pair JSONB, -- { assertion_a_id, assertion_b_id }
    rationale TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppression_rules_tenant_inv
    ON suppression_rules (tenant_id, investigation_id);

ALTER TABLE suppression_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON suppression_rules;
CREATE POLICY tenant_isolation ON suppression_rules
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON suppression_rules TO casefile_app;


-- 2. Contradictions Table (PRD §24.3)
CREATE TABLE IF NOT EXISTS contradictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    detector VARCHAR(100) NOT NULL, -- 'attribute_conflict', 'temporal_conflict', 'exclusivity_conflict', 'numeric_conflict', 'statement_conflict'
    detector_class VARCHAR(50) NOT NULL DEFAULT 'deterministic', -- 'deterministic', 'semantic', 'hybrid'
    subtype VARCHAR(100) NOT NULL,
    assertion_a_id UUID NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
    assertion_b_id UUID NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
    evidence_a_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_b_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    description TEXT NOT NULL,
    severity VARCHAR(50) NOT NULL DEFAULT 'medium', -- 'critical', 'high', 'medium', 'low'
    severity_basis TEXT NOT NULL,
    affects_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    affects_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
    affects_hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'open', -- 'open', 'under_review', 'resolved', 'irreconcilable', 'dismissed'
    resolution JSONB, -- { type, rationale, resolved_by, resolved_at }
    suppression_rule_id UUID REFERENCES suppression_rules(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contradictions_tenant_inv_status
    ON contradictions (tenant_id, investigation_id, status, severity);

ALTER TABLE contradictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contradictions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON contradictions;
CREATE POLICY tenant_isolation ON contradictions
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON contradictions TO casefile_app;


-- 3. Research Gaps Table (PRD §25.3)
CREATE TABLE IF NOT EXISTS research_gaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    gap_type VARCHAR(100) NOT NULL, -- 'referenced_but_absent', 'unanswered_question', 'single_sourced_critical_claim', 'unverified_relationship', 'timeline_discontinuity', 'missing_document_type', 'unexamined_material'
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    target_ref JSONB, -- { type, id, name }
    blocks_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    blocks_hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb,
    priority VARCHAR(50) NOT NULL DEFAULT 'medium', -- 'critical', 'high', 'medium', 'low'
    priority_basis TEXT NOT NULL,
    suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'open', -- 'open', 'in_progress', 'closed', 'accepted_as_unresolvable', 'dismissed'
    resolution_rationale TEXT,
    closure_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_gaps_tenant_inv_status
    ON research_gaps (tenant_id, investigation_id, status, priority);

ALTER TABLE research_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_gaps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON research_gaps;
CREATE POLICY tenant_isolation ON research_gaps
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON research_gaps TO casefile_app;
