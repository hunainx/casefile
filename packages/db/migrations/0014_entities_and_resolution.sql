-- 0014_entities_and_resolution.sql
-- Epic E5: Entities, Entity Resolution, Mentions, Merges, and Relationships (PRD §14, §15, §16, §56.5)

-- 1. Entities table
CREATE TABLE IF NOT EXISTS entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    scope VARCHAR(50) NOT NULL DEFAULT 'investigation'
        CHECK (scope IN ('investigation', 'workspace')),
    type VARCHAR(50) NOT NULL
        CHECK (type IN (
            'Person', 'Organization', 'Account', 'Address', 'Domain',
            'Email', 'Phone', 'Username', 'Document', 'Event',
            'Transaction', 'Asset', 'Vehicle', 'Device', 'Location', 'Website'
        )),
    subtype VARCHAR(100),
    canonical_name VARCHAR(255) NOT NULL,
    sensitivity VARCHAR(50) NOT NULL DEFAULT 'standard'
        CHECK (sensitivity IN ('standard', 'elevated', 'restricted')),
    subject_role VARCHAR(50)
        CHECK (subject_role IS NULL OR subject_role IN (
            'primary_subject', 'key_associate', 'counterparty',
            'witness', 'victim', 'custodian', 'other'
        )),
    is_focal BOOLEAN NOT NULL DEFAULT FALSE,
    confidence NUMERIC(5, 4) NOT NULL DEFAULT 0.8500
        CHECK (confidence >= 0.0000 AND confidence <= 1.0000),
    epistemic_state VARCHAR(50) NOT NULL DEFAULT 'Supported'
        CHECK (epistemic_state IN ('Unknown', 'Possible', 'Likely', 'Supported', 'Verified', 'Contradicted', 'Refuted')),
    status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'merged_away', 'archived', 'disputed')),
    merged_into_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_entities_tenant_inv_type ON entities(tenant_id, investigation_id, type);
CREATE INDEX IF NOT EXISTS idx_entities_tenant_name ON entities(tenant_id, canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON entities(tenant_id, merged_into_id);
CREATE INDEX IF NOT EXISTS idx_entities_focal ON entities(tenant_id, investigation_id, is_focal);

-- 2. Entity Aliases table (PRD §14.3)
CREATE TABLE IF NOT EXISTS entity_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    value VARCHAR(255) NOT NULL,
    alias_type VARCHAR(50) NOT NULL DEFAULT 'trading_name'
        CHECK (alias_type IN (
            'legal_name', 'trading_name', 'former_name', 'nickname',
            'transliteration', 'ocr_variant', 'abbreviation', 'misspelling', 'pseudonym'
        )),
    valid_from JSONB,
    valid_to JSONB,
    confidence NUMERIC(5, 4) NOT NULL DEFAULT 0.8500
        CHECK (confidence >= 0.0000 AND confidence <= 1.0000),
    source_of_alias VARCHAR(50) NOT NULL DEFAULT 'extracted'
        CHECK (source_of_alias IN ('extracted', 'human', 'transliteration_engine', 'ocr_correction')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_tenant_entity ON entity_aliases(tenant_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_tenant_val ON entity_aliases(tenant_id, value);

-- 3. Entity Identifiers table (PRD §14.2)
CREATE TABLE IF NOT EXISTS entity_identifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    scheme VARCHAR(100) NOT NULL,
    value VARCHAR(255) NOT NULL,
    jurisdiction VARCHAR(100),
    is_strong BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_identifiers_tenant_scheme ON entity_identifiers(tenant_id, scheme, value, jurisdiction);
CREATE INDEX IF NOT EXISTS idx_entity_identifiers_entity ON entity_identifiers(tenant_id, entity_id);

-- 4. Entity Mentions table (PRD §14.1, §55 ENT-04)
CREATE TABLE IF NOT EXISTS entity_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
    char_start INT NOT NULL DEFAULT 0,
    char_end INT NOT NULL DEFAULT 0,
    extracted_text TEXT NOT NULL,
    surrounding_context TEXT,
    confidence NUMERIC(5, 4) NOT NULL DEFAULT 0.8500
        CHECK (confidence >= 0.0000 AND confidence <= 1.0000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_tenant_entity ON entity_mentions(tenant_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_tenant_source ON entity_mentions(tenant_id, source_id);

-- 5. Entity Merge Candidates table (PRD §15.5)
CREATE TABLE IF NOT EXISTS entity_merge_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    entity_a_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entity_b_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    match_band VARCHAR(50) NOT NULL
        CHECK (match_band IN ('deterministic', 'high', 'medium', 'low', 'no_match')),
    score NUMERIC(5, 4) NOT NULL
        CHECK (score >= 0.0000 AND score <= 1.0000),
    signals JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'auto_merged', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_tenant_inv ON entity_merge_candidates(tenant_id, investigation_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_candidates_entities ON entity_merge_candidates(tenant_id, entity_a_id, entity_b_id);

-- 6. Entity Merge History table (PRD §15.6 / AC-RES-04)
CREATE TABLE IF NOT EXISTS entity_merge_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    surviving_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    merged_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    pre_merge_state_survivor JSONB NOT NULL,
    pre_merge_state_merged JSONB NOT NULL,
    match_score NUMERIC(5, 4) NOT NULL,
    signals JSONB NOT NULL DEFAULT '[]'::jsonb,
    rationale TEXT,
    forced_override BOOLEAN NOT NULL DEFAULT FALSE,
    merged_by UUID REFERENCES users(id) ON DELETE SET NULL,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unmerged_at TIMESTAMPTZ,
    unmerged_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_history_tenant ON entity_merge_history(tenant_id, investigation_id, surviving_entity_id);

-- 7. Relationships table (PRD §16.1 / REL-01..12)
CREATE TABLE IF NOT EXISTS relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL,
    direction VARCHAR(50) NOT NULL DEFAULT 'directed'
        CHECK (direction IN ('directed', 'bidirectional')),
    valid_from JSONB,
    valid_to JSONB,
    current_status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (current_status IN ('active', 'ended', 'unknown')),
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    discovery_channel VARCHAR(50) NOT NULL DEFAULT 'stated'
        CHECK (discovery_channel IN ('stated', 'structural', 'inferred', 'human')),
    inference_pattern VARCHAR(255),
    evidence_ids UUID[] NOT NULL DEFAULT '{}',
    epistemic_state VARCHAR(50) NOT NULL DEFAULT 'Supported'
        CHECK (epistemic_state IN ('Unknown', 'Possible', 'Likely', 'Supported', 'Verified', 'Contradicted', 'Refuted')),
    confidence NUMERIC(5, 4) NOT NULL DEFAULT 0.8500
        CHECK (confidence >= 0.0000 AND confidence <= 1.0000),
    verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    review_rationale TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT check_relationship_inferred_pattern
        CHECK (discovery_channel != 'inferred' OR inference_pattern IS NOT NULL),
    CONSTRAINT check_rel_verified_requires_reviewer
        CHECK (epistemic_state NOT IN ('Verified', 'Refuted') OR verified_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_relationships_tenant_inv ON relationships(tenant_id, investigation_id, type);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(tenant_id, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(tenant_id, target_entity_id);

-- Enable & Force Row Level Security on all E5 tables
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;

ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases FORCE ROW LEVEL SECURITY;

ALTER TABLE entity_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_identifiers FORCE ROW LEVEL SECURITY;

ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions FORCE ROW LEVEL SECURITY;

ALTER TABLE entity_merge_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_merge_candidates FORCE ROW LEVEL SECURITY;

ALTER TABLE entity_merge_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_merge_history FORCE ROW LEVEL SECURITY;

ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships FORCE ROW LEVEL SECURITY;

-- Tenant Isolation Policies
CREATE POLICY tenant_isolation ON entities
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON entity_aliases
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON entity_identifiers
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON entity_mentions
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON entity_merge_candidates
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON entity_merge_history
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON relationships
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Grant privileges to application role
GRANT SELECT, INSERT, UPDATE ON entities TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_aliases TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_identifiers TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_mentions TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_merge_candidates TO casefile_app;
GRANT SELECT, INSERT, UPDATE ON entity_merge_history TO casefile_app;
GRANT SELECT, INSERT, UPDATE ON relationships TO casefile_app;
