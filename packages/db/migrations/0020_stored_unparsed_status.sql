-- Migration: 0020_stored_unparsed_status.sql
-- Epic: E3 Ingestion & Sources (PRD §10.2 "Unparseable is not unusable")
-- Permits status 'stored_unparsed' for admitted but unparseable file formats.

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_status_check;
ALTER TABLE sources ADD CONSTRAINT sources_status_check
    CHECK (status IN (
        'received', 'scanning', 'quarantined', 'admitted', 'linked',
        'processing', 'unprocessable', 'stored_unparsed', 'indexed', 'withdrawn', 'purged', 'held'
    ));
