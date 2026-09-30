-- Migration 0018: AI Gateway, Results, and Tool Executions (Epic E8)
-- Enforces forced Row Level Security (RLS) on all tables with tenant isolation.

-- 1. AI Results Table (PRD §21.1 & §43)
CREATE TABLE IF NOT EXISTS ai_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    capability VARCHAR(100) NOT NULL,
    context_manifest_id UUID REFERENCES context_manifests(id) ON DELETE SET NULL,
    prompt_template_hash VARCHAR(64) NOT NULL DEFAULT '',
    model_provider VARCHAR(50) NOT NULL DEFAULT 'mock',
    model_id VARCHAR(100) NOT NULL DEFAULT 'deterministic-mock-v1',
    model_version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    output JSONB NOT NULL DEFAULT '{}'::jsonb,
    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    epistemic_state VARCHAR(50) NOT NULL DEFAULT 'Possible'
        CHECK (epistemic_state IN ('Unknown', 'Possible', 'Likely', 'Supported', 'Verified', 'Contradicted', 'Refuted')),
    confidence NUMERIC(5,4) NOT NULL DEFAULT 0.5000,
    insufficiency JSONB NOT NULL DEFAULT '{"not_established": []}'::jsonb,
    falsifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
    verification JSONB NOT NULL DEFAULT '{}'::jsonb,
    plane VARCHAR(20) NOT NULL DEFAULT 'machine'
        CHECK (plane IN ('machine', 'record')),
    promoted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    promoted_at TIMESTAMPTZ,
    cost JSONB NOT NULL DEFAULT '{"input_tokens": 0, "output_tokens": 0, "usd": 0}'::jsonb,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed', 'failed', 'flagged', 'rejected')),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_results_tenant_inv ON ai_results (tenant_id, investigation_id);
CREATE INDEX IF NOT EXISTS idx_ai_results_capability ON ai_results (tenant_id, investigation_id, capability);
CREATE INDEX IF NOT EXISTS idx_ai_results_plane ON ai_results (tenant_id, plane);

ALTER TABLE ai_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_results FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_results
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON ai_results TO casefile_app;


-- 2. AI Tool Executions Table (PRD §26.2 & §60)
CREATE TABLE IF NOT EXISTS ai_tool_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    ai_result_id UUID REFERENCES ai_results(id) ON DELETE CASCADE,
    tool_name VARCHAR(100) NOT NULL,
    action_class VARCHAR(10) NOT NULL
        CHECK (action_class IN ('A', 'B', 'C', 'D')),
    input_params JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'executed'
        CHECK (status IN ('executed', 'pending_approval', 'rejected', 'failed')),
    execution_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_exec_tenant_inv ON ai_tool_executions (tenant_id, investigation_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_class ON ai_tool_executions (tenant_id, action_class);
CREATE INDEX IF NOT EXISTS idx_tool_exec_tool ON ai_tool_executions (tenant_id, tool_name);

ALTER TABLE ai_tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_tool_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_tool_executions
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT ALL ON ai_tool_executions TO casefile_app;
