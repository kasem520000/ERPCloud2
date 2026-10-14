CREATE TABLE IF NOT EXISTS compat_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  api_key_hash text NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  cursors jsonb NOT NULL DEFAULT '{}',
  enum_maps jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at timestamptz,
  rate_window_started_at timestamptz,
  rate_window_count text NOT NULL DEFAULT '0',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS compat_devices_tenant_hash_key ON compat_devices(tenant_id, api_key_hash);
CREATE INDEX IF NOT EXISTS compat_devices_branch_idx ON compat_devices(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS compat_devices_status_idx ON compat_devices(tenant_id, status);

ALTER TABLE compat_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE compat_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compat_devices_tenant_isolation ON compat_devices;
CREATE POLICY compat_devices_tenant_isolation ON compat_devices
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
