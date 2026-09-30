-- 0028_text_stored_once.sql
-- Big-data engine, BIGDATA-2B (D94; docs/PLAN-BIG-DATA.md section 12): text is stored once.
--
-- content_blocks.text is the one copy of a document's text; evidence, span hashes and citations
-- point at it (invariants I1, I4, I9). From this version on:
--   - a chunk that is exactly one block, with that block's text and offsets, is written with
--     chunks.text NULL; readers take COALESCE(chunks.text, <that block's text>);
--   - content_documents.full_text (already nullable) is written NULL when the blocks give it
--     back exactly (apps/api/src/services/document-text.ts), and stored as before otherwise.
--
-- Additive and non-destructive: no column is dropped and no row is changed. Rows written before
-- this migration keep their text in all three places and read exactly as before. The CHECK is
-- NOT VALID, so existing rows are not rescanned (they all have text, so they would pass); it
-- holds for every row written from now on.
ALTER TABLE chunks ALTER COLUMN text DROP NOT NULL;

ALTER TABLE chunks ADD CONSTRAINT chunks_text_or_one_block
    CHECK (text IS NOT NULL OR cardinality(block_ids) = 1) NOT VALID;

COMMENT ON COLUMN chunks.text IS
    'NULL (BIGDATA-2B, migration 0028): the chunk is its one block, whose content_blocks.text is the text.';
COMMENT ON COLUMN content_documents.full_text IS
    'NULL (BIGDATA-2B, migration 0028): the blocks give the text back exactly (document-text.ts rebuildDocumentText).';
