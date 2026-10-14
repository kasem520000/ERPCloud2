-- 0022_sales_quotations.sql
-- Quotations (عرض سعر) reuse the sales invoice tables with `kind = 'quotation'`:
-- same lines, same totals engine, same printing. Two things are genuinely new.
--
-- `valid_until` is the offer's expiry, which only a quotation carries — an invoice is
-- valid the moment it is posted. `converted_invoice_id` records which invoice grew out
-- of the quotation, so a quote can never be converted twice and the audit trail runs
-- forward (quote → invoice) as well as backward (`reference_invoice_id`).

ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS valid_until date;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS converted_invoice_id uuid REFERENCES sales_invoices(id);
CREATE INDEX IF NOT EXISTS sales_invoices_kind_idx ON sales_invoices(tenant_id, kind, status);
