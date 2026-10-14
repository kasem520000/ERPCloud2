-- 0028_file_operations_and_report_layouts.sql
-- The file-level operations the desktop product keeps under الإعدادات, plus saved report
-- layouts for مصمم التقارير.
--
-- Every one of these is a **run**, not a setting: a backup, a restore, a rotation and a
-- maintenance sweep are things that happened at a moment in time, to a scope, by a user,
-- with a result. Storing them as rows is what makes the answer to "who deleted the 2023
-- audit log?" a query instead of an argument.
--
-- `backup_runs.payload` holds the snapshot inline. That is a deliberate limit, not an
-- oversight: this is a logical, tenant-scoped export meant to be downloaded and kept, so
-- the service caps the row count and tells the operator to use a physical `pg_dump` for
-- anything larger, rather than quietly producing a backup that cannot be restored.
--
-- `report_layouts` is the whole of the report designer's persistence: which columns a
-- report shows, in what order, under what heading, with which default filters. The
-- report's SQL is never user-authored — a designer that lets users write queries is a
-- data-exfiltration feature wearing a reporting hat.

CREATE TABLE IF NOT EXISTS backup_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'full',
  status text NOT NULL DEFAULT 'ready',
  note text,
  tables jsonb NOT NULL DEFAULT '[]',
  row_counts jsonb NOT NULL DEFAULT '{}',
  total_rows int NOT NULL DEFAULT 0,
  size_bytes bigint NOT NULL DEFAULT 0,
  checksum text NOT NULL DEFAULT '',
  payload jsonb,
  failed_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS backup_runs_tenant_idx ON backup_runs(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS restore_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  backup_id uuid REFERENCES backup_runs(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'dry_run',
  status text NOT NULL DEFAULT 'ready',
  summary jsonb NOT NULL DEFAULT '{}',
  inserted_rows int NOT NULL DEFAULT 0,
  skipped_rows int NOT NULL DEFAULT 0,
  failed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS restore_runs_tenant_idx ON restore_runs(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mode text NOT NULL DEFAULT 'preview',
  status text NOT NULL DEFAULT 'ready',
  cutoff_date date,
  backup_id uuid REFERENCES backup_runs(id) ON DELETE SET NULL,
  findings jsonb NOT NULL DEFAULT '{}',
  applied jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS maintenance_runs_tenant_idx ON maintenance_runs(tenant_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS company_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  new_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  copied jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS company_files_tenant_idx ON company_files(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_layouts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_key text NOT NULL,
  name text NOT NULL,
  title_ar text,
  columns jsonb NOT NULL DEFAULT '[]',
  filters jsonb NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS report_layouts_tenant_key_name ON report_layouts(tenant_id, report_key, name);

ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backup_runs_tenant_isolation ON backup_runs;
CREATE POLICY backup_runs_tenant_isolation ON backup_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE restore_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS restore_runs_tenant_isolation ON restore_runs;
CREATE POLICY restore_runs_tenant_isolation ON restore_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE maintenance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maintenance_runs_tenant_isolation ON maintenance_runs;
CREATE POLICY maintenance_runs_tenant_isolation ON maintenance_runs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE company_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_files_tenant_isolation ON company_files;
CREATE POLICY company_files_tenant_isolation ON company_files
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE report_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_layouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_layouts_tenant_isolation ON report_layouts;
CREATE POLICY report_layouts_tenant_isolation ON report_layouts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
