-- 0123_van_sales_rep_workspace_and_receipt_workflow.down.sql
-- Reverts `0123` only. `0122` and earlier stay exactly as they are.

-- Same guard for the movement types written by the receipt/return flows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM van_stock_movements
    WHERE movement_type IN ('van_receipt_confirmed', 'van_receipt_discrepancy', 'customer_return')
  ) THEN
    ALTER TABLE van_stock_movements DROP CONSTRAINT IF EXISTS van_stock_movements_movement_type_check;
    ALTER TABLE van_stock_movements
      ADD CONSTRAINT van_stock_movements_movement_type_check
      CHECK (movement_type IN (
        'production_in',
        'van_load',
        'van_sale',
        'van_bonus',
        'van_return',
        'van_damage',
        'van_shortage',
        'stocktake_adjustment',
        'collection_receipt'
      ));
  END IF;
END $$;

DROP INDEX IF EXISTS van_sales_documents_kind_idx;
DROP INDEX IF EXISTS van_sales_documents_reference_idx;

ALTER TABLE van_sales_documents
  DROP CONSTRAINT IF EXISTS van_sales_documents_reference_document_id_fkey,
  DROP CONSTRAINT IF EXISTS van_sales_documents_document_kind_check,
  DROP COLUMN IF EXISTS inventory_tx_id,
  DROP COLUMN IF EXISTS reference_document_id,
  DROP COLUMN IF EXISTS document_kind;

DROP INDEX IF EXISTS van_load_orders_salesman_open_idx;
DROP INDEX IF EXISTS van_load_orders_receipt_idx;

-- Only narrow the status list back when no live row still uses a receipt-workflow state;
-- otherwise the previous (wider) constraint is kept so the rollback never fails and never
-- touches data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM van_load_orders WHERE status IN ('pending_receipt', 'rejected')
  ) THEN
    ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_status_check;
    ALTER TABLE van_load_orders
      ADD CONSTRAINT van_load_orders_status_check
      CHECK (status IN ('draft', 'loaded', 'in_route', 'pending_closing', 'settled', 'reconciled', 'canceled'));
  END IF;
END $$;

ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_received_qty_check;

ALTER TABLE van_load_orders
  DROP COLUMN IF EXISTS actual_remaining_qty,
  DROP COLUMN IF EXISTS received_by,
  DROP COLUMN IF EXISTS received_at,
  DROP COLUMN IF EXISTS discrepancy_notes,
  DROP COLUMN IF EXISTS discrepancy_qty,
  DROP COLUMN IF EXISTS received_qty,
  DROP COLUMN IF EXISTS return_inventory_tx_id,
  DROP COLUMN IF EXISTS inventory_tx_id;

DROP INDEX IF EXISTS factory_production_batches_branch_idx;

ALTER TABLE factory_production_batches
  DROP COLUMN IF EXISTS branch_id;

DROP INDEX IF EXISTS salesmen_warehouse_idx;

ALTER TABLE salesmen
  DROP COLUMN IF EXISTS vehicle_plate,
  DROP COLUMN IF EXISTS warehouse_id;
