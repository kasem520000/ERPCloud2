-- 0026_contractor_contracts_and_offers.sql
-- The subcontractor side of a project, and the offer that precedes the project itself.
--
-- `contractor_contracts` is the mirror of the client contract already held on `projects`:
-- a value, a retention percentage and — the part the client side does not have — an
-- advance that must be recovered out of later payments. `contractor_payments` is the
-- payment certificate against that contract; it computes retention and advance recovery
-- rather than trusting the number typed into the form, because those two deductions are
-- exactly where a subcontractor is over- or under-paid in practice.
--
-- `project_offers` is the tender/quotation a contractor issues before a project exists.
-- Accepting it does nothing to the ledger; converting it creates the project and copies
-- the offer lines into the BOQ, which is the only way the offer's numbers and the
-- project's numbers can be guaranteed to agree.

CREATE TABLE IF NOT EXISTS contractor_contracts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  contractor_party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  number text NOT NULL,
  title text NOT NULL,
  scope text,
  status text NOT NULL DEFAULT 'draft',
  contract_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (contract_value >= 0),
  retention_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (retention_pct >= 0 AND retention_pct <= 100),
  advance_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  advance_recovered numeric(20,4) NOT NULL DEFAULT 0 CHECK (advance_recovered >= 0),
  starts_on date,
  ends_on date,
  notes text,
  signed_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS contractor_contracts_tenant_number_key ON contractor_contracts(tenant_id, number);
CREATE INDEX IF NOT EXISTS contractor_contracts_project_idx ON contractor_contracts(tenant_id, project_id, status);

CREATE TABLE IF NOT EXISTS contractor_contract_lines (
  contract_id uuid NOT NULL REFERENCES contractor_contracts(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  description text NOT NULL,
  qty numeric(20,4) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (unit_value >= 0),
  line_value numeric(20,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (contract_id, line_no)
);

CREATE TABLE IF NOT EXISTS contractor_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES contractor_contracts(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  branch_id uuid REFERENCES branches(id),
  number text NOT NULL,
  kind text NOT NULL DEFAULT 'progress',
  status text NOT NULL DEFAULT 'draft',
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  gross_amount numeric(20,4) NOT NULL CHECK (gross_amount > 0),
  retention_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK (retention_amount >= 0),
  advance_recovery numeric(20,4) NOT NULL DEFAULT 0 CHECK (advance_recovery >= 0),
  net_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  notes text,
  approved_at timestamptz,
  approved_by uuid,
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS contractor_payments_tenant_number_key ON contractor_payments(tenant_id, number);
CREATE INDEX IF NOT EXISTS contractor_payments_contract_idx ON contractor_payments(tenant_id, contract_id, status);

CREATE TABLE IF NOT EXISTS project_offers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id),
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  number text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  offer_date date NOT NULL DEFAULT CURRENT_DATE,
  valid_until date,
  total_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  retention_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (retention_pct >= 0 AND retention_pct <= 100),
  notes text,
  decided_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS project_offers_tenant_number_key ON project_offers(tenant_id, number);
CREATE INDEX IF NOT EXISTS project_offers_party_idx ON project_offers(tenant_id, party_id, status);

CREATE TABLE IF NOT EXISTS project_offer_lines (
  offer_id uuid NOT NULL REFERENCES project_offers(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text NOT NULL,
  qty numeric(20,4) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_value numeric(20,4) NOT NULL DEFAULT 0 CHECK (unit_value >= 0),
  line_value numeric(20,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (offer_id, line_no)
);

ALTER TABLE contractor_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractor_contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contractor_contracts_tenant_isolation ON contractor_contracts;
CREATE POLICY contractor_contracts_tenant_isolation ON contractor_contracts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE contractor_contract_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractor_contract_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contractor_contract_lines_tenant_isolation ON contractor_contract_lines;
CREATE POLICY contractor_contract_lines_tenant_isolation ON contractor_contract_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE contractor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractor_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contractor_payments_tenant_isolation ON contractor_payments;
CREATE POLICY contractor_payments_tenant_isolation ON contractor_payments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE project_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_offers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_offers_tenant_isolation ON project_offers;
CREATE POLICY project_offers_tenant_isolation ON project_offers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE project_offer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_offer_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_offer_lines_tenant_isolation ON project_offer_lines;
CREATE POLICY project_offer_lines_tenant_isolation ON project_offer_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
