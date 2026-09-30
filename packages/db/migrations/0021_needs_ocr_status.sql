-- Migration: 0021_needs_ocr_status.sql
-- Epic: E3 Ingestion & Sources (PRD §10.2 "Unparseable is not unusable")
-- Adds 'needs_ocr' status for admitted documents (e.g. scanned PDFs) requiring OCR processing.

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_status_check;
ALTER TABLE sources ADD CONSTRAINT sources_status_check
    CHECK (status IN (
        'received', 'scanning', 'quarantined', 'admitted', 'linked',
        'processing', 'unprocessable', 'stored_unparsed', 'needs_ocr', 'indexed', 'withdrawn', 'purged', 'held'
    ));
