-- 0031_ingest_work_queue.sql
-- Big-data engine, BIGDATA-4 (plan section 16; answers 9 and 10): many workers, one queue, resume.
--
-- The queue is a table in the matter's own database (answer 9): no Redis, no outside service.
-- Workers take items with a lease; the copy that comes first in the run's reading order is kept,
-- whatever the number of workers (the sequencer decides in that order, the workers write in
-- parallel); the near-duplicate index moves out of the worker's memory into the database.
--
-- Additive only: five new tables, two new columns on ingest_runs (nullable / with a default), and
-- one index on document_fingerprints. No existing column, constraint or row is changed.

-- 1. The run: when its queue was complete, and the settings every worker of it must use
--    (parse size limit, zip limits, mailbox part sizes), so two workers never split a mailbox differently.
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. The workers (one row per worker process): heartbeat and what it is doing, for ingest:status.
CREATE TABLE IF NOT EXISTS ingest_workers (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    run_id           UUID        NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    host             TEXT,
    pid              INT,
    state            TEXT        NOT NULL DEFAULT 'starting'
                     CHECK (state IN ('starting', 'idle', 'discovering', 'waiting', 'writing', 'indexing', 'stopped')),
    activity         TEXT,
    current_work_id  UUID,
    items_done       INT         NOT NULL DEFAULT 0,
    rss_mb           INT,
    stats            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stopped_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ingest_workers_tenant_run ON ingest_workers (tenant_id, run_id);

-- 3. The queue: one item per top-level object to ingest, per mailbox (its head), per part of a
--    mailbox and per mailbox finish, at its place in reading order (top_seq, part_no).
CREATE TABLE IF NOT EXISTS ingest_work (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    run_id           UUID        NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    top_seq          INT         NOT NULL CHECK (top_seq >= 0),
    part_no          INT         NOT NULL DEFAULT 0 CHECK (part_no >= 0),
    kind             TEXT        NOT NULL CHECK (kind IN ('file', 'mailbox', 'mailbox-part', 'mailbox-finish')),
    decision_id      UUID        REFERENCES ingest_decisions(id),
    path             TEXT        NOT NULL,
    file_name        TEXT        NOT NULL,
    object_key       TEXT,
    byte_size        BIGINT      NOT NULL CHECK (byte_size >= 0),
    sha256           CHAR(64),
    mailbox_format   TEXT        CHECK (mailbox_format IS NULL OR mailbox_format IN ('pst', 'ost', 'mbox')),
    spec             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    state            TEXT        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'discovered', 'sequenced', 'done', 'failed')),
    decide_version   INT         NOT NULL DEFAULT 0,
    entries          INT,
    progress         INT         NOT NULL DEFAULT 0 CHECK (progress >= 0),
    lease_token      UUID,
    leased_by        UUID        REFERENCES ingest_workers(id),
    lease_expires_at TIMESTAMPTZ,
    attempts         INT         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts     INT         NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    last_error       TEXT,
    errors           JSONB       NOT NULL DEFAULT '[]'::jsonb,
    result           JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    discovered_at    TIMESTAMPTZ,
    sequenced_at     TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, top_seq, part_no),
    CHECK ((lease_token IS NULL) = (leased_by IS NULL)),
    CHECK (state <> 'failed' OR last_error IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ingest_work_tenant_run_state ON ingest_work (tenant_id, run_id, state, top_seq, part_no);
-- Items not finished yet, in reading order: the claim, the sequencer and the near-duplicate pass read the
-- first of them without sorting every open item of the run (the queries use this exact state list).
CREATE INDEX IF NOT EXISTS idx_ingest_work_open ON ingest_work (tenant_id, run_id, top_seq, part_no)
  WHERE state IN ('pending', 'discovered', 'sequenced');

-- 4. What discovery found in each item (the object, each zip entry, attachment and mailbox message,
--    in pre-order) and what the sequencer decided for it. A kept node gets its source id here.
CREATE TABLE IF NOT EXISTS ingest_nodes (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id       UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    run_id                 UUID        NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    work_id                UUID        NOT NULL REFERENCES ingest_work(id) ON DELETE CASCADE,
    node_index             INT         NOT NULL CHECK (node_index >= 0),
    parent_index           INT,
    entry_index            INT         NOT NULL DEFAULT 0,
    depth                  INT         NOT NULL DEFAULT 0,
    path                   TEXT        NOT NULL,
    file_name              TEXT        NOT NULL,
    byte_size              BIGINT      NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
    sha256                 CHAR(64),
    message_hash           CHAR(64),
    kind                   TEXT        NOT NULL CHECK (kind IN ('file', 'message', 'error')),
    -- A container's children are its zip entries or email attachments; an email keeps going when one of
    -- them fails to be written (a zip bomb), a zip does not (the ingest's own rule, unchanged).
    container              TEXT        CHECK (container IS NULL OR container IN ('zip', 'email')),
    local                  JSONB,
    decision               TEXT        CHECK (decision IS NULL OR decision IN ('ingest', 'link', 'skip-duplicate', 'skip-junk', 'skip-filter', 'not-reached', 'error', 'void')),
    duplicate_rule         TEXT,
    duplicate_of_path      TEXT,
    duplicate_of_source_id UUID,
    source_id              UUID,
    decided_at             TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (work_id, node_index)
);
-- The race backstop: at most one kept copy of the same bytes, and of the same message, per run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingest_nodes_kept_sha256 ON ingest_nodes (run_id, sha256)
    WHERE decision IN ('ingest', 'link') AND sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingest_nodes_kept_message ON ingest_nodes (run_id, message_hash)
    WHERE decision = 'ingest' AND message_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ingest_nodes_tenant_run ON ingest_nodes (tenant_id, run_id);

-- 5. Near-duplicates (D101 unchanged, answer 4): the signatures of written documents waiting for
--    the ordered near-duplicate pass, and the index itself (32 LSH band keys per document in one
--    bigint[], band number in the high bits), in the database instead of each worker's memory.
CREATE TABLE IF NOT EXISTS ingest_signatures (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id    UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    run_id              UUID        NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    top_seq             INT         NOT NULL,
    part_no             INT         NOT NULL,
    node_index          INT         NOT NULL,
    entry_index         INT         NOT NULL DEFAULT 0,
    source_id           UUID        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    content_document_id UUID        NOT NULL REFERENCES content_documents(id) ON DELETE CASCADE,
    shingle_count       INT         NOT NULL CHECK (shingle_count > 0),
    signature           BYTEA       NOT NULL CHECK (octet_length(signature) = 1024),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_document_id)
);
CREATE INDEX IF NOT EXISTS idx_ingest_signatures_order ON ingest_signatures (tenant_id, run_id, top_seq, part_no, entry_index, node_index);

CREATE TABLE IF NOT EXISTS document_lsh (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_seq           BIGINT      GENERATED ALWAYS AS IDENTITY,
    tenant_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id    UUID        NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    source_id           UUID        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    content_document_id UUID        NOT NULL REFERENCES content_documents(id) ON DELETE CASCADE,
    root_source_id      UUID        NOT NULL REFERENCES sources(id),
    bands               BIGINT[]    NOT NULL CHECK (cardinality(bands) = 32),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_document_id)
);
CREATE INDEX IF NOT EXISTS idx_document_lsh_tenant_investigation ON document_lsh (tenant_id, investigation_id);

-- The lookup side of the index: which groups (their first documents) have a band key. One row per band key and
-- group, not per document: the documents of one group that share a key share its row. Looked up with
-- `band_key = ANY(keys)` on the primary key. Not a GIN index on document_lsh.bands: under row-level security
-- Postgres uses an index only for leakproof operators, and the array operators (&&, @>) are not, so such an index
-- is never used by the app role (every lookup read the whole table; measured, plan section 16). bigint and uuid
-- equality are leakproof. The rows are derived from document_lsh (written in the same transaction), which holds
-- the key to sources; this table has none so that its 32 rows a document cost no key checks.
CREATE TABLE IF NOT EXISTS document_lsh_bands (
    tenant_id        UUID   NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    investigation_id UUID   NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    band_key         BIGINT NOT NULL,
    root_source_id   UUID   NOT NULL,
    PRIMARY KEY (tenant_id, investigation_id, band_key, root_source_id)
);
CREATE INDEX IF NOT EXISTS idx_document_fingerprints_tenant_source ON document_fingerprints (tenant_id, source_id);

-- Row level security, like every tenant table (I7, D26), with the guardrail's policy name.
ALTER TABLE ingest_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_workers FORCE ROW LEVEL SECURITY;
ALTER TABLE ingest_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_work FORCE ROW LEVEL SECURITY;
ALTER TABLE ingest_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE ingest_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_signatures FORCE ROW LEVEL SECURITY;
ALTER TABLE document_lsh ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_lsh FORCE ROW LEVEL SECURITY;
ALTER TABLE document_lsh_bands ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_lsh_bands FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ingest_workers;
CREATE POLICY tenant_isolation ON ingest_workers
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON ingest_work;
CREATE POLICY tenant_isolation ON ingest_work
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON ingest_nodes;
CREATE POLICY tenant_isolation ON ingest_nodes
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON ingest_signatures;
CREATE POLICY tenant_isolation ON ingest_signatures
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON document_lsh;
CREATE POLICY tenant_isolation ON document_lsh
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON document_lsh_bands;
CREATE POLICY tenant_isolation ON document_lsh_bands
    USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The queue tables change as a run goes (leases, states, decisions): SELECT, INSERT, UPDATE, never
-- DELETE. The near-duplicate tables are append-only for the application, like document_fingerprints.
REVOKE ALL ON ingest_workers FROM casefile_app;
REVOKE ALL ON ingest_work FROM casefile_app;
REVOKE ALL ON ingest_nodes FROM casefile_app;
REVOKE ALL ON ingest_signatures FROM casefile_app;
REVOKE ALL ON document_lsh FROM casefile_app;
REVOKE ALL ON document_lsh_bands FROM casefile_app;
GRANT SELECT, INSERT, UPDATE ON ingest_workers TO casefile_app;
GRANT SELECT, INSERT, UPDATE ON ingest_work TO casefile_app;
GRANT SELECT, INSERT, UPDATE ON ingest_nodes TO casefile_app;
GRANT SELECT, INSERT ON ingest_signatures TO casefile_app;
GRANT SELECT, INSERT ON document_lsh TO casefile_app;
GRANT SELECT, INSERT ON document_lsh_bands TO casefile_app;

COMMENT ON TABLE ingest_work IS
    'BIGDATA-4 (migration 0031): the run''s work queue; items leased with FOR UPDATE SKIP LOCKED; unique per run and place in reading order.';
COMMENT ON TABLE ingest_nodes IS
    'BIGDATA-4 (migration 0031): what each item holds and what the sequencer decided, in reading order; one kept copy per SHA-256 / message per run.';
COMMENT ON TABLE document_lsh IS
    'BIGDATA-4 (migration 0031): the near-duplicate LSH index in the database, one row per document (its 32 band keys and its group); append-only.';
COMMENT ON TABLE document_lsh_bands IS
    'BIGDATA-4 (migration 0031): the LSH lookup, one row per band key and group (derived from document_lsh); append-only.';
