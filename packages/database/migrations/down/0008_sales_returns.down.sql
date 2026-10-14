DROP INDEX IF EXISTS sales_invoices_reference_idx;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS reference_invoice_id;
