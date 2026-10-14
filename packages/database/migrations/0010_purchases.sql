CREATE TABLE IF NOT EXISTS purchase_invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  warehouse_id uuid REFERENCES warehouses(id),
  party_id uuid NOT NULL REFERENCES parties(id),
  reference_invoice_id uuid REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase','purchase_return')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
  number text,
  supplier_reference_no text,
  supplier_reference_date date,
  currency text NOT NULL DEFAULT 'SAR',
  price_includes_vat boolean NOT NULL DEFAULT false,
  landed_cost_alloc text CHECK (landed_cost_alloc IN ('qty','value')),
  invoice_discount numeric(20,4) NOT NULL DEFAULT 0,
  extra_tax numeric(20,4) NOT NULL DEFAULT 0,
  withholding numeric(20,4) NOT NULL DEFAULT 0,
  subtotal numeric(20,4) NOT NULL DEFAULT 0,
  tax_total numeric(20,4) NOT NULL DEFAULT 0,
  additional_cost_total numeric(20,4) NOT NULL DEFAULT 0,
  total numeric(20,4) NOT NULL DEFAULT 0,
  paid_total numeric(20,4) NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'unpaid',
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  legacy_source text,
  legacy_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_tenant_number_key ON purchase_invoices(tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_invoices_scope_idx ON purchase_invoices(tenant_id, branch_id, status);
CREATE INDEX IF NOT EXISTS purchase_invoices_party_idx ON purchase_invoices(tenant_id, party_id);
CREATE INDEX IF NOT EXISTS purchase_invoices_reference_idx ON purchase_invoices(tenant_id, reference_invoice_id);

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  item_id uuid NOT NULL REFERENCES items(id),
  tax_group_id uuid REFERENCES tax_groups(id),
  description text,
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  discount_rate numeric(20,4) NOT NULL DEFAULT 0,
  discount_amount numeric(20,4) NOT NULL DEFAULT 0,
  tax_rate numeric(20,4) NOT NULL DEFAULT 0,
  net numeric(20,4) NOT NULL DEFAULT 0,
  tax numeric(20,4) NOT NULL DEFAULT 0,
  total numeric(20,4) NOT NULL DEFAULT 0,
  allocated_cost numeric(20,4) NOT NULL DEFAULT 0,
  landed_total numeric(20,4) NOT NULL DEFAULT 0,
  unit_cost_at_post numeric(20,4),
  cost_center_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (invoice_id, line_no)
);
CREATE INDEX IF NOT EXISTS purchase_invoice_lines_scope_idx ON purchase_invoice_lines(tenant_id, item_id);

CREATE TABLE IF NOT EXISTS purchase_invoice_costs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  cost_name text NOT NULL,
  amount numeric(20,4) NOT NULL CHECK (amount >= 0),
  allocation_target text NOT NULL DEFAULT 'inventory' CHECK (allocation_target IN ('inventory','expense')),
  cost_center_id uuid,
  account_id uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS purchase_invoice_costs_invoice_idx ON purchase_invoice_costs(tenant_id, invoice_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_invoices','purchase_invoice_lines','purchase_invoice_costs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
  END LOOP;
END $$;
