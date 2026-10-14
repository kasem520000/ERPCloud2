-- 0121_van_sales_schema_reconcile.sql
-- Reconciles all columns and NOT NULL constraints on `van_sales_customer_prices`,
-- `van_load_orders`, and `van_sales_documents` created in `0119` with the 10-pillar
-- Factory, Bakery & Van Sales schema.

-- 1. Reconcile `van_sales_customer_prices`
ALTER TABLE van_sales_customer_prices
  ALTER COLUMN item_id DROP NOT NULL;

ALTER TABLE van_sales_customer_prices
  ADD COLUMN IF NOT EXISTS price_tier_label text NOT NULL DEFAULT 'شريحة جملة المخابز',
  ADD COLUMN IF NOT EXISTS max_bonus_kg_per_invoice numeric(18, 4) NOT NULL DEFAULT 2.0000,
  ADD COLUMN IF NOT EXISTS preferred_invoice_mode text NOT NULL DEFAULT 'zatca_tax',
  ADD COLUMN IF NOT EXISTS credit_limit numeric(18, 4) NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS payment_terms_days integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS lock_price boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_discount_pct numeric(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2. Reconcile `van_load_orders`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_load_orders' AND column_name = 'branch_id'
  ) THEN
    ALTER TABLE van_load_orders ALTER COLUMN branch_id DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_load_orders' AND column_name = 'item_id'
  ) THEN
    ALTER TABLE van_load_orders ALTER COLUMN item_id DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_load_orders' AND column_name = 'batch_code'
  ) THEN
    ALTER TABLE van_load_orders ALTER COLUMN batch_code SET DEFAULT 'BATCH-DEFAULT';
    ALTER TABLE van_load_orders ALTER COLUMN batch_code DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_status_check;
ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_loaded_qty_check;

ALTER TABLE van_load_orders
  ADD COLUMN IF NOT EXISTS number text NOT NULL DEFAULT 'VLO-0001',
  ADD COLUMN IF NOT EXISTS salesman_id uuid REFERENCES salesmen(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS item_id uuid REFERENCES items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_plate text,
  ADD COLUMN IF NOT EXISTS load_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS production_batch_no text NOT NULL DEFAULT 'BATCH-DEFAULT',
  ADD COLUMN IF NOT EXISTS loaded_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loaded_total_value numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sold_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortage_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortage_value numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_bonus_qty numeric(18, 4) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_bonus_pct numeric(5, 2) NOT NULL DEFAULT 5.00,
  ADD COLUMN IF NOT EXISTS expected_cash numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS collected_cash numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_reason text,
  ADD COLUMN IF NOT EXISTS damage_inspected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS damage_inspected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS salary_deduction_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS closing_notes text,
  ADD COLUMN IF NOT EXISTS closing_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS closing_submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE van_load_orders
  ADD CONSTRAINT van_load_orders_status_check
  CHECK (status IN ('draft', 'loaded', 'in_route', 'pending_closing', 'settled', 'reconciled', 'canceled'));

-- 3. Reconcile `van_sales_documents`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_sales_documents' AND column_name = 'branch_id'
  ) THEN
    ALTER TABLE van_sales_documents ALTER COLUMN branch_id DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_sales_documents' AND column_name = 'item_id'
  ) THEN
    ALTER TABLE van_sales_documents ALTER COLUMN item_id DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_sales_documents' AND column_name = 'customer_name'
  ) THEN
    ALTER TABLE van_sales_documents ALTER COLUMN customer_name DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_sales_documents' AND column_name = 'batch_code'
  ) THEN
    ALTER TABLE van_sales_documents ALTER COLUMN batch_code SET DEFAULT 'BATCH-DEFAULT';
    ALTER TABLE van_sales_documents ALTER COLUMN batch_code DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'van_sales_documents' AND column_name = 'qr_payload'
  ) THEN
    ALTER TABLE van_sales_documents ALTER COLUMN qr_payload SET DEFAULT '';
    ALTER TABLE van_sales_documents ALTER COLUMN qr_payload DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE van_sales_documents DROP CONSTRAINT IF EXISTS van_sales_documents_payment_method_check;
ALTER TABLE van_sales_documents DROP CONSTRAINT IF EXISTS van_sales_documents_sold_qty_check;

ALTER TABLE van_sales_documents
  ADD COLUMN IF NOT EXISTS invoice_mode text NOT NULL DEFAULT 'zatca_tax',
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS doc_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS production_batch_no text NOT NULL DEFAULT 'BATCH-DEFAULT',
  ADD COLUMN IF NOT EXISTS sold_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_reason text,
  ADD COLUMN IF NOT EXISTS unit_price numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason text,
  ADD COLUMN IF NOT EXISTS discount_approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subtotal numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5, 2) NOT NULL DEFAULT 15.00,
  ADD COLUMN IF NOT EXISTS tax_total numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_amount numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost numeric(18, 4) NOT NULL DEFAULT 3.80,
  ADD COLUMN IF NOT EXISTS net_profit numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_bonus_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_confirmation_code text,
  ADD COLUMN IF NOT EXISTS bonus_anomaly boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anomaly_reason text,
  ADD COLUMN IF NOT EXISTS zatca_qr_tlv text,
  ADD COLUMN IF NOT EXISTS sales_invoice_id uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
