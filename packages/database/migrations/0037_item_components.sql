-- 0037_item_components.sql
-- Phase 05 (part 5) — مكوّنات الصنف (BOM): the bill of materials becomes usable.
--
-- `item_components` has existed since migration 0003 and has never been read or written
-- by anything: 0003 created it with FORCE RLS and no policy, and 0035 repaired the table
-- but nobody ever gave it an endpoint. The desktop keeps this table on the item card
-- itself (`frmItems` → تبويب «المكونات», `Class/ItemComponent.cs`): a component id, a
-- store, a quantity, a unit, and a bit saying whether the line is added or deducted.
--
-- Two columns are still missing to describe what the desktop stores. Both are additive
-- and nullable, so every row already there keeps working unchanged:
--
--   item_components.warehouse_id          the desktop `store` — which store a component
--                                         is drawn from when the assembly is built
--   production_order_components.unit_id   the desktop `unit` — the unit the component
--                                         quantity was counted in, so "2 علبة" on an
--                                         order means 2 × ratio base units

-- =============================================================================
-- 1. Which store a component comes from
-- =============================================================================

ALTER TABLE item_components
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses (id);

-- An index only pays for itself if something filters by the column; the production
-- screen lists a whole bill of materials by store, so it does.
CREATE INDEX IF NOT EXISTS item_components_warehouse_idx
  ON item_components (tenant_id, warehouse_id)
  WHERE warehouse_id IS NOT NULL;

-- =============================================================================
-- 2. The unit a production-order component was counted in
-- =============================================================================

ALTER TABLE production_order_components
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units_of_measure (id);

-- =============================================================================
-- 3. Keep the two tables inside the tenant fence
-- =============================================================================
-- Both tables already have RLS forced with a tenant policy (0035 repaired
-- item_components, and production_order_components was created with one); the new
-- columns inherit that, because RLS is per row, not per column. Nothing to do — stated
-- here so the next reader does not have to go and check.
