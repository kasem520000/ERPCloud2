-- down/0092_price_list_unit.down.sql — عكس 0092

DROP INDEX IF EXISTS price_list_items_item_unit_qty_idx;
DROP INDEX IF EXISTS price_list_items_unit_idx;
DROP INDEX IF EXISTS price_list_items_scope_key;

CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_scope_key
  ON price_list_items (
    price_list_id,
    coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid),
    min_qty
  );

ALTER TABLE price_list_items DROP COLUMN IF EXISTS unit_id;

ALTER ROLE erp_api NOBYPASSRLS;
