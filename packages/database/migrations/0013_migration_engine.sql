CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_label text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('analyze','dry_run','import','reconcile','rollback')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','rolled_back')),
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS migration_runs_tenant_started_idx ON migration_runs(tenant_id, started_at);
CREATE INDEX IF NOT EXISTS migration_runs_tenant_status_idx ON migration_runs(tenant_id, status);

CREATE TABLE IF NOT EXISTS legacy_id_mappings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity text NOT NULL,
  legacy_source text NOT NULL,
  legacy_pk text NOT NULL,
  new_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity, legacy_source, legacy_pk)
);
CREATE INDEX IF NOT EXISTS legacy_id_mappings_run_idx ON legacy_id_mappings(tenant_id, run_id);
CREATE INDEX IF NOT EXISTS legacy_id_mappings_new_id_idx ON legacy_id_mappings(tenant_id, entity, new_id);

CREATE TABLE IF NOT EXISTS migration_issues (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  entity text NOT NULL,
  legacy_pk text,
  severity text NOT NULL CHECK (severity IN ('info','warn','error','block')),
  code text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS migration_issues_run_idx ON migration_issues(tenant_id, run_id, severity);
CREATE INDEX IF NOT EXISTS migration_issues_code_idx ON migration_issues(tenant_id, code);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['migration_runs','legacy_id_mappings','migration_issues'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
  END LOOP;
END $$;
