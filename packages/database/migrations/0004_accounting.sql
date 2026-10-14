CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name_ar text NOT NULL,
  name_en text,
  parent_id uuid,
  level int NOT NULL DEFAULT 0,
  path ltree NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  subtype text,
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit')),
  is_postable boolean NOT NULL DEFAULT true,
  allow_manual boolean NOT NULL DEFAULT true,
  branch_id uuid REFERENCES branches(id) ON DELETE RESTRICT,
  currency_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz, updated_by uuid, version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid, legacy_source text, legacy_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_tenant_code_key ON accounts(tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS accounts_tenant_path_gist_idx ON accounts USING gist(path);
CREATE INDEX IF NOT EXISTS accounts_tenant_parent_idx ON accounts(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS fiscal_years (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz, updated_by uuid, version int NOT NULL DEFAULT 1,
  CHECK (start_date < end_date)
);
CREATE INDEX IF NOT EXISTS fiscal_years_tenant_dates_idx ON fiscal_years(tenant_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
  name text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by uuid, closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz, updated_by uuid, version int NOT NULL DEFAULT 1,
  CHECK (start_date < end_date)
);
CREATE INDEX IF NOT EXISTS fiscal_periods_year_dates_idx ON fiscal_periods(fiscal_year_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS period_module_locks (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES fiscal_periods(id) ON DELETE CASCADE,
  module text NOT NULL, locked boolean NOT NULL DEFAULT false,
  locked_by uuid, locked_at timestamptz,
  PRIMARY KEY (period_id, module)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  fiscal_period_id uuid NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  date date NOT NULL, number text,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','auto','reversal')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','void')),
  description text, source_type text, source_id uuid, reversal_of uuid,
  idempotency_key text, posted_at timestamptz, posted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz, updated_by uuid, version int NOT NULL DEFAULT 1,
  legacy_source text, legacy_id text
);
CREATE INDEX IF NOT EXISTS journal_entries_tenant_date_idx ON journal_entries(tenant_id, date);
CREATE INDEX IF NOT EXISTS journal_entries_source_idx ON journal_entries(tenant_id, source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_idempotency_key ON journal_entries(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  debit numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency_code text, currency_amount numeric(20,4), fx_rate numeric(20,10),
  cost_center_id uuid, party_id uuid, branch_id uuid, description text,
  PRIMARY KEY(entry_id, line_no),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX IF NOT EXISTS journal_lines_tenant_account_idx ON journal_entry_lines(tenant_id, account_id);
CREATE INDEX IF NOT EXISTS journal_lines_tenant_party_idx ON journal_entry_lines(tenant_id, party_id);

CREATE TABLE IF NOT EXISTS cost_centers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL, name_ar text NOT NULL, name_en text, parent_id uuid,
  branch_id uuid REFERENCES branches(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz, updated_by uuid, version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid, legacy_source text, legacy_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS cost_centers_tenant_code_key ON cost_centers(tenant_id, code) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS opening_balances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  party_id uuid, item_id uuid, warehouse_id uuid,
  debit numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  qty numeric(20,4), unit_cost numeric(20,4), note text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz, updated_by uuid, version int NOT NULL DEFAULT 1,
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0) OR (debit = 0 AND credit = 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS opening_balances_scope_key ON opening_balances(tenant_id, fiscal_year_id, account_id, party_id, item_id, warehouse_id);

CREATE OR REPLACE FUNCTION prevent_posted_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NOT (TG_OP = 'UPDATE' AND NEW.status = 'void') THEN
    RAISE EXCEPTION 'posted journal entries are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS journal_entries_posted_immutable ON journal_entries;
CREATE TRIGGER journal_entries_posted_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION prevent_posted_journal_mutation();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['accounts','fiscal_years','fiscal_periods','period_module_locks','journal_entries','journal_entry_lines','cost_centers','opening_balances'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t); EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t); END LOOP; END $$;
