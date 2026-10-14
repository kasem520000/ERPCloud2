-- 0021_purchase_adjustment_notes.sql
-- Credit and debit notes on the purchase side.
--
-- The sales side has carried `sales_adjustment_notes` since 0007; suppliers had no
-- equivalent, so a supplier price correction could only be recorded by voiding and
-- re-entering the invoice. The table mirrors the sales one exactly (same lifecycle,
-- same `amount > 0` guard, same partial unique index on the allocated number) so both
-- sides can share one reporting shape.

CREATE TABLE IF NOT EXISTS purchase_adjustment_notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES purchase_invoices(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  number text,
  reason text NOT NULL,
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_adjustment_notes_tenant_number_key
  ON purchase_adjustment_notes(tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_adjustment_notes_invoice_idx
  ON purchase_adjustment_notes(tenant_id, invoice_id);

ALTER TABLE purchase_adjustment_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_adjustment_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_adjustment_notes_tenant_isolation ON purchase_adjustment_notes;
CREATE POLICY purchase_adjustment_notes_tenant_isolation ON purchase_adjustment_notes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
