-- 0123_van_sales_rep_workspace_and_receipt_workflow.sql
--
-- Forward-compatible additions required by the re-engineered Factory / Bakery / Van-Sales flow
-- (مندوب التوزيع + دورة الإنتاج ← التوريد ← البيع ← التحصيل ← إغلاق الوردية):
--
--   1. `salesmen.warehouse_id` / `vehicle_plate`
--      Every rep card points at his own van/car warehouse (the official `warehouses` row that
--      holds his custody) and at the vehicle plate, so the rep workspace and the official
--      `stock_balances` panel can be filtered by the rep's own warehouse.
--   2. `factory_production_batches.branch_id`
--      The daily production screen writes the branch the bakery belongs to, which is what
--      `branch_posting_profiles` resolves from when the batch is costed.
--   3. `van_load_orders` receipt workflow (`received_qty`, `discrepancy_qty`, `discrepancy_notes`,
--      `received_at`, `received_by`, `actual_remaining_qty`) + the official ledger links
--      (`inventory_tx_id`, `return_inventory_tx_id`).
--      Supply to a van is now an official stock transfer that only becomes custody **after** the
--      rep confirms the receipt, and shift closing stores the rep's physical count so the
--      accountant can compare expected vs. actual.
--   4. `van_sales_documents.document_kind` / `reference_document_id` / `inventory_tx_id`
--      A customer return is its own van document (`document_kind = 'return'`) that references the
--      original sale document instead of mutating it, and every document points at the official
--      `inventory_transactions` row it produced.
--   5. Check constraints widened (never narrowed): the new receipt / return movement types and the
--      `pending_receipt` / `rejected` load-order states join the existing value lists.
--
-- Rules honoured here: no historical migration is edited, every statement is idempotent
-- (`IF NOT EXISTS` / drop-and-recreate guards), every new foreign key is `ON DELETE SET NULL` so
-- removing a warehouse, user or ledger row can never orphan or delete business documents, and the
-- migration changes **no data** — existing rows simply keep their current values (the new numeric
-- columns default to `0`, `document_kind` defaults to `'sale'`).

-- 1. Rep card → van/car warehouse + vehicle plate
ALTER TABLE salesmen
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vehicle_plate text;

CREATE INDEX IF NOT EXISTS salesmen_warehouse_idx ON salesmen (tenant_id, warehouse_id);

-- 2. Production batch → branch (posting-profile resolution + branch scoping)
ALTER TABLE factory_production_batches
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS factory_production_batches_branch_idx
  ON factory_production_batches (tenant_id, branch_id, production_date DESC);

-- 3. Load order: receipt workflow, physical count and official ledger links
ALTER TABLE van_load_orders
  ADD COLUMN IF NOT EXISTS inventory_tx_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS return_inventory_tx_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discrepancy_qty numeric(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discrepancy_notes text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS received_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actual_remaining_qty numeric(18, 4) NOT NULL DEFAULT 0;

-- Received/discrepancy quantities are physical facts and can never be negative.
ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_received_qty_check;
ALTER TABLE van_load_orders
  ADD CONSTRAINT van_load_orders_received_qty_check CHECK (received_qty >= 0 AND discrepancy_qty >= 0);

-- Custody exists only after the receipt step: `pending_receipt` (in transit) and `rejected`
-- (receipt refused) join the existing states. All previous states are preserved.
ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_status_check;
ALTER TABLE van_load_orders
  ADD CONSTRAINT van_load_orders_status_check
  CHECK (status IN (
    'draft',
    'pending_receipt',
    'loaded',
    'in_route',
    'pending_closing',
    'settled',
    'reconciled',
    'rejected',
    'canceled'
  ));

CREATE INDEX IF NOT EXISTS van_load_orders_receipt_idx
  ON van_load_orders (tenant_id, status, load_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS van_load_orders_salesman_open_idx
  ON van_load_orders (tenant_id, salesman_id, status)
  WHERE deleted_at IS NULL;

-- 4. Van sales document: kind, back-reference to the source document, official inventory link
ALTER TABLE van_sales_documents
  ADD COLUMN IF NOT EXISTS document_kind text NOT NULL DEFAULT 'sale',
  ADD COLUMN IF NOT EXISTS reference_document_id uuid,
  ADD COLUMN IF NOT EXISTS inventory_tx_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL;

ALTER TABLE van_sales_documents DROP CONSTRAINT IF EXISTS van_sales_documents_document_kind_check;
ALTER TABLE van_sales_documents
  ADD CONSTRAINT van_sales_documents_document_kind_check CHECK (document_kind IN ('sale', 'return'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'van_sales_documents_reference_document_id_fkey'
  ) THEN
    ALTER TABLE van_sales_documents
      ADD CONSTRAINT van_sales_documents_reference_document_id_fkey
      FOREIGN KEY (reference_document_id) REFERENCES van_sales_documents(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS van_sales_documents_reference_idx
  ON van_sales_documents (tenant_id, reference_document_id);

CREATE INDEX IF NOT EXISTS van_sales_documents_kind_idx
  ON van_sales_documents (tenant_id, document_kind, doc_date DESC)
  WHERE deleted_at IS NULL;

-- 5. Movement types written by the receipt confirmation and the customer-return flow.
--    The constraint is an inline (auto-named) CHECK from `0120`; every previous value is kept.
ALTER TABLE van_stock_movements DROP CONSTRAINT IF EXISTS van_stock_movements_movement_type_check;
ALTER TABLE van_stock_movements
  ADD CONSTRAINT van_stock_movements_movement_type_check
  CHECK (movement_type IN (
    'production_in',
    'van_load',
    'van_receipt_confirmed',
    'van_receipt_discrepancy',
    'van_sale',
    'van_bonus',
    'customer_return',
    'van_return',
    'van_damage',
    'van_shortage',
    'stocktake_adjustment',
    'collection_receipt'
  ));
