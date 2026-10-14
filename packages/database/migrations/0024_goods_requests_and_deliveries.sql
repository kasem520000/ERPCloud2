-- 0024_goods_requests_and_deliveries.sql
-- The two warehouse documents that sit on either side of a transfer.
--
-- `goods_requests` (طلب بضاعة) is the internal requisition a branch raises before any
-- stock moves: it is approved (possibly for less than was asked for) and then *fulfilled*
-- by creating a draft `stock_transfers` row, which is why it carries `transfer_id` rather
-- than duplicating the transfer's own lifecycle. Nothing here touches
-- `inventory_transactions` — the transfer still owns every movement.
--
-- `stock_deliveries` (توصيل مخزني) is the handover record for a *posted* sales invoice.
-- Posting the invoice is what relieves stock in this system, so a delivery deliberately
-- writes no inventory line; it answers "what has physically left the warehouse, to whom,
-- and what is still owed to the customer". Modelling it as a second stock issue would
-- double-count every delivered unit.

CREATE TABLE IF NOT EXISTS goods_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  to_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  from_warehouse_id uuid REFERENCES warehouses(id),
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  requested_at date NOT NULL DEFAULT CURRENT_DATE,
  needed_by date,
  notes text,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  rejection_reason text,
  transfer_id uuid REFERENCES stock_transfers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CONSTRAINT goods_requests_warehouses_differ CHECK (from_warehouse_id IS NULL OR from_warehouse_id <> to_warehouse_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS goods_requests_tenant_number_key ON goods_requests(tenant_id, number);
CREATE INDEX IF NOT EXISTS goods_requests_status_idx ON goods_requests(tenant_id, status);

CREATE TABLE IF NOT EXISTS goods_request_lines (
  request_id uuid NOT NULL REFERENCES goods_requests(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  approved_qty numeric(20,4),
  note text,
  PRIMARY KEY (request_id, line_no),
  CONSTRAINT goods_request_lines_approved_range CHECK (approved_qty IS NULL OR (approved_qty >= 0 AND approved_qty <= qty))
);
CREATE INDEX IF NOT EXISTS goods_request_lines_scope_idx ON goods_request_lines(tenant_id, item_id);

CREATE TABLE IF NOT EXISTS stock_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id),
  party_id uuid REFERENCES parties(id),
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  delivered_on date NOT NULL DEFAULT CURRENT_DATE,
  recipient_name text,
  driver_name text,
  notes text,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_deliveries_tenant_number_key ON stock_deliveries(tenant_id, number);
CREATE INDEX IF NOT EXISTS stock_deliveries_invoice_idx ON stock_deliveries(tenant_id, invoice_id);
CREATE INDEX IF NOT EXISTS stock_deliveries_status_idx ON stock_deliveries(tenant_id, status);

CREATE TABLE IF NOT EXISTS stock_delivery_lines (
  delivery_id uuid NOT NULL REFERENCES stock_deliveries(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id),
  qty numeric(20,4) NOT NULL CHECK (qty > 0),
  note text,
  PRIMARY KEY (delivery_id, line_no)
);
CREATE INDEX IF NOT EXISTS stock_delivery_lines_scope_idx ON stock_delivery_lines(tenant_id, item_id);

ALTER TABLE goods_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_requests_tenant_isolation ON goods_requests;
CREATE POLICY goods_requests_tenant_isolation ON goods_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE goods_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_request_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goods_request_lines_tenant_isolation ON goods_request_lines;
CREATE POLICY goods_request_lines_tenant_isolation ON goods_request_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE stock_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_deliveries_tenant_isolation ON stock_deliveries;
CREATE POLICY stock_deliveries_tenant_isolation ON stock_deliveries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE stock_delivery_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_delivery_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_delivery_lines_tenant_isolation ON stock_delivery_lines;
CREATE POLICY stock_delivery_lines_tenant_isolation ON stock_delivery_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
