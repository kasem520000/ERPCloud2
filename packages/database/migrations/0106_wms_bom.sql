-- 0106 — warehouse bins and light manufacturing (PHASE_10)
--
-- 0104 is the accounting assistant and 0105 is the employee app, so this phase uses 0106.
-- Existing warehouse balances and production_orders are not altered. Bins are a location
-- layer. Manufacturing posts through the same moving-average inventory engine.

CREATE TABLE IF NOT EXISTS warehouse_bins (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  code text NOT NULL,
  zone text,
  aisle text,
  rack text,
  level text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT warehouse_bins_code_check CHECK (char_length(btrim(code)) BETWEEN 1 AND 32)
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_bins_code_key
  ON warehouse_bins (tenant_id, warehouse_id, code);
CREATE INDEX IF NOT EXISTS warehouse_bins_warehouse_idx
  ON warehouse_bins (tenant_id, warehouse_id);

CREATE TABLE IF NOT EXISTS bin_balances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bin_id uuid NOT NULL REFERENCES warehouse_bins(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  lot_id uuid REFERENCES item_lots(id) ON DELETE RESTRICT,
  quantity numeric(20, 4) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bin_balances_quantity_check CHECK (quantity >= 0)
);

-- NULL lot_id must still be unique. A plain UNIQUE constraint treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS bin_balances_item_key
  ON bin_balances (tenant_id, bin_id, item_id, (COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX IF NOT EXISTS bin_balances_item_idx ON bin_balances (tenant_id, item_id);
CREATE INDEX IF NOT EXISTS bin_balances_bin_idx ON bin_balances (tenant_id, bin_id);

CREATE TABLE IF NOT EXISTS bin_transfers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_bin_id uuid NOT NULL REFERENCES warehouse_bins(id) ON DELETE RESTRICT,
  to_bin_id uuid NOT NULL REFERENCES warehouse_bins(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  lot_id uuid REFERENCES item_lots(id) ON DELETE RESTRICT,
  quantity numeric(20, 4) NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bin_transfers_quantity_check CHECK (quantity > 0),
  CONSTRAINT bin_transfers_distinct_check CHECK (from_bin_id <> to_bin_id)
);

CREATE INDEX IF NOT EXISTS bin_transfers_created_idx ON bin_transfers (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS boms (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  CONSTRAINT boms_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT boms_version_check CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS boms_product_version_key
  ON boms (tenant_id, product_item_id, version);
CREATE INDEX IF NOT EXISTS boms_product_idx ON boms (tenant_id, product_item_id);

CREATE TABLE IF NOT EXISTS bom_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bom_id uuid NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  component_item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty numeric(20, 4) NOT NULL,
  unit_id uuid REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  scrap_percent numeric(7, 4) NOT NULL DEFAULT 0,
  CONSTRAINT bom_lines_qty_check CHECK (qty > 0),
  CONSTRAINT bom_lines_scrap_check CHECK (scrap_percent >= 0 AND scrap_percent <= 100)
);

CREATE INDEX IF NOT EXISTS bom_lines_bom_idx ON bom_lines (tenant_id, bom_id);

CREATE TABLE IF NOT EXISTS manufacturing_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bom_id uuid NOT NULL REFERENCES boms(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES branches(id) ON DELETE RESTRICT,
  number text NOT NULL,
  product_item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty_planned numeric(20, 4) NOT NULL,
  qty_produced numeric(20, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  cost_total numeric(20, 4) NOT NULL DEFAULT 0,
  recipe jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT manufacturing_orders_qty_check CHECK (qty_planned > 0 AND qty_produced >= 0),
  CONSTRAINT manufacturing_orders_status_check CHECK (status IN ('draft', 'in_progress', 'done'))
);

CREATE UNIQUE INDEX IF NOT EXISTS manufacturing_orders_number_key
  ON manufacturing_orders (tenant_id, number);
CREATE INDEX IF NOT EXISTS manufacturing_orders_status_idx
  ON manufacturing_orders (tenant_id, status);

CREATE TABLE IF NOT EXISTS manufacturing_moves (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES manufacturing_orders(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  type text NOT NULL,
  qty numeric(20, 4) NOT NULL,
  unit_cost numeric(20, 4) NOT NULL DEFAULT 0,
  cost numeric(20, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manufacturing_moves_type_check CHECK (type IN ('consume', 'produce')),
  CONSTRAINT manufacturing_moves_qty_check CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS manufacturing_moves_order_idx
  ON manufacturing_moves (tenant_id, order_id);

ALTER TABLE warehouse_bins ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_bins FORCE ROW LEVEL SECURITY;
ALTER TABLE bin_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE bin_balances FORCE ROW LEVEL SECURITY;
ALTER TABLE bin_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bin_transfers FORCE ROW LEVEL SECURITY;
ALTER TABLE boms ENABLE ROW LEVEL SECURITY;
ALTER TABLE boms FORCE ROW LEVEL SECURITY;
ALTER TABLE bom_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE manufacturing_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE manufacturing_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE manufacturing_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE manufacturing_moves FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warehouse_bins_tenant_isolation ON warehouse_bins;
CREATE POLICY warehouse_bins_tenant_isolation ON warehouse_bins
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS bin_balances_tenant_isolation ON bin_balances;
CREATE POLICY bin_balances_tenant_isolation ON bin_balances
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS bin_transfers_tenant_isolation ON bin_transfers;
CREATE POLICY bin_transfers_tenant_isolation ON bin_transfers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS boms_tenant_isolation ON boms;
CREATE POLICY boms_tenant_isolation ON boms
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS bom_lines_tenant_isolation ON bom_lines;
CREATE POLICY bom_lines_tenant_isolation ON bom_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS manufacturing_orders_tenant_isolation ON manufacturing_orders;
CREATE POLICY manufacturing_orders_tenant_isolation ON manufacturing_orders
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS manufacturing_moves_tenant_isolation ON manufacturing_moves;
CREATE POLICY manufacturing_moves_tenant_isolation ON manufacturing_moves
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  warehouse_bins, bin_balances, bin_transfers, boms, bom_lines, manufacturing_orders, manufacturing_moves
  TO erp_api;
GRANT ALL PRIVILEGES ON
  warehouse_bins, bin_balances, bin_transfers, boms, bom_lines, manufacturing_orders, manufacturing_moves
  TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('inventory.bins.manage', 'inventory', 'Create warehouse bins and move quantities between them.'),
  ('manufacturing.view', 'manufacturing', 'Read bills of materials and manufacturing orders.'),
  ('manufacturing.manage', 'manufacturing', 'Create bills of materials and manufacturing orders.'),
  ('manufacturing.produce', 'manufacturing', 'Produce a manufacturing order: consume components and receive the finished item.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'inventory.bins.manage'
FROM role_permissions
WHERE permission_code IN ('inventory.adjust', 'inventory.transfer')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'manufacturing.view'
FROM role_permissions
WHERE permission_code = 'inventory.view'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'manufacturing.manage'
FROM role_permissions
WHERE permission_code = 'inventory.production.manage'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'manufacturing.produce'
FROM role_permissions
WHERE permission_code = 'inventory.production.complete'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE warehouse_bins IS
  'PHASE_10: shelf address inside a warehouse. Stock still lives in stock_balances.';
COMMENT ON TABLE manufacturing_orders IS
  'PHASE_10: light BOM order. Produce consumes components at moving average and receives the finished item.';

ALTER ROLE erp_api NOBYPASSRLS;
