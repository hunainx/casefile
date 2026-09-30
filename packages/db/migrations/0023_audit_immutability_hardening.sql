-- 0023_audit_immutability_hardening.sql
-- Enforce Invariant I8: Hardened audit log immutability and role-agnostic privilege revocation.
-- 
-- Fixes Defect 1 in 0022: Dynamic role-agnostic revocation.
-- Queries information_schema.role_table_grants to dynamically find every role holding
-- UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER on audit_events or audit_chain_heads,
-- and revokes them regardless of what the application role is named.
-- Excludes only the migration owner (postgres / current_user / table owner) and privileged roles (rolsuper / rolbypassrls).
--
-- Fixes Defect 2 in 0022: Revoke all privileges from anon, authenticated, and PUBLIC.
-- Supabase grants anon and authenticated full table privileges on public-schema tables by
-- default, including TRUNCATE (which is not governed by RLS). This ensures anon,
-- authenticated, and PUBLIC hold zero privileges on audit tables.

DO $$
DECLARE
  rec RECORD;
BEGIN
  -- 1. Defect 1: Role-agnostic revocation on audit_events
  -- Revoke UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER from all non-owner, non-privileged roles.
  -- Privileged roles are identified by property (rolsuper OR rolbypassrls in pg_roles).
  FOR rec IN
    SELECT DISTINCT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'audit_events'
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
      AND grantee NOT IN (SELECT rolname FROM pg_roles WHERE rolsuper OR rolbypassrls)
      AND grantee NOT IN ('postgres', current_user)
      AND grantee NOT IN (
        SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_events'
      )
      AND grantee != 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE %s ON TABLE public.%I FROM %I', rec.privilege_type, rec.table_name, rec.grantee);
  END LOOP;

  -- 2. Defect 1: Role-agnostic revocation on audit_chain_heads
  -- Revoke DELETE, TRUNCATE, REFERENCES, TRIGGER from all non-owner, non-privileged roles.
  FOR rec IN
    SELECT DISTINCT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'audit_chain_heads'
      AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
      AND grantee NOT IN (SELECT rolname FROM pg_roles WHERE rolsuper OR rolbypassrls)
      AND grantee NOT IN ('postgres', current_user)
      AND grantee NOT IN (
        SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_chain_heads'
      )
      AND grantee != 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE %s ON TABLE public.%I FROM %I', rec.privilege_type, rec.table_name, rec.grantee);
  END LOOP;

  -- 3. Defect 2: Revoke ALL on both tables from anon, authenticated, and PUBLIC
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.audit_events, public.audit_chain_heads FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.audit_events, public.audit_chain_heads FROM authenticated';
  END IF;

  REVOKE ALL ON TABLE public.audit_events, public.audit_chain_heads FROM PUBLIC;
END
$$;
