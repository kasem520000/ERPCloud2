-- 0119_cloud_addons_van_sales_and_support.sql
--
-- 1. `marketplace_addon_requests`: Tenant requests to activate vertical/industry
--    add-on packages from the Marketplace (`manufacturing`, `tailoring`, `optics`,
--    `marina`, `projects`, `employee_app`, `van_sales`, `salla`, `zid`, `shopify`, `moyasar`)
--    with Platform Admin approval workflow.
-- 2. `van_sales_customer_prices`: Customer-specific price tiers (e.g., 6.00, 6.50, 7.00 SAR/kg)
--    and bonus/free-quantity caps per customer & item for Bakery & Van Sales distribution.
-- 3. `van_load_orders`: Daily bakery production batch & van loading orders (`أمر تحميل لمندوب`)
--    with batch code lock to prevent reps from mixing outside 5 SAR bakery stock.
-- 4. `van_sales_documents`: Van sales invoices supporting both ZATCA Tax Invoices (`zatca_tax`)
--    and Non-ZATCA Internal Commercial/Delivery Receipts (`internal_delivery`) with bonus
--    controls and anomaly detection.

CREATE TABLE IF NOT EXISTS marketplace_addon_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note text,
  decision_note text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_addon_requests_tenant_idx
  ON marketplace_addon_requests (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_addon_requests_status_idx
  ON marketplace_addon_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS van_sales_customer_prices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_price numeric(20, 4) NOT NULL CHECK (unit_price >= 0),
  max_bonus_pct numeric(10, 4) NOT NULL DEFAULT 0 CHECK (max_bonus_pct >= 0 AND max_bonus_pct <= 100),
  max_bonus_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (max_bonus_qty >= 0),
  expected_daily_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (expected_daily_qty >= 0),
  prefer_non_zatca boolean NOT NULL DEFAULT false,
  lock_price boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT van_sales_customer_prices_unique UNIQUE (tenant_id, party_id, item_id)
);

CREATE INDEX IF NOT EXISTS van_sales_customer_prices_tenant_idx
  ON van_sales_customer_prices (tenant_id, party_id);

CREATE TABLE IF NOT EXISTS van_load_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  warehouse_id uuid REFERENCES warehouses(id),
  salesman_id uuid NOT NULL REFERENCES salesmen(id),
  number text NOT NULL,
  load_date date NOT NULL DEFAULT CURRENT_DATE,
  batch_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES items(id),
  loaded_qty numeric(20, 4) NOT NULL CHECK (loaded_qty > 0),
  sold_tax_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (sold_tax_qty >= 0),
  sold_internal_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (sold_internal_qty >= 0),
  bonus_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (bonus_qty >= 0),
  returned_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  shortage_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (shortage_qty >= 0),
  max_bonus_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (max_bonus_qty >= 0),
  unit_cost numeric(20, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  status text NOT NULL DEFAULT 'loaded' CHECK (status IN ('loaded', 'reconciled')),
  notes text,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS van_load_orders_tenant_idx
  ON van_load_orders (tenant_id, load_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS van_sales_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  load_order_id uuid NOT NULL REFERENCES van_load_orders(id) ON DELETE CASCADE,
  salesman_id uuid NOT NULL REFERENCES salesmen(id),
  party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_mobile text,
  customer_tax_no text,
  doc_mode text NOT NULL DEFAULT 'zatca_tax' CHECK (doc_mode IN ('zatca_tax', 'internal_delivery')),
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'credit', 'bank')),
  number text NOT NULL,
  item_id uuid NOT NULL REFERENCES items(id),
  batch_code text NOT NULL,
  sold_qty numeric(20, 4) NOT NULL CHECK (sold_qty > 0),
  bonus_qty numeric(20, 4) NOT NULL DEFAULT 0 CHECK (bonus_qty >= 0),
  bonus_reason text,
  bonus_approved boolean NOT NULL DEFAULT true,
  customer_pin text,
  unit_price numeric(20, 4) NOT NULL CHECK (unit_price >= 0),
  subtotal numeric(20, 4) NOT NULL DEFAULT 0,
  tax_rate numeric(10, 4) NOT NULL DEFAULT 0,
  tax_total numeric(20, 4) NOT NULL DEFAULT 0,
  total numeric(20, 4) NOT NULL DEFAULT 0,
  qr_payload text NOT NULL,
  sales_invoice_id uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,
  anomaly_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS van_sales_documents_tenant_idx
  ON van_sales_documents (tenant_id, created_at DESC);

ALTER TABLE marketplace_addon_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_addon_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketplace_addon_requests;
CREATE POLICY tenant_isolation ON marketplace_addon_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS platform_admin_plane ON marketplace_addon_requests;
CREATE POLICY platform_admin_plane ON marketplace_addon_requests
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['van_sales_customer_prices', 'van_load_orders', 'van_sales_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      target
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  marketplace_addon_requests,
  van_sales_customer_prices,
  van_load_orders,
  van_sales_documents
TO erp_api;

GRANT ALL PRIVILEGES ON
  marketplace_addon_requests,
  van_sales_customer_prices,
  van_load_orders,
  van_sales_documents
TO erp_migrator;

INSERT INTO marketplace_apps (
  id, code, name_ar, name_en, description_ar, icon, version, price_monthly, is_core, is_active, screens
) VALUES
  ('01990013-0000-7000-8000-000000000010', 'manufacturing', 'التصنيع والإنتاج', 'Manufacturing', 'أوامر التصنيع وقوائم المواد (BOM) وتكاليف الإنتاج للمصانع والمعامل.', '⚙️', '1.0.0', 149, false, true, '["/manufacturing/orders","/inventory/production"]'::jsonb),
  ('01990013-0000-7000-8000-000000000011', 'tailoring', 'التفصيل والخياطة', 'Tailoring', 'إدارة طلبات التفصيل والمقاسات وخيارات الخياطة والثياب.', '🧵', '1.0.0', 99, false, true, '["/tailoring/orders","/tailoring/options","/tailoring/types","/settings/tailoring"]'::jsonb),
  ('01990013-0000-7000-8000-000000000012', 'optics', 'النظارات والبصريات', 'Optics', 'بيانات فحص النظر والعدسات اليمنى واليسرى وطباعتها في الفواتير.', '👓', '1.0.0', 99, false, true, '["/optics/glasses","/settings/optics"]'::jsonb),
  ('01990013-0000-7000-8000-000000000013', 'marina', 'إدارة المراسي والقوارب', 'Marina', 'عقود المراسي والتجهيز والمناوبات وإغلاق اليومية البحرية.', '⚓', '1.0.0', 149, false, true, '["/marina/contracts","/marina/preparation","/marina/rota","/marina/link-invoices","/marina/day-close","/settings/marina"]'::jsonb),
  ('01990013-0000-7000-8000-000000000014', 'projects', 'إدارة المشاريع والمقاولات', 'Projects & Contracting', 'المشاريع وعقود المقاولين والمستخلصات ومتابعة التنفيذ والمهام.', '🏗️', '1.0.0', 149, false, true, '["/projects","/projects/tasks","/projects/contractor-contract","/projects/contractor-payment","/projects/contracting-return","/projects/offers","/projects/followup","/settings/contracting"]'::jsonb),
  ('01990013-0000-7000-8000-000000000015', 'employee_app', 'تطبيق الموظف الذاتي', 'Employee Self-Service App', 'بوابة الجوال للموظفين لتسجيل الحضور والانصراف وطلبات الإجازة والسلفة والعهدة وكشف الراتب.', '📱', '1.0.0', 79, false, true, '["/m","/m/attendance","/m/requests/new","/m/approvals","/m/profile"]'::jsonb),
  ('01990013-0000-7000-8000-000000000016', 'van_sales', 'توزيع المناديب والمخابز', 'Van Sales & Bakery Distribution', 'إدارة مناديب التوزيع وأوامر التحميل ودفعات الإنتاج اليومية وضبط البونص وتعدد أسعار العملاء والفواتير الضريبية/العادية.', '🚚', '1.0.0', 129, false, true, '["/van-sales"]'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  name_ar = EXCLUDED.name_ar,
  name_en = EXCLUDED.name_en,
  description_ar = EXCLUDED.description_ar,
  icon = EXCLUDED.icon,
  screens = EXCLUDED.screens;

ALTER ROLE erp_api NOBYPASSRLS;
