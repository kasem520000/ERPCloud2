-- 0022_sales_quotations.down.sql
DROP INDEX IF EXISTS sales_invoices_kind_idx;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS converted_invoice_id;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS valid_until;
