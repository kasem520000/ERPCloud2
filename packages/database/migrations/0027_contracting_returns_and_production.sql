-- 0027_contracting_returns_and_production.sql
-- Two documents that reverse or transform value that has already been recorded.
--
-- `contracting_returns` is مرتجع مقاولات: work that was certified on a posted progress
-- bill and is now being taken back — a mis-measurement, a rejected section, a change
-- order that removed scope. It cannot simply delete the bill, because the bill has
-- already produced a posted sales invoice and moved the BOQ's billed-to-date figures.
-- So the return is its own document: it releases BOQ quantity back for re-billing and
-- issues a credit note against the bill's invoice, leaving both trails intact.
--
-- `production_orders` is أمر الإنتاج: components leave the warehouse and a finished item
-- enters it. The order is deliberately ledger-neutral — the total cost of the components
-- becomes the cost of the output, so inventory value is conserved and no journal entry is
-- needed. That is also why the output unit cost is stored: it is the number a later
-- valuation or profit report has to agree with.

CREATE TABLE IF NOT EXISTS contracting_returns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  bill_id uuid NOT NULL REFERENCES progress_bills(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES branches(id),
  number text NOT NULL,
  return_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  reason text NOT NULL,
  return_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (return_value >= 0),
  retention_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (retention_value >= 0),
  net_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (net_value >= 0),
  credit_note_id uuid REFERENCES sales_adjustment_notes(id) ON DELETE SET NULL,
  posted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS contracting_returns_tenant_number_key ON contracting_returns(tenant_id, number);
CREATE INDEX IF NOT EXISTS contracting_returns_bill_idx ON contracting_returns(tenant_id, bill_id, status);

CREATE TABLE IF NOT EXISTS contracting_return_lines (
  return_id uuid NOT NULL REFERENCES contracting_returns(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES boq_terms(id) ON DELETE RESTRICT,
  return_value numeric(20,4) NOT NULL CHECK (return_value > 0),
  PRIMARY KEY (return_id, line_no)
);
CREATE INDEX IF NOT EXISTS contracting_return_lines_term_idx ON contracting_return_lines(tenant_id, term_id);

CREATE TABLE IF NOT EXISTS production_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  number text NOT NULL,
  order_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  output_item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  output_qty numeric(20,4) NOT NULL CHECK (output_qty > 0),
  component_cost numeric(20,4) NOT NULL DEFAULT 0 CHECK (component_cost >= 0),
  unit_cost numeric(20,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  notes text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS production_orders_tenant_number_key ON production_orders(tenant_id, number);
CREATE INDEX IF NOT EXISTS production_orders_status_idx ON production_orders(tenant_id, status, order_date);

CREATE TABLE IF NOT EXISTS production_order_components (
  order_id uuid NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  unit_cost numeric(20,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  line_cost numeric(20,4) NOT NULL DEFAULT 0 CHECK (line_cost >= 0),
  PRIMARY KEY (order_id, line_no)
);
CREATE INDEX IF NOT EXISTS production_order_components_item_idx ON production_order_components(tenant_id, item_id);

ALTER TABLE contracting_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracting_returns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contracting_returns_tenant_isolation ON contracting_returns;
CREATE POLICY contracting_returns_tenant_isolation ON contracting_returns
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE contracting_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracting_return_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contracting_return_lines_tenant_isolation ON contracting_return_lines;
CREATE POLICY contracting_return_lines_tenant_isolation ON contracting_return_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE production_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_orders_tenant_isolation ON production_orders;
CREATE POLICY production_orders_tenant_isolation ON production_orders
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE production_order_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_components FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_order_components_tenant_isolation ON production_order_components;
CREATE POLICY production_order_components_tenant_isolation ON production_order_components
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
