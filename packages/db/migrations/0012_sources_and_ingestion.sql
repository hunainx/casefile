-- Migration: 0012_sources_and_ingestion.sql
-- Epic: E3 Ingestion & Sources (PRD §10, §11, §44, §59.2)

-- 1. Sources table
CREATE TABLE IF NOT EXISTS sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    filename VARCHAR(512) NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    byte_size BIGINT NOT NULL DEFAULT 0,
    sha256 CHAR(64) NOT NULL,
    storage_uri TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'received'
        CHECK (status IN (
            'received', 'scanning', 'quarantined', 'admitted', 'linked',
            'processing', 'unprocessable', 'indexed', 'withdrawn', 'purged', 'held'
        )),
    source_class VARCHAR(50) NOT NULL DEFAULT 'primary_record'
        CHECK (source_class IN (
            'primary_record', 'communication', 'derived_record', 'published',
            'structured_data', 'media', 'investigator_generated'
        )),
    withdrawn_reason TEXT,
    withdrawn_at TIMESTAMPTZ,
    purged_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sources_tenant_investigation ON sources(tenant_id, investigation_id, status);
CREATE INDEX IF NOT EXISTS idx_sources_tenant_workspace_sha ON sources(tenant_id, workspace_id, sha256);

-- 2. Acquisition records
CREATE TABLE IF NOT EXISTS acquisition_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    origin VARCHAR(255) NOT NULL,
    custodian VARCHAR(255) NOT NULL,
    acquisition_method VARCHAR(100) NOT NULL DEFAULT 'upload'
        CHECK (acquisition_method IN ('upload', 'folder_import', 'connector', 'subpoena', 'open_source', 'manual_entry')),
    obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    authorization_basis TEXT,
    declared_by UUID REFERENCES users(id) ON DELETE SET NULL,
    connector_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_acquisition_records_tenant_source ON acquisition_records(tenant_id, source_id);

-- 3. Source instances (for byte-identical deduplication)
CREATE TABLE IF NOT EXISTS source_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    acquisition_record_id UUID NOT NULL REFERENCES acquisition_records(id) ON DELETE CASCADE,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_source_instances_tenant_investigation ON source_instances(tenant_id, investigation_id);

-- 4. Artifacts (parser outputs, OCR outputs, attachments)
CREATE TABLE IF NOT EXISTS artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    parent_artifact_id UUID REFERENCES artifacts(id) ON DELETE CASCADE,
    kind VARCHAR(50) NOT NULL DEFAULT 'primary'
        CHECK (kind IN ('primary', 'attachment', 'embedded_image', 'transcript', 'ocr_page', 'extracted_archive')),
    parser VARCHAR(100) NOT NULL DEFAULT 'native',
    parser_version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    ocr_engine VARCHAR(100),
    ocr_version VARCHAR(50),
    ocr_confidence NUMERIC(5, 4),
    status VARCHAR(50) NOT NULL DEFAULT 'ready'
        CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    storage_uri TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_source ON artifacts(tenant_id, source_id);

-- 5. Content documents (normalized document text)
CREATE TABLE IF NOT EXISTS content_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    normalizer_version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    language VARCHAR(20) NOT NULL DEFAULT 'en',
    doc_type VARCHAR(100) NOT NULL DEFAULT 'document',
    doc_date TIMESTAMPTZ,
    layout_confidence NUMERIC(5, 4) DEFAULT 1.0,
    revision INT NOT NULL DEFAULT 1,
    full_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_docs_tenant_artifact ON content_documents(tenant_id, artifact_id);

-- 6. Content blocks (structure-aware document units: sections, pages, cells)
CREATE TABLE IF NOT EXISTS content_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    content_document_id UUID NOT NULL REFERENCES content_documents(id) ON DELETE CASCADE,
    sequence INT NOT NULL DEFAULT 1,
    block_type VARCHAR(50) NOT NULL DEFAULT 'paragraph'
        CHECK (block_type IN ('paragraph', 'heading', 'table', 'table_cell', 'email_header', 'transcript_turn', 'list_item', 'ocr_page')),
    section_path TEXT,
    page INT,
    char_start INT NOT NULL DEFAULT 0,
    char_end INT NOT NULL DEFAULT 0,
    bbox JSONB,
    text TEXT NOT NULL,
    text_uri TEXT,
    language VARCHAR(20) DEFAULT 'en',
    ocr_confidence NUMERIC(5, 4),
    is_ocr_corrected BOOLEAN NOT NULL DEFAULT FALSE,
    corrected_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_tenant_doc ON content_blocks(tenant_id, content_document_id, sequence);

-- 7. Chunks (retrieval index units with contextual headers)
CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    content_document_id UUID NOT NULL REFERENCES content_documents(id) ON DELETE CASCADE,
    block_ids UUID[] NOT NULL DEFAULT '{}',
    char_start INT NOT NULL DEFAULT 0,
    char_end INT NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    contextual_header TEXT,
    token_count INT NOT NULL DEFAULT 0,
    doc_type VARCHAR(100),
    doc_date TIMESTAMPTZ,
    entity_ids UUID[] DEFAULT '{}',
    index_generation INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_tenant_investigation ON chunks(tenant_id, investigation_id, index_generation);

-- 8. Near-duplicate clusters
CREATE TABLE IF NOT EXISTS near_duplicate_clusters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    similarity_score NUMERIC(5, 4) NOT NULL,
    source_a_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    source_b_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    diff_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_near_dup_tenant_investigation ON near_duplicate_clusters(tenant_id, investigation_id);

-- 9. Ingestion Jobs
CREATE TABLE IF NOT EXISTS source_ingestion_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    stage VARCHAR(50) NOT NULL DEFAULT 'queued'
        CHECK (stage IN ('queued', 'scanning', 'parsing', 'ocr', 'normalizing', 'chunking', 'indexing', 'completed', 'failed')),
    progress_percent INT NOT NULL DEFAULT 0,
    error_message TEXT,
    dead_letter_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_tenant ON source_ingestion_jobs(tenant_id, investigation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Enable Row Level Security (RLS) on all new tables
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources FORCE ROW LEVEL SECURITY;

ALTER TABLE acquisition_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE acquisition_records FORCE ROW LEVEL SECURITY;

ALTER TABLE source_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_instances FORCE ROW LEVEL SECURITY;

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;

ALTER TABLE content_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_documents FORCE ROW LEVEL SECURITY;

ALTER TABLE content_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_blocks FORCE ROW LEVEL SECURITY;

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;

ALTER TABLE near_duplicate_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE near_duplicate_clusters FORCE ROW LEVEL SECURITY;

ALTER TABLE source_ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_ingestion_jobs FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- Define RLS Policies
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY tenant_isolation_sources ON sources
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_acquisition_records ON acquisition_records
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_source_instances ON source_instances
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_artifacts ON artifacts
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_content_documents ON content_documents
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_content_blocks ON content_blocks
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_chunks ON chunks
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_near_dup ON near_duplicate_clusters
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_ingestion_jobs ON source_ingestion_jobs
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- Grant Permissions to casefile_app
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON sources TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON acquisition_records TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON source_instances TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON artifacts TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_documents TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_blocks TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chunks TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON near_duplicate_clusters TO casefile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON source_ingestion_jobs TO casefile_app;
