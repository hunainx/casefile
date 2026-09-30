-- 0029_ingest_triage.sql
-- Big-data engine, BIGDATA-3 (D98-D103; docs/PLAN-BIG-DATA.md section 2 and section 14): triage.
--
-- Triage RECORDS decisions; it never deletes, moves or overwrites anything in a bucket, and nothing
-- is silently dropped. For every object a run sees it decides ingest, skip-junk, skip-duplicate or
-- skip-filter, before any parsing, and writes that decision here. A decision is never changed:
-- re-including a skipped object writes a new decision (stage 'include') that supersedes the old
-- one, so every decision stays listed and every reversal is itself on record (and audited).
--
-- Additive only: three new tables. No existing table, column or row is changed.

-- 1. One row per run: where it read from, the filters the case owner chose (none = {}), the rule
--    versions, counters. BIGDATA-4 extends it for progress and cost.
CREATE TABLE IF NOT EXISTS ingest_runs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    kind             TEXT        NOT NULL CHECK (kind IN ('ingest', 'include')),
    source_kind      TEXT        NOT NULL CHECK (source_kind IN ('folder', 'bucket')),
    source           TEXT        NOT NULL,
    filters          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    rule_versions    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    counters         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    include_of_run   UUID        REFERENCES ingest_runs(id),
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triaged_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    started_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
    CHECK ((kind = 'include') = (include_of_run IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_tenant_investigation ON ingest_runs (tenant_id, investigation_id, started_at);

-- 2. One row per object seen (a file, a bucket object, or an item inside a zip or an email that a
--    rule skipped when the ingest reached it). seq orders the rows of a run.
CREATE TABLE IF NOT EXISTS ingest_decisions (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    seq                      BIGINT      GENERATED ALWAYS AS IDENTITY,
    tenant_id                UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id         UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    run_id                   UUID        NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    stage                    TEXT        NOT NULL CHECK (stage IN ('triage', 'ingest', 'include')),
    path                     TEXT        NOT NULL,
    byte_size                BIGINT      NOT NULL CHECK (byte_size >= 0),
    sha256                   CHAR(64),
    crc32c                   TEXT,
    generation               TEXT,
    decision                 TEXT        NOT NULL CHECK (decision IN ('ingest', 'skip-junk', 'skip-duplicate', 'skip-filter')),
    rule                     TEXT,
    rule_version             INT,
    reason                   TEXT,
    duplicate_of_path        TEXT,
    duplicate_of_decision_id UUID        REFERENCES ingest_decisions(id),
    duplicate_of_source_id   UUID        REFERENCES sources(id),
    filter                   JSONB,
    supersedes               UUID        REFERENCES ingest_decisions(id),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by               UUID        REFERENCES users(id) ON DELETE SET NULL,
    -- A skip always names its rule and rule version; a plain ingest names none; a re-include is 'reinclude'.
    CHECK (decision = 'ingest' OR (rule IS NOT NULL AND rule_version IS NOT NULL)),
    CHECK (decision <> 'ingest' OR rule IS NULL OR rule = 'reinclude'),
    -- A re-include (stage 'include') always supersedes a skip; the ingest stage may supersede a
    -- triage 'ingest' it overturns (a copy of something the same run ingested inside a zip first).
    CHECK ((stage = 'include') = (rule IS NOT DISTINCT FROM 'reinclude')),
    CHECK (stage <> 'include' OR supersedes IS NOT NULL),
    CHECK (stage <> 'triage' OR supersedes IS NULL),
    -- A duplicate names what it duplicates; a filtered object names the filter that caught it.
    CHECK (decision <> 'skip-duplicate' OR duplicate_of_path IS NOT NULL),
    CHECK (decision <> 'skip-filter' OR filter IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_ingest_decisions_tenant_run ON ingest_decisions (tenant_id, run_id, seq);
CREATE INDEX IF NOT EXISTS idx_ingest_decisions_tenant_investigation_path ON ingest_decisions (tenant_id, investigation_id, path);
CREATE INDEX IF NOT EXISTS idx_ingest_decisions_supersedes ON ingest_decisions (supersedes) WHERE supersedes IS NOT NULL;

-- 3. Near-duplicates (answer 4): a table, not a column. One row per parsed document: its MinHash
--    signature (256 x 32-bit values, so a later run compares against it without re-reading any
--    text) and, when it is at least 0.9 similar to the first document of a group, that document's
--    source. Both documents stay indexed; nothing about either one's sources row changes.
--    Not near_duplicate_clusters (0012): that is a pair table holding the REST upload's
--    filename-based demo pairs (DEV-035), read by the diff route.
CREATE TABLE IF NOT EXISTS document_fingerprints (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id    UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    run_id              UUID        NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    source_id           UUID        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    content_document_id UUID        NOT NULL REFERENCES content_documents(id) ON DELETE CASCADE,
    method              TEXT        NOT NULL,
    rule_version        INT         NOT NULL,
    shingle_count       INT         NOT NULL CHECK (shingle_count > 0),
    signature           BYTEA       NOT NULL CHECK (octet_length(signature) = 1024),
    near_duplicate_of   UUID        REFERENCES sources(id),
    similarity          NUMERIC(5, 4),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((near_duplicate_of IS NULL) = (similarity IS NULL)),
    CHECK (near_duplicate_of IS DISTINCT FROM source_id),
    CHECK (similarity IS NULL OR (similarity >= 0.9 AND similarity <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_fingerprints_doc ON document_fingerprints (tenant_id, content_document_id);
CREATE INDEX IF NOT EXISTS idx_document_fingerprints_tenant_investigation ON document_fingerprints (tenant_id, investigation_id);
CREATE INDEX IF NOT EXISTS idx_document_fingerprints_group ON document_fingerprints (tenant_id, near_duplicate_of) WHERE near_duplicate_of IS NOT NULL;

-- Row level security, like every tenant table (I7, D26), with the guardrail's policy name.
ALTER TABLE ingest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE ingest_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE document_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fingerprints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ingest_runs;
CREATE POLICY tenant_isolation ON ingest_runs
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON ingest_decisions;
CREATE POLICY tenant_isolation ON ingest_decisions
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON document_fingerprints;
CREATE POLICY tenant_isolation ON document_fingerprints
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Decisions and fingerprints are append-only for the application: no UPDATE, no DELETE. A run's
-- row is updated as it goes (triaged_at, finished_at, counters) and never deleted.
REVOKE ALL ON ingest_runs FROM casefile_app;
REVOKE ALL ON ingest_decisions FROM casefile_app;
REVOKE ALL ON document_fingerprints FROM casefile_app;
GRANT SELECT, INSERT, UPDATE ON ingest_runs TO casefile_app;
GRANT SELECT, INSERT ON ingest_decisions TO casefile_app;
GRANT SELECT, INSERT ON document_fingerprints TO casefile_app;

COMMENT ON TABLE ingest_decisions IS
    'BIGDATA-3 (migration 0029): one triage decision per object seen; append-only; a re-include supersedes, never changes, a decision.';
COMMENT ON TABLE document_fingerprints IS
    'BIGDATA-3 (migration 0029): MinHash signature per parsed document; near_duplicate_of = the first document of its group (similarity >= 0.9). Both stay indexed.';
