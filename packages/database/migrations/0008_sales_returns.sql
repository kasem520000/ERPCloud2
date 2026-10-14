ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS reference_invoice_id uuid REFERENCES sales_invoices(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS sales_invoices_reference_idx ON sales_invoices (tenant_id, reference_invoice_id);

ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoices FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sales_invoices' AND policyname = 'sales_invoices_tenant_isolation') THEN
    CREATE POLICY sales_invoices_tenant_isolation ON sales_invoices
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
