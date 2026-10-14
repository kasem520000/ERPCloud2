-- 0120_factory_van_sales_complete.sql
--
-- 1. Remove restrictive `feature.* = false` rows that `seed.ts` previously wrote into
--    `tenant_settings` so core features (`feature.pos`, `feature.hrm`) are never blocked.
-- 2. Upgrade `van_load_orders`, `van_sales_customer_prices`, and `van_sales_documents`
--    with all columns required by the 10-pillar Factory & Van Sales solution, including:
--    - `loaded_total_value` (compatibility with open orders value aggregation)
--    - End-of-day pending shift closing (`pending_closing`) & accountant approval workflow
--      (`damaged_qty`, `shortage_qty`, `shortage_value`, `damage_inspected`, `salary_deduction_approved`)
--    - Price locking, exceptional discount approval, bonus reason, and unit cost / profit tracking.
-- 3. Create `factory_production_batches` and `van_stock_movements` with tenant RLS policies.

DELETE FROM tenant_settings
WHERE key IN ('feature.pos', 'feature.hrm', 'feature.projects', 'feature.niche')
  AND value = 'false'::jsonb;

-- Ensure `van_load_orders` has all columns and supports `in_route` and `pending_closing`
ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_status_check;
ALTER TABLE van_load_orders
  ADD COLUMN IF NOT EXISTS loaded_total_value numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortage_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortage_value numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_reason text,
  ADD COLUMN IF NOT EXISTS damage_inspected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS damage_inspected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS salary_deduction_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS closing_notes text,
  ADD COLUMN IF NOT EXISTS closing_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS closing_submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE van_load_orders
  ADD CONSTRAINT van_load_orders_status_check
  CHECK (status IN ('draft', 'loaded', 'in_route', 'pending_closing', 'settled', 'canceled'));

-- Ensure `van_sales_customer_prices` has credit limit, price lock, and discount ceiling
ALTER TABLE van_sales_customer_prices
  ADD COLUMN IF NOT EXISTS credit_limit numeric(18, 4) NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS payment_terms_days integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS lock_price boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_discount_pct numeric(5, 2) NOT NULL DEFAULT 0;

-- Ensure `van_sales_documents` has bonus reason, discount approval, cost/profit, and ZATCA QR TLV
ALTER TABLE van_sales_documents
  ADD COLUMN IF NOT EXISTS bonus_reason text,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason text,
  ADD COLUMN IF NOT EXISTS discount_approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_cost numeric(18, 4) NOT NULL DEFAULT 3.80,
  ADD COLUMN IF NOT EXISTS net_profit numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS zatca_qr_tlv text;

-- 1. Factory Daily Production Batches (`factory_production_batches`)
CREATE TABLE IF NOT EXISTS factory_production_batches (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_no          text NOT NULL,
  production_date   date NOT NULL DEFAULT CURRENT_DATE,
  item_id           uuid REFERENCES items(id) ON DELETE SET NULL,
  item_name         text NOT NULL DEFAULT 'رقائق سمبوسة وفطائر طازجة',
  warehouse_id      uuid REFERENCES warehouses(id) ON DELETE SET NULL,
  produced_qty      numeric(18, 4) NOT NULL DEFAULT 0,
  issued_qty        numeric(18, 4) NOT NULL DEFAULT 0,
  returned_good_qty numeric(18, 4) NOT NULL DEFAULT 0,
  damaged_qty       numeric(18, 4) NOT NULL DEFAULT 0,
  unit_cost         numeric(18, 4) NOT NULL DEFAULT 3.80,
  total_cost        numeric(18, 4) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'closed')),
  supervisor_name   text,
  notes             text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE INDEX IF NOT EXISTS factory_production_batches_tenant_idx
  ON factory_production_batches (tenant_id, production_date DESC, created_at DESC);

-- 2. Goods Movement & Audit Ledger (`van_stock_movements`)
CREATE TABLE IF NOT EXISTS van_stock_movements (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  movement_type       text NOT NULL CHECK (
    movement_type IN (
      'production_in',
      'van_load',
      'van_sale',
      'van_bonus',
      'van_return',
      'van_damage',
      'van_shortage',
      'stocktake_adjustment',
      'collection_receipt'
    )
  ),
  batch_no            text,
  load_order_id       uuid REFERENCES van_load_orders(id) ON DELETE SET NULL,
  salesman_id         uuid REFERENCES salesmen(id) ON DELETE SET NULL,
  party_id            uuid REFERENCES parties(id) ON DELETE SET NULL,
  item_id             uuid REFERENCES items(id) ON DELETE SET NULL,
  qty                 numeric(18, 4) NOT NULL DEFAULT 0,
  unit_price          numeric(18, 4) NOT NULL DEFAULT 0,
  amount              numeric(18, 4) NOT NULL DEFAULT 0,
  reason              text,
  actor_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS van_stock_movements_tenant_idx
  ON van_stock_movements (tenant_id, created_at DESC);

-- Enable RLS on new tables using canonical `nullif(current_setting('app.tenant_id', true), '')::uuid`
ALTER TABLE factory_production_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_production_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE van_stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE van_stock_movements FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['factory_production_batches', 'van_stock_movements'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      target
    );

    EXECUTE format('DROP POLICY IF EXISTS platform_admin_plane ON %I', target);
    EXECUTE format(
      'CREATE POLICY platform_admin_plane ON %I USING '
      '(COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'') WITH CHECK '
      '(COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'')',
      target
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  factory_production_batches,
  van_stock_movements
TO erp_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  factory_production_batches,
  van_stock_movements
TO erp_migrator;

ALTER ROLE erp_api NOBYPASSRLS;
