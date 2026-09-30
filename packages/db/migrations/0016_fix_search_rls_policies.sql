-- Migration 0016: Fix Search and Memory RLS Policies to use app.tenant_id with WITH CHECK

DROP POLICY IF EXISTS search_history_tenant_isolation ON search_history;
DROP POLICY IF EXISTS tenant_isolation ON search_history;
CREATE POLICY tenant_isolation ON search_history
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS saved_searches_tenant_isolation ON saved_searches;
DROP POLICY IF EXISTS tenant_isolation ON saved_searches;
CREATE POLICY tenant_isolation ON saved_searches
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS search_monitors_tenant_isolation ON search_monitors;
DROP POLICY IF EXISTS tenant_isolation ON search_monitors;
CREATE POLICY tenant_isolation ON search_monitors
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS search_relevance_feedback_tenant_isolation ON search_relevance_feedback;
DROP POLICY IF EXISTS tenant_isolation ON search_relevance_feedback;
CREATE POLICY tenant_isolation ON search_relevance_feedback
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS context_manifests_tenant_isolation ON context_manifests;
DROP POLICY IF EXISTS tenant_isolation ON context_manifests;
CREATE POLICY tenant_isolation ON context_manifests
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS investigation_memory_snapshots_tenant_isolation ON investigation_memory_snapshots;
DROP POLICY IF EXISTS tenant_isolation ON investigation_memory_snapshots;
CREATE POLICY tenant_isolation ON investigation_memory_snapshots
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
