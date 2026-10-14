-- 0122_van_sales_core_integration_and_idempotency.sql
--
-- Forward-compatible schema additions for Phase 2–5 of Factory, Bakery & Van Sales integration:
-- 1. Core service foreign-key links (`production_order_id`, `manufacturing_order_id`, `lot_id`,
--    `inventory_transaction_id`, `van_warehouse_id`, `stock_transfer_id`, `return_transfer_id`,
--    `damage_voucher_id`, `approval_request_id`, `receipt_voucher_id`, `stock_delivery_id`, `voucher_id`).
-- 2. Idempotency keys and partial uniqueness constraints to prevent duplicate document numbers,
--    duplicate invoice/collection submissions, and duplicate shift-closing movements.
-- 3. Historical customer price audit trail (`van_sales_customer_price_history`) and effective dating.

-- 1. `factory_production_batches` core links & idempotency
ALTER TABLE factory_production_batches
  ADD COLUMN IF NOT EXISTS production_order_id uuid REFERENCES production_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manufacturing_order_id uuid REFERENCES manufacturing_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES item_lots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inventory_transaction_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scrap_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS factory_production_batches_tenant_idempotency_idx
  ON factory_production_batches (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

-- 2. `van_load_orders` core links, policy status & idempotency
ALTER TABLE van_load_orders
  ADD COLUMN IF NOT EXISTS van_warehouse_id uuid REFERENCES warehouses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_transfer_id uuid REFERENCES stock_transfers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS return_transfer_id uuid REFERENCES stock_transfers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS damage_voucher_id uuid REFERENCES stock_vouchers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_request_id uuid REFERENCES approval_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shortage_policy_status text NOT NULL DEFAULT 'pending_policy_approval',
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS van_load_orders_tenant_idempotency_idx
  ON van_load_orders (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

-- 3. `van_sales_documents` core links, tax policy status & idempotency
ALTER TABLE van_sales_documents
  ADD COLUMN IF NOT EXISTS receipt_voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_delivery_id uuid REFERENCES stock_deliveries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tax_policy_status text NOT NULL DEFAULT 'standard_vat',
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS van_sales_documents_tenant_idempotency_idx
  ON van_sales_documents (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

-- 4. `van_stock_movements` core links & closing movement uniqueness
ALTER TABLE van_stock_movements
  ADD COLUMN IF NOT EXISTS inventory_transaction_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS van_stock_movements_tenant_idempotency_idx
  ON van_stock_movements (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Prevent duplicate closing movements (return, damage, shortage) per load order if no legacy duplicates exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM van_stock_movements
    WHERE load_order_id IS NOT NULL
      AND movement_type IN ('van_return', 'van_damage', 'van_shortage')
    GROUP BY tenant_id, load_order_id, movement_type
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS van_stock_movements_closing_unique_idx
      ON van_stock_movements (tenant_id, load_order_id, movement_type)
      WHERE load_order_id IS NOT NULL AND movement_type IN ('van_return', 'van_damage', 'van_shortage');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM van_load_orders
    WHERE deleted_at IS NULL
    GROUP BY tenant_id, number
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS van_load_orders_tenant_number_key
      ON van_load_orders (tenant_id, number)
      WHERE deleted_at IS NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM van_sales_documents
    WHERE deleted_at IS NULL
    GROUP BY tenant_id, number
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS van_sales_documents_tenant_number_key
      ON van_sales_documents (tenant_id, number)
      WHERE deleted_at IS NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM factory_production_batches
    WHERE deleted_at IS NULL
    GROUP BY tenant_id, batch_no
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS factory_production_batches_tenant_batch_key
      ON factory_production_batches (tenant_id, batch_no)
      WHERE deleted_at IS NULL;
  END IF;
END $$;

-- 5. `van_sales_customer_prices` effective dating & audit history table
ALTER TABLE van_sales_customer_prices
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS change_reason text;

CREATE TABLE IF NOT EXISTS van_sales_customer_price_history (
  id                       uuid PRIMARY KEY,
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_price_id        uuid NOT NULL REFERENCES van_sales_customer_prices(id) ON DELETE CASCADE,
  party_id                 uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  item_id                  uuid REFERENCES items(id) ON DELETE SET NULL,
  previous_unit_price      numeric(20, 4),
  new_unit_price           numeric(20, 4) NOT NULL,
  max_bonus_pct            numeric(10, 4) NOT NULL DEFAULT 0,
  max_bonus_kg_per_invoice numeric(18, 4) NOT NULL DEFAULT 0,
  max_discount_pct         numeric(5, 2) NOT NULL DEFAULT 0,
  lock_price               boolean NOT NULL DEFAULT true,
  effective_from           date NOT NULL DEFAULT CURRENT_DATE,
  effective_to             date,
  change_reason            text,
  changed_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS van_sales_customer_price_history_tenant_idx
  ON van_sales_customer_price_history (tenant_id, party_id, created_at DESC);

ALTER TABLE van_sales_customer_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE van_sales_customer_price_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON van_sales_customer_price_history;
CREATE POLICY tenant_isolation ON van_sales_customer_price_history
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS platform_admin_plane ON van_sales_customer_price_history;
CREATE POLICY platform_admin_plane ON van_sales_customer_price_history
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON
  van_sales_customer_price_history
TO erp_api, erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('van_sales.view', 'van_sales', 'Read factory production batches, van load orders, sales documents and reports.'),
  ('van_sales.production.manage', 'van_sales', 'Record daily factory and bakery production batches.'),
  ('van_sales.pricing.manage', 'van_sales', 'Configure customer special price tiers, bonus caps and credit limits.'),
  ('van_sales.load.manage', 'van_sales', 'Create van load orders and transfer stock to sales rep custody.'),
  ('van_sales.invoice.create', 'van_sales', 'Issue van sales invoices and free bonus quantities.'),
  ('van_sales.collection.create', 'van_sales', 'Record customer debt collections and receipt allocations.'),
  ('van_sales.closing.submit', 'van_sales', 'Submit end-of-day rep custody shift closing for inspection.'),
  ('van_sales.closing.approve', 'van_sales', 'Inspect damaged goods, approve shortage settlement and close rep custody.'),
  ('van_sales.override.approve', 'van_sales', 'Override locked customer prices, discount ceilings and bonus caps.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

ALTER ROLE erp_api NOBYPASSRLS;

