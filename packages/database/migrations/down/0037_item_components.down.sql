-- Down migration for 0037_item_components.sql
-- Both columns are additive and nullable, so dropping them loses only the store and the
-- unit of a component line — the components themselves and their quantities survive.

DROP INDEX IF EXISTS item_components_warehouse_idx;

ALTER TABLE item_components
  DROP COLUMN IF EXISTS warehouse_id;

ALTER TABLE production_order_components
  DROP COLUMN IF EXISTS unit_id;
