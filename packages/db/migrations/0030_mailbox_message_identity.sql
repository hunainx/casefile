-- 0030_mailbox_message_identity.sql
-- Big-data engine, BIGDATA-3B (D111): exact duplicates among messages read out of mailbox files
-- (PST, OST, MBOX).
--
-- Every message of a mailbox becomes its own source, and its metadata carries message_hash, the
-- message's identity (tools/ingest-cli/src/mailbox.ts messageIdentity). Before a message is
-- ingested, the ingest looks for a source of the investigation with the same message_hash; this
-- index keeps that lookup from reading every source of the tenant once per message.
--
-- Additive only: one partial index. No table, column or row is changed.

CREATE INDEX IF NOT EXISTS idx_sources_message_hash
    ON sources (tenant_id, (metadata->>'message_hash'))
    WHERE metadata ? 'message_hash';
