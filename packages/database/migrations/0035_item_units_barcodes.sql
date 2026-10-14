-- 0035_item_units_barcodes.sql
-- Phase 05 (part 2) — وحدات القياس المتعددة، الباركود المتعدد، وتتبع الوحدة في الحركات.
--
-- The desktop `ItemUnits` table is what makes one item sellable by the piece, by the box
-- and by the carton (`ItemOper` reads `ItemUnits.perc`, and `InvoiceOper` L5031 computes
-- `ItemPrimaryQnty = ItemQuantity * UnitEquality` — the stock ledger always moves base
-- units). `ItemBarcodes` is the second half of the same idea: a box and a piece of the
-- same item carry different barcodes.
--
-- Migration 0003 created `item_units` and `item_components` but left them unusable:
-- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` with **no policy and no
-- tenant_id column**. Under FORCE RLS, a table with no policy denies every command — so
-- both tables have silently refused to read or write since 0003 (`catalogTables` exports
-- them, nothing could ever use them).
--
-- This migration repairs that, adds the unit to the movement so a box issue can be read
-- back as a box, and leaves everything else additive.

-- =============================================================================
-- 1. Give the item's sub-tables a tenant, backfill it, and isolate them
-- =============================================================================

ALTER TABLE item_units ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
ALTER TABLE item_components ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);

-- A row whose item is gone cannot be given a tenant; it is orphaned either way.
DELETE FROM item_units u WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = u.item_id);
DELETE FROM item_components c WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = c.item_id);

UPDATE item_units u SET tenant_id = i.tenant_id FROM items i WHERE i.id = u.item_id AND u.tenant_id IS NULL;
UPDATE item_components c SET tenant_id = i.tenant_id FROM items i WHERE i.id = c.item_id AND c.tenant_id IS NULL;

-- Every surviving row now has one (both tables start empty in practice, so this is a
-- guard, not a rewrite).
ALTER TABLE item_units ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE item_components ALTER COLUMN tenant_id SET NOT NULL;

DROP POLICY IF EXISTS tenant_isolation ON item_units;
CREATE POLICY tenant_isolation ON item_units
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON item_components;
CREATE POLICY tenant_isolation ON item_components
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- One row per (tenant, item, unit) — the PK is (item_id, unit_id), which is enough, but
-- the tenant-scoped index is what the RLS scans actually use.
CREATE UNIQUE INDEX IF NOT EXISTS item_units_tenant_item_unit_key ON item_units(tenant_id, item_id, unit_id);
CREATE UNIQUE INDEX IF NOT EXISTS item_components_tenant_item_component_key ON item_components(tenant_id, item_id, component_item_id);

COMMENT ON COLUMN item_units.ratio IS
  'Base units per one of THIS unit (desktop ItemUnits.perc): issuing 2 boxes of a 12-piece box moves 24 base units. Always > 0.';

-- =============================================================================
-- 2. Remember the unit a movement was entered in
-- =============================================================================

ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units_of_measure(id);
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS factor numeric(20,6) NOT NULL DEFAULT 1;

COMMENT ON COLUMN inventory_transactions.unit_id IS
  'The unit the clerk counted in (box, carton…); NULL means the item''s base unit.';
COMMENT ON COLUMN inventory_transactions.factor IS
  'Base units per the entered unit at the time of the movement (ItemUnits.ratio snapshot).';
COMMENT ON COLUMN inventory_transactions.base_qty IS
  'qty × factor — the only quantity the stock balance is ever moved by.';

-- =============================================================================
-- 3. The unit the document line was written in
-- =============================================================================

ALTER TABLE stock_voucher_lines ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units_of_measure(id);
ALTER TABLE stock_adjustment_lines ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units_of_measure(id);
ALTER TABLE stock_transfer_lines ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units_of_measure(id);

COMMENT ON COLUMN stock_voucher_lines.unit_id IS
  'Unit the line was counted in (NULL = the item''s base unit); qty is in that unit.';
