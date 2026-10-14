DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS dining_tables;
DROP TABLE IF EXISTS table_categories;
DROP INDEX IF EXISTS sales_invoices_order_type_idx;
DROP INDEX IF EXISTS sales_invoices_table_no_idx;
ALTER TABLE sales_invoice_lines DROP COLUMN IF EXISTS modifiers;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS combined_into;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS table_no;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS order_type;
