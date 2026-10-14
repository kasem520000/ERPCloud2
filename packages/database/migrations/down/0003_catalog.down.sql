DROP TABLE IF EXISTS item_details, item_price_history, item_components, item_alternative_codes, item_barcodes, item_units, items, tax_groups, units_of_measure, item_categories CASCADE;
ALTER TABLE price_list_items DROP COLUMN IF EXISTS item_id;
