-- 0024_revoke_public_create.sql
-- Invariant I7: Application roles cannot create tables in public schema.
-- Remediates accidental GRANT CREATE ON SCHEMA public in 0001_extensions.sql.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  rec RECORD;
BEGIN
  -- Dynamically revoke CREATE on schema public from all application and non-privileged roles
  FOR rec IN
    SELECT rolname FROM pg_roles
    WHERE rolname NOT IN (SELECT rolname FROM pg_roles WHERE rolsuper OR rolbypassrls)
      AND rolname NOT IN ('postgres', 'casefile', current_user)
      AND rolname NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', rec.rolname);
  END LOOP;
END
$$;
