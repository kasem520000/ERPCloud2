-- Future enhancement 14 — sales pipeline, activities and WhatsApp replies.
-- 0108 is dashboards and 0109 is the marketplace, so this is 0110.
-- Forecast math stays in the application. These tables only store the deal and the trail.

CREATE TABLE IF NOT EXISTS crm_pipelines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  stages jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_pipelines_name_check CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS crm_pipelines_tenant_idx ON crm_pipelines (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS crm_pipelines_default_key ON crm_pipelines (tenant_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS crm_deals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  stage_id text NOT NULL,
  party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
  title text NOT NULL,
  amount numeric(20, 4) NOT NULL DEFAULT 0,
  probability integer NOT NULL DEFAULT 0,
  expected_close date,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open',
  lost_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_deals_title_check CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT crm_deals_probability_check CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT crm_deals_amount_check CHECK (amount >= 0),
  CONSTRAINT crm_deals_status_check CHECK (status IN ('open', 'won', 'lost'))
);

CREATE INDEX IF NOT EXISTS crm_deals_board_idx ON crm_deals (tenant_id, pipeline_id, stage_id);

CREATE TABLE IF NOT EXISTS crm_activities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  party_id uuid,
  type text NOT NULL,
  subject text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  direction text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT crm_activities_type_check CHECK (type IN ('call', 'meeting', 'whatsapp', 'email', 'note'))
);

CREATE INDEX IF NOT EXISTS crm_activities_deal_idx ON crm_activities (tenant_id, deal_id, at);

CREATE TABLE IF NOT EXISTS crm_whatsapp_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  body text NOT NULL,
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_whatsapp_templates_name_key ON crm_whatsapp_templates (tenant_id, name);

CREATE TABLE IF NOT EXISTS crm_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_settings_webhook_token_key ON crm_settings (webhook_token);

ALTER TABLE crm_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipelines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_pipelines;
CREATE POLICY tenant_isolation ON crm_pipelines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_deals;
CREATE POLICY tenant_isolation ON crm_deals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_activities;
CREATE POLICY tenant_isolation ON crm_activities
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm_whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_whatsapp_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_whatsapp_templates;
CREATE POLICY tenant_isolation ON crm_whatsapp_templates
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON crm_settings;
CREATE POLICY tenant_isolation ON crm_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- A public reply can read only the settings row whose token was set for this transaction.
DROP POLICY IF EXISTS crm_settings_webhook ON crm_settings;
CREATE POLICY crm_settings_webhook ON crm_settings
  FOR SELECT USING (webhook_token = nullif(current_setting('app.lookup_webhook', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_pipelines, crm_deals, crm_activities, crm_whatsapp_templates, crm_settings TO erp_api;
GRANT ALL PRIVILEGES ON crm_pipelines, crm_deals, crm_activities, crm_whatsapp_templates, crm_settings TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('crm.deals.view', 'crm', 'Read sales pipelines, deals, activities and the forecast.'),
  ('crm.deals.manage', 'crm', 'Create pipelines and deals, and move or close a deal.'),
  ('crm.activities.manage', 'crm', 'Log a call, a note or a WhatsApp message on a deal.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT rp.role_id, code
FROM role_permissions rp
CROSS JOIN (VALUES ('crm.deals.view'), ('crm.activities.manage')) AS granted(code)
WHERE rp.permission_code = 'sales.view'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT rp.role_id, 'crm.deals.manage'
FROM role_permissions rp
WHERE rp.permission_code = 'sales.offer.manage'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE crm_deals IS
  'FE-14: an open deal stays on a stage. Won and lost deals leave the forecast.';
COMMENT ON TABLE crm_activities IS
  'FE-14: calls, notes and WhatsApp, including an inbound reply. No email open tracking.';

ALTER ROLE erp_api NOBYPASSRLS;
