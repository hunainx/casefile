-- Migration 0015: Search Engine, Investigation Memory, and Context Manifests (Epic E6)
-- Enforces forced Row Level Security (RLS) on all tables with tenant isolation.

-- 1. Search History Table (PRD §12.6 / SRCH-14)
CREATE TABLE IF NOT EXISTS search_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    search_mode VARCHAR(50) NOT NULL DEFAULT 'hybrid',
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_count INTEGER NOT NULL DEFAULT 0,
    weights_version VARCHAR(50) NOT NULL DEFAULT 'v1.0',
    index_generation VARCHAR(50) NOT NULL DEFAULT 'gen-1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_history_tenant_inv
    ON search_history (tenant_id, investigation_id, created_at DESC);

ALTER TABLE search_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_history_tenant_isolation ON search_history;
DROP POLICY IF EXISTS tenant_isolation ON search_history;
CREATE POLICY tenant_isolation ON search_history
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON search_history TO casefile_app;


-- 2. Saved Searches Table (PRD §12.6 / SRCH-13)
CREATE TABLE IF NOT EXISTS saved_searches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    query TEXT NOT NULL,
    search_mode VARCHAR(50) NOT NULL DEFAULT 'hybrid',
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    weights_version VARCHAR(50) NOT NULL DEFAULT 'v1.0',
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_tenant_inv
    ON saved_searches (tenant_id, investigation_id);

ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_searches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_searches_tenant_isolation ON saved_searches;
DROP POLICY IF EXISTS tenant_isolation ON saved_searches;
CREATE POLICY tenant_isolation ON saved_searches
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON saved_searches TO casefile_app;


-- 3. Search Monitors Table (PRD §12.6)
CREATE TABLE IF NOT EXISTS search_monitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    saved_search_id UUID REFERENCES saved_searches(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    query TEXT NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_monitors_tenant_inv
    ON search_monitors (tenant_id, investigation_id, is_active);

ALTER TABLE search_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_monitors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_monitors_tenant_isolation ON search_monitors;
DROP POLICY IF EXISTS tenant_isolation ON search_monitors;
CREATE POLICY tenant_isolation ON search_monitors
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON search_monitors TO casefile_app;


-- 4. Search Relevance Feedback Table (PRD §12.4 / SRCH-18)
CREATE TABLE IF NOT EXISTS search_relevance_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    is_relevant BOOLEAN NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_feedback_tenant_inv
    ON search_relevance_feedback (tenant_id, investigation_id, source_id);

ALTER TABLE search_relevance_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_relevance_feedback FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_relevance_feedback_tenant_isolation ON search_relevance_feedback;
DROP POLICY IF EXISTS tenant_isolation ON search_relevance_feedback;
CREATE POLICY tenant_isolation ON search_relevance_feedback
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON search_relevance_feedback TO casefile_app;


-- 5. Context Manifests Table (PRD §13.3)
CREATE TABLE IF NOT EXISTS context_manifests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    operation VARCHAR(100) NOT NULL,
    tier1 JSONB NOT NULL DEFAULT '{}'::jsonb,
    tier2 JSONB NOT NULL DEFAULT '{}'::jsonb,
    tier3 JSONB NOT NULL DEFAULT '{}'::jsonb,
    tier4 JSONB NOT NULL DEFAULT '[]'::jsonb,
    token_budget JSONB NOT NULL DEFAULT '{}'::jsonb,
    omitted JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_target VARCHAR(100) NOT NULL DEFAULT 'claude-3-5-sonnet',
    assembled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_context_manifests_tenant_inv
    ON context_manifests (tenant_id, investigation_id, assembled_at DESC);

ALTER TABLE context_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_manifests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS context_manifests_tenant_isolation ON context_manifests;
DROP POLICY IF EXISTS tenant_isolation ON context_manifests;
CREATE POLICY tenant_isolation ON context_manifests
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON context_manifests TO casefile_app;


-- 6. Investigation Memory Snapshots Table (PRD §13.2 / Tier 2 State Memory)
CREATE TABLE IF NOT EXISTS investigation_memory_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    focal_entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    dismissed_gap_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    corrected_summaries JSONB NOT NULL DEFAULT '{}'::jsonb,
    corpus_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    CONSTRAINT uq_memory_snapshot_inv UNIQUE (tenant_id, investigation_id)
);

ALTER TABLE investigation_memory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_memory_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS investigation_memory_snapshots_tenant_isolation ON investigation_memory_snapshots;
DROP POLICY IF EXISTS tenant_isolation ON investigation_memory_snapshots;
CREATE POLICY tenant_isolation ON investigation_memory_snapshots
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON investigation_memory_snapshots TO casefile_app;
