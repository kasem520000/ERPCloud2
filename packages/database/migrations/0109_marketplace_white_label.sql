-- Future enhancement 13 — marketplace catalog and white-label domains.
-- 0107 is the supplier portal and 0108 is personal dashboards, so this is 0109.
-- An app is a reviewed catalog row. Installing it sets a flag; it does not load code.
-- A custom domain is proven with a TXT record. TLS stays manual.

CREATE TABLE IF NOT EXISTS marketplace_apps (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  name_ar text NOT NULL,
  name_en text NOT NULL DEFAULT '',
  description_ar text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '',
  version text NOT NULL DEFAULT '1.0.0',
  price_monthly numeric(12, 4) NOT NULL DEFAULT 0,
  is_core boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  screens jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_apps_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT marketplace_apps_price_check CHECK (price_monthly >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_apps_code_key ON marketplace_apps (code);

CREATE TABLE IF NOT EXISTS tenant_apps (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_code text NOT NULL REFERENCES marketplace_apps(code),
  is_enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_apps_tenant_code_key ON tenant_apps (tenant_id, app_code);
CREATE INDEX IF NOT EXISTS tenant_apps_tenant_idx ON tenant_apps (tenant_id);

CREATE TABLE IF NOT EXISTS tenant_domains (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  ssl_status text NOT NULL DEFAULT 'manual',
  verification_token text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT tenant_domains_status_check CHECK (status IN ('pending', 'active', 'failed')),
  CONSTRAINT tenant_domains_ssl_check CHECK (ssl_status IN ('manual', 'pending', 'active'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_domain_key ON tenant_domains (domain) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tenant_domains_tenant_idx ON tenant_domains (tenant_id);

CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  logo_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  primary_color text NOT NULL DEFAULT '',
  secondary_color text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Catalog is readable by every tenant session. Writes require the platform plane.
ALTER TABLE marketplace_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_apps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_apps_read ON marketplace_apps;
CREATE POLICY marketplace_apps_read ON marketplace_apps
  FOR SELECT USING (true);
DROP POLICY IF EXISTS marketplace_apps_insert ON marketplace_apps;
CREATE POLICY marketplace_apps_insert ON marketplace_apps
  FOR INSERT WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');
DROP POLICY IF EXISTS marketplace_apps_update ON marketplace_apps;
CREATE POLICY marketplace_apps_update ON marketplace_apps
  FOR UPDATE
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');
DROP POLICY IF EXISTS marketplace_apps_delete ON marketplace_apps;
CREATE POLICY marketplace_apps_delete ON marketplace_apps
  FOR DELETE USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

ALTER TABLE tenant_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_apps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_apps;
CREATE POLICY tenant_isolation ON tenant_apps
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_domains;
CREATE POLICY tenant_isolation ON tenant_domains
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Public host lookup sets app.lookup_host and reads that one active domain. An unset
-- GUC matches nothing, so a tenant session cannot list other customers' domains.
DROP POLICY IF EXISTS tenant_domains_host_lookup ON tenant_domains;
CREATE POLICY tenant_domains_host_lookup ON tenant_domains
  FOR SELECT USING (
    status = 'active'
    AND deleted_at IS NULL
    AND domain = lower(nullif(current_setting('app.lookup_host', true), ''))
  );

ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_branding;
CREATE POLICY tenant_isolation ON tenant_branding
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_branding_host_lookup ON tenant_branding;
CREATE POLICY tenant_branding_host_lookup ON tenant_branding
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM tenant_domains AS d
      WHERE d.tenant_id = tenant_branding.tenant_id
        AND d.status = 'active'
        AND d.deleted_at IS NULL
        AND d.domain = lower(nullif(current_setting('app.lookup_host', true), ''))
    )
  );

GRANT SELECT, INSERT, UPDATE ON marketplace_apps TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_apps, tenant_domains, tenant_branding TO erp_api;
GRANT ALL PRIVILEGES ON marketplace_apps, tenant_apps, tenant_domains, tenant_branding TO erp_migrator;

INSERT INTO marketplace_apps (
  id, code, name_ar, name_en, description_ar, icon, version, price_monthly, is_core, is_active, screens
) VALUES
  ('01990013-0000-7000-8000-000000000001', 'salla', 'سلة', 'Salla', 'استيراد طلبات سلة إلى فواتير المبيعات.', '🛒', '1.0.0', 49, false, true, '["/settings/ecommerce","/sales/ecommerce-orders"]'::jsonb),
  ('01990013-0000-7000-8000-000000000002', 'zid', 'زد', 'Zid', 'استيراد طلبات زد إلى فواتير المبيعات.', '🛍️', '1.0.0', 49, false, true, '["/settings/ecommerce","/sales/ecommerce-orders"]'::jsonb),
  ('01990013-0000-7000-8000-000000000003', 'shopify', 'شوبيفاي', 'Shopify', 'استيراد طلبات شوبيفاي إلى فواتير المبيعات.', '🏪', '1.0.0', 49, false, true, '["/settings/ecommerce","/sales/ecommerce-orders"]'::jsonb),
  ('01990013-0000-7000-8000-000000000004', 'moyasar', 'ميسر', 'Moyasar', 'روابط دفع ميسر على فواتير المبيعات.', '💳', '1.0.0', 29, false, true, '[]'::jsonb),
  ('01990013-0000-7000-8000-000000000005', 'ocr', 'مسح الفواتير', 'OCR', 'قراءة فاتورة الشراء. مشحونة مع النظام ولا تُخفى.', '📄', '1.0.0', 0, true, true, '[]'::jsonb),
  ('01990013-0000-7000-8000-000000000006', 'esign', 'توقيع مرسوم', 'E-sign', 'توقيع مرسوم مع رمز لمرة واحدة. مشحون مع النظام.', '✍️', '1.0.0', 0, true, true, '[]'::jsonb),
  ('01990013-0000-7000-8000-000000000007', 'wms', 'المستودعات', 'WMS', 'الرفوف والتصنيع الخفيف. مشحونان مع النظام.', '📦', '1.0.0', 0, true, true, '[]'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, module, description) VALUES
  ('tenant.apps.manage', 'tenant', 'Install and remove marketplace apps and manage the tenant domain and brand.'),
  ('console.marketplace.manage', 'console', 'Price and activate reviewed marketplace apps. Third-party code is not accepted.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT rp.role_id, 'tenant.apps.manage'
FROM role_permissions rp
WHERE rp.permission_code = 'tenant.settings.manage'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE marketplace_apps IS
  'FE-13: reviewed add-on catalog. Tenants may read it; only the platform plane may write it.';
COMMENT ON TABLE tenant_apps IS
  'FE-13: per-tenant install flag. Disabling keeps settings and does not delete store data.';
COMMENT ON TABLE tenant_domains IS
  'FE-13: custom host proven by TXT. ssl_status stays manual; this migration does not issue certificates.';
COMMENT ON TABLE tenant_branding IS
  'FE-13: one logo and two colors per tenant, printed on invoices.';

ALTER ROLE erp_api NOBYPASSRLS;
