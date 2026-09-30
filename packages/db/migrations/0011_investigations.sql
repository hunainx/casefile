-- 0011_investigations.sql
-- Epic E2: Core Investigation schema, membership, questions, templates, notes, and tasks.

-- 1. Investigations Table (PRD §8.1, §9.3, §59.2)
CREATE TABLE IF NOT EXISTS investigations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'draft' CHECK (
    stage IN (
      'draft', 'defining', 'collecting', 'processing', 'exploring',
      'connecting', 'analyzing', 'challenging', 'validating',
      'concluding', 'reporting', 'reviewing', 'archived', 'suspended'
    )
  ),
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (
    sensitivity IN ('internal', 'confidential', 'restricted')
  ),
  retention_class TEXT NOT NULL DEFAULT 'standard',
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  objective TEXT,
  legitimacy_declaration JSONB,
  scope JSONB NOT NULL DEFAULT '{"subjects": [], "temporal_bounds": {"from": null, "to": null}, "jurisdictions": [], "inclusions": [], "exclusions": [], "data_categories_permitted": []}',
  suspension_reason TEXT,
  reopen_justification TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_investigations_tenant ON investigations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_investigations_workspace ON investigations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_investigations_stage ON investigations(stage);

ALTER TABLE investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON investigations
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON investigations TO casefile_app;

-- 2. Investigation Members Table (PRD §8.1, §38.2, §59.2)
CREATE TABLE IF NOT EXISTS investigation_members (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (
    role IN ('lead_investigator', 'investigator', 'reviewer', 'auditor', 'viewer')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT uq_investigation_members_inv_user UNIQUE (investigation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_investigation_members_tenant ON investigation_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_investigation_members_inv ON investigation_members(investigation_id);
CREATE INDEX IF NOT EXISTS idx_investigation_members_user ON investigation_members(user_id);

ALTER TABLE investigation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON investigation_members
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON investigation_members TO casefile_app;

-- 3. Investigation Questions Table — The Spine (PRD §8.2, §59.2)
CREATE TABLE IF NOT EXISTS investigation_questions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  sequence INT NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  parent_question_id UUID REFERENCES investigation_questions(id) ON DELETE CASCADE,
  materiality TEXT NOT NULL DEFAULT 'important' CHECK (
    materiality IN ('critical', 'important', 'supporting')
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'partially_answered', 'answered', 'unanswerable')
  ),
  unanswerable_rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_investigation_questions_tenant ON investigation_questions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_investigation_questions_inv ON investigation_questions(investigation_id);
CREATE INDEX IF NOT EXISTS idx_investigation_questions_parent ON investigation_questions(parent_question_id);

ALTER TABLE investigation_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_questions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON investigation_questions
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON investigation_questions TO casefile_app;

-- 4. Investigation Templates Table (PRD §8.7, §59.2)
CREATE TABLE IF NOT EXISTS investigation_templates (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  questions JSONB NOT NULL DEFAULT '[]',
  scope_defaults JSONB NOT NULL DEFAULT '{}',
  expected_source_types JSONB NOT NULL DEFAULT '[]',
  collection_checklist JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_investigation_templates_tenant ON investigation_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_investigation_templates_ws ON investigation_templates(workspace_id);

ALTER TABLE investigation_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON investigation_templates
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON investigation_templates TO casefile_app;

-- 5. Notes Table (PRD §8.5)
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (
    target_type IN ('investigation', 'entity', 'evidence', 'relationship', 'hypothesis', 'finding', 'event')
  ),
  target_id UUID NOT NULL,
  content TEXT NOT NULL,
  mentions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notes_inv ON notes(investigation_id);
CREATE INDEX IF NOT EXISTS idx_notes_target ON notes(target_type, target_id);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notes
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO casefile_app;

-- 6. Tasks Table (PRD §8.6)
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (
    status IN ('todo', 'in_progress', 'completed', 'cancelled')
  ),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (
    priority IN ('low', 'medium', 'high', 'urgent')
  ),
  target_type TEXT,
  target_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_inv ON tasks(investigation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tasks
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO casefile_app;
