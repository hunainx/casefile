-- 0022_audit_immutability.sql
-- Enforce Invariant I8: Audit log immutability and tail-truncation protection.
-- Explicitly revoke UPDATE, DELETE, and TRUNCATE privileges from application roles on audit_events and audit_chain_heads.
-- This remedies the accidental inheritance of table privileges caused by ALTER DEFAULT PRIVILEGES in 0001_extensions.sql and deploy scripts.

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'casefile_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_events FROM casefile_app;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_chain_heads FROM casefile_app;
    GRANT SELECT, INSERT ON audit_events TO casefile_app;
    GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO casefile_app;
  END IF;
END
$$;
