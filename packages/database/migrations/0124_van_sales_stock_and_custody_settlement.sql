-- 0124_van_sales_stock_and_custody_settlement.sql
--
-- تسوية المخزون والعهدة — the columns the van-sales closing needs so that a custody can never
-- be declared closed while the official stock ledger still disagrees with the physical count,
-- and so that the *quantity* settlement (official `stock_adjustments`) is kept separate from the
-- *financial responsibility* for a shortage (which stays pending an authorised decision).
--
-- Everything here is additive and idempotent (`IF NOT EXISTS`), every foreign key is
-- `ON DELETE SET NULL` so no business document can be orphaned or cascade-deleted, the two CHECK
-- constraints are **widened** (never narrowed — every pre-existing value survives), and no row is
-- modified: existing load orders keep `stock_settlement_status = 'not_required'`.
--
-- Separation enforced by these columns:
--   1. quantity settlement in stock  → `stock_adjustment_id` (the official count document)
--   2. proof of the shortage & value → `shortage_qty` / `shortage_value` (already existed)
--   3. who bears the value           → NOT here: `shortage_policy_status` stays
--                                       'pending_policy_approval' and no employee/salary column
--                                       is added by this migration
--   4. approval by the authorised person → `stock_settlement_status` + `approved_by`/`approved_at`

ALTER TABLE van_load_orders
  -- 1) التسوية الكمية الرسمية — the official stocktake document that reconciles the van balance
  --    with the rep's physical count (`InventoryService.createAdjustment` / `postAdjustment`).
  ADD COLUMN IF NOT EXISTS stock_adjustment_id uuid REFERENCES stock_adjustments(id) ON DELETE SET NULL,
  -- What the accountant decided to do with the kilograms the rep counted back in the van:
  -- 'return_to_main' (officially back to the main warehouse) or 'carry_over' (stays as the rep's
  -- stock for the next shift). NULL = no decision taken yet, so the custody cannot be closed.
  ADD COLUMN IF NOT EXISTS remaining_action text,
  ADD COLUMN IF NOT EXISTS remaining_inventory_tx_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  -- 2) حالة تسوية المخزون — the state machine that keeps stock and custody honest:
  --    not_required · pending_transit_decision · pending_count_decision ·
  --    blocked_missing_accounts · settled_officially
  ADD COLUMN IF NOT EXISTS stock_settlement_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS stock_settlement_note text,
  -- Traceability for the damage write-off journal (the entry itself already points back here
  -- through `journal_entries.source_type/source_id`).
  ADD COLUMN IF NOT EXISTS damage_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL;

ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_remaining_action_check;
ALTER TABLE van_load_orders
  ADD CONSTRAINT van_load_orders_remaining_action_check
  CHECK (remaining_action IS NULL OR remaining_action IN ('return_to_main', 'carry_over'));

ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_stock_settlement_status_check;
ALTER TABLE van_load_orders
  ADD CONSTRAINT van_load_orders_stock_settlement_status_check
  CHECK (stock_settlement_status IN (
    'not_required',
    'pending_transit_decision',
    'pending_count_decision',
    'blocked_missing_accounts',
    'settled_officially'
  ));

-- `pending_stock_settlement` joins the state list: a closing whose quantities are approved but
-- whose stock has not been reconciled yet is NOT settled. All previous states are preserved.
ALTER TABLE van_load_orders DROP CONSTRAINT IF EXISTS van_load_orders_status_check;
ALTER TABLE van_load_orders
  ADD CONSTRAINT van_load_orders_status_check
  CHECK (status IN (
    'draft',
    'pending_receipt',
    'loaded',
    'in_route',
    'pending_closing',
    'pending_stock_settlement',
    'settled',
    'reconciled',
    'rejected',
    'canceled'
  ));

CREATE INDEX IF NOT EXISTS van_load_orders_settlement_idx
  ON van_load_orders (tenant_id, stock_settlement_status, load_date DESC)
  WHERE deleted_at IS NULL;

-- A rep's refusal of a supply is its own auditable movement type.
ALTER TABLE van_stock_movements DROP CONSTRAINT IF EXISTS van_stock_movements_movement_type_check;
ALTER TABLE van_stock_movements
  ADD CONSTRAINT van_stock_movements_movement_type_check
  CHECK (movement_type IN (
    'production_in',
    'van_load',
    'van_receipt_confirmed',
    'van_receipt_discrepancy',
    'van_receipt_rejected',
    'van_load_canceled',
    'van_transit_difference',
    'van_sale',
    'van_bonus',
    'customer_return',
    'van_return',
    'van_damage',
    'van_shortage',
    'van_count_settlement',
    'stocktake_adjustment',
    'collection_receipt'
  ));
