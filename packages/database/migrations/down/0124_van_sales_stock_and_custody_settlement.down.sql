-- 0124_van_sales_stock_and_custody_settlement.down.sql
-- Reverts `0124` only. `0123` and earlier stay exactly as they are, and no data is touched:
-- a constraint is only narrowed back when no live row depends on the newer values.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM van_stock_movements
    WHERE movement_type IN (
      'van_receipt_rejected', 'van_load_canceled', 'van_transit_difference', 'van_count_settlement'
    )
  ) THEN
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
  END IF;
END $$;

DROP INDEX IF EXISTS van_load_orders_settlement_idx;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM van_load_orders
    WHERE status = 'pending_stock_settlement'
       OR (remaining_action IS NOT NULL OR stock_settlement_status <> 'not_required')
  ) THEN
    ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_status_check;
    ALTER TABLE van_load_orders
      ADD CONSTRAINT van_load_orders_status_check
      CHECK (status IN (
        'draft', 'pending_receipt', 'loaded', 'in_route', 'pending_closing',
        'settled', 'reconciled', 'rejected', 'canceled'
      ));
  END IF;
END $$;

ALTER TABLE van_load_orders
  DROP CONSTRAINT IF EXISTS van_load_orders_stock_settlement_status_check,
  DROP CONSTRAINT IF EXISTS van_load_orders_remaining_action_check,
  DROP COLUMN IF EXISTS damage_journal_entry_id,
  DROP COLUMN IF EXISTS stock_settlement_note,
  DROP COLUMN IF EXISTS stock_settlement_status,
  DROP COLUMN IF EXISTS remaining_inventory_tx_id,
  DROP COLUMN IF EXISTS remaining_action,
  DROP COLUMN IF EXISTS stock_adjustment_id;
