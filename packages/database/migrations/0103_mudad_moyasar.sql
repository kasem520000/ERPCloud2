-- 0103 — Mudad WPS, GOSI exports, and online payment links (PHASE_07)
--
-- 0101 is already the custom-fields migration, so this phase uses 0103.
-- Direct Mudad submission stays out of scope: the bank CSV is generated, stored,
-- and tracked after a manual upload. Online links are cash-in for sales invoices
-- only — payroll is never paid through Moyasar/HyperPay/Tap here.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS iqama_expires_on date,
  ADD COLUMN IF NOT EXISTS insurance_expires_on date,
  ADD COLUMN IF NOT EXISTS gosi_scheme text;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_gosi_scheme_check;
ALTER TABLE employees
  ADD CONSTRAINT employees_gosi_scheme_check
  CHECK (gosi_scheme IS NULL OR gosi_scheme IN ('old', 'new'));

CREATE INDEX IF NOT EXISTS employees_iqama_expiry_idx
  ON employees (tenant_id, iqama_expires_on)
  WHERE deleted_at IS NULL AND iqama_expires_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_insurance_expiry_idx
  ON employees (tenant_id, insurance_expires_on)
  WHERE deleted_at IS NULL AND insurance_expires_on IS NOT NULL;

CREATE TABLE IF NOT EXISTS payroll_compliance_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  establishment_id text NOT NULL DEFAULT '',
  bank_code text NOT NULL DEFAULT '',
  gosi_establishment_no text NOT NULL DEFAULT '',
  default_cash_location_id uuid REFERENCES cash_locations(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_wps_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  bank_code text NOT NULL,
  establishment_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'generated',
  bank_response text,
  file_name text NOT NULL,
  csv_text text NOT NULL,
  employee_count integer NOT NULL,
  total_net numeric(20, 4) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_wps_files_status_check CHECK (status IN ('generated', 'uploaded', 'accepted', 'rejected')),
  CONSTRAINT payroll_wps_files_count_check CHECK (employee_count > 0)
);

CREATE TABLE IF NOT EXISTS payroll_gosi_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  establishment_no text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'generated',
  file_name text NOT NULL,
  csv_text text NOT NULL,
  employee_count integer NOT NULL,
  total_contribution numeric(20, 4) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_gosi_files_status_check CHECK (status IN ('generated', 'uploaded', 'accepted', 'rejected')),
  CONSTRAINT payroll_gosi_files_count_check CHECK (employee_count > 0)
);

CREATE TABLE IF NOT EXISTS payment_provider_configs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  api_key_enc text,
  webhook_secret_enc text,
  publishable_key text,
  is_active boolean NOT NULL DEFAULT true,
  simulation boolean NOT NULL DEFAULT true,
  currency text NOT NULL DEFAULT 'SAR',
  cash_location_id uuid REFERENCES cash_locations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_configs_provider_check CHECK (provider IN ('moyasar', 'hyperpay', 'tap'))
);

CREATE TABLE IF NOT EXISTS payment_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  provider text NOT NULL,
  amount numeric(20, 4) NOT NULL,
  currency text NOT NULL DEFAULT 'SAR',
  link_url text NOT NULL,
  external_id text,
  status text NOT NULL DEFAULT 'pending',
  paid_at timestamptz,
  voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_links_provider_check CHECK (provider IN ('moyasar', 'hyperpay', 'tap')),
  CONSTRAINT payment_links_status_check CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  CONSTRAINT payment_links_amount_check CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS payroll_wps_files_run_idx
  ON payroll_wps_files (tenant_id, payroll_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_gosi_files_run_idx
  ON payroll_gosi_files (tenant_id, payroll_run_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_configs_tenant_provider_key
  ON payment_provider_configs (tenant_id, provider);
CREATE INDEX IF NOT EXISTS payment_links_invoice_idx
  ON payment_links (tenant_id, invoice_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_external_key
  ON payment_links (tenant_id, provider, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE payroll_compliance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_compliance_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE payroll_wps_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_wps_files FORCE ROW LEVEL SECURITY;
ALTER TABLE payroll_gosi_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_gosi_files FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_provider_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_compliance_settings_tenant_isolation ON payroll_compliance_settings;
CREATE POLICY payroll_compliance_settings_tenant_isolation ON payroll_compliance_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS payroll_wps_files_tenant_isolation ON payroll_wps_files;
CREATE POLICY payroll_wps_files_tenant_isolation ON payroll_wps_files
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS payroll_gosi_files_tenant_isolation ON payroll_gosi_files;
CREATE POLICY payroll_gosi_files_tenant_isolation ON payroll_gosi_files
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS payment_provider_configs_tenant_isolation ON payment_provider_configs;
CREATE POLICY payment_provider_configs_tenant_isolation ON payment_provider_configs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS payment_links_tenant_isolation ON payment_links;
CREATE POLICY payment_links_tenant_isolation ON payment_links
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  payroll_compliance_settings, payroll_wps_files, payroll_gosi_files, payment_provider_configs, payment_links
  TO erp_api;
GRANT ALL PRIVILEGES ON
  payroll_compliance_settings, payroll_wps_files, payroll_gosi_files, payment_provider_configs, payment_links
  TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('payroll.wps.export', 'hrm', 'Preview and export Mudad WPS and GOSI payroll files.'),
  ('payments.links.manage', 'payments', 'Connect online payment providers and manage invoice payment links.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

COMMENT ON TABLE payroll_wps_files IS
  'PHASE_07: generated Mudad/bank WPS CSV and the manual upload status';
COMMENT ON TABLE payment_links IS
  'PHASE_07: Moyasar/HyperPay/Tap invoice links. A paid webhook creates one receipt voucher.';
