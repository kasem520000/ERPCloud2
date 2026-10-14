ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS order_type text;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS table_no text;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS combined_into uuid;
ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS modifiers jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS sales_invoices_order_type_idx ON sales_invoices(tenant_id, order_type) WHERE order_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_invoices_table_no_idx ON sales_invoices(tenant_id, table_no) WHERE table_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS table_categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  printer_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid,
  legacy_source text,
  legacy_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS table_categories_name_key ON table_categories(tenant_id, branch_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS table_categories_branch_idx ON table_categories(tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS dining_tables (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES table_categories(id) ON DELETE RESTRICT,
  table_no text NOT NULL,
  name text NOT NULL,
  seats int NOT NULL DEFAULT 4,
  status text NOT NULL DEFAULT 'free' CHECK (status IN ('free','open','merged','closed','disabled')),
  current_invoice_id uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,
  combined_into uuid,
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid,
  legacy_source text,
  legacy_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS dining_tables_no_key ON dining_tables(tenant_id, branch_id, table_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS dining_tables_status_idx ON dining_tables(tenant_id, branch_id, status);

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  table_id uuid NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('open','add_item','fire','void_item','send_to_invoice','split','merge','close')),
  business_day date NOT NULL,
  line_key text NOT NULL,
  item_id uuid,
  description text,
  qty numeric(20,4) NOT NULL DEFAULT 1,
  unit_value numeric(20,4) NOT NULL DEFAULT 0,
  modifiers jsonb NOT NULL DEFAULT '[]',
  reason text,
  invoice_id uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,
  fired_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  legacy_source text,
  legacy_id text
);
CREATE INDEX IF NOT EXISTS order_events_table_idx ON order_events(tenant_id, table_id, created_at);
CREATE INDEX IF NOT EXISTS order_events_invoice_idx ON order_events(tenant_id, invoice_id);
CREATE INDEX IF NOT EXISTS order_events_day_idx ON order_events(tenant_id, branch_id, business_day);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['table_categories','dining_tables','order_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t, t);
  END LOOP;
END $$;
