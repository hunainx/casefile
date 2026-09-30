-- 0005_org_tenant_root.sql
-- Enforce organization tenant root invariant (organizations.tenant_id must equal organizations.id)

ALTER TABLE organizations
  ADD CONSTRAINT organizations_tenant_is_self CHECK (tenant_id = id);
