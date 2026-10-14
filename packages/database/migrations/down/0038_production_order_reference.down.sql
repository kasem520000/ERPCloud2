-- Down migration for 0038_production_order_reference.sql.
-- Drops the index first, then the three additive columns.

DROP INDEX IF EXISTS production_orders_reference_idx;

ALTER TABLE production_orders
  DROP COLUMN IF EXISTS unit_id;

ALTER TABLE production_orders
  DROP COLUMN IF EXISTS reference_date;

ALTER TABLE production_orders
  DROP COLUMN IF EXISTS reference_no;
