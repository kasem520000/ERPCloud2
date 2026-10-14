-- Future enhancement 12 — personal BI dashboards.
-- 0106 is warehouse bins and 0107 is the supplier portal, so this is 0108.
-- Widget keys come from a fixed catalog. The config column never stores SQL.

CREATE TABLE IF NOT EXISTS dashboards (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboards_name_check CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  widget_key text NOT NULL,
  title_ar text NOT NULL,
  kind text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position_x integer NOT NULL DEFAULT 0,
  position_y integer NOT NULL DEFAULT 0,
  width integer NOT NULL DEFAULT 4,
  height integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_widgets_kind_check CHECK (kind IN ('kpi', 'chart', 'table', 'list')),
  CONSTRAINT dashboard_widgets_bounds_check CHECK (
    position_x >= 0 AND position_y >= 0 AND width BETWEEN 2 AND 12 AND height BETWEEN 2 AND 8
    AND position_x + width <= 12
  )
);

CREATE INDEX IF NOT EXISTS dashboards_owner_idx ON dashboards (tenant_id, owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS dashboards_one_default_per_user
  ON dashboards (tenant_id, owner_user_id)
  WHERE is_default;
CREATE INDEX IF NOT EXISTS dashboard_widgets_board_idx ON dashboard_widgets (tenant_id, dashboard_id);

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dashboards_tenant_isolation ON dashboards;
CREATE POLICY dashboards_tenant_isolation ON dashboards
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS dashboard_widgets_tenant_isolation ON dashboard_widgets;
CREATE POLICY dashboard_widgets_tenant_isolation ON dashboard_widgets
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboards, dashboard_widgets TO erp_api;
GRANT ALL PRIVILEGES ON dashboards, dashboard_widgets TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('dashboards.view', 'dashboards', 'Read personal dashboards and widget figures.'),
  ('dashboards.manage', 'dashboards', 'Create dashboards and arrange widgets.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'dashboards.view'
FROM role_permissions
WHERE permission_code = 'reporting.view'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'dashboards.manage'
FROM role_permissions
WHERE permission_code = 'reporting.view'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE dashboards IS
  'PHASE_12: one personal dashboard per user. Widgets reference a fixed catalog, never raw SQL.';

ALTER ROLE erp_api NOBYPASSRLS;
