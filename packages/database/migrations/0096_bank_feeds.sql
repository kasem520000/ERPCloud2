-- 0096 — التغذية البنكية والمطابقة التلقائية (Bank Feeds)
--
-- The feed is a tenant-owned import surface. It intentionally starts with CSV/Excel-shaped
-- rows; direct Saudi open-banking connections and MT940/CAMT are future integrations.
-- Every table carries tenant_id so RLS is explicit rather than inferred through a join.

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_name         text NOT NULL,
  account_no        text,
  iban              text,
  currency          text NOT NULL DEFAULT 'SAR',
  opening_balance   numeric(20,4) NOT NULL DEFAULT 0,
  account_id        uuid REFERENCES accounts(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT bank_accounts_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS bank_accounts_tenant_idx ON bank_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS bank_accounts_tenant_account_no_idx ON bank_accounts(tenant_id, account_no);
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_tenant_iban_key
  ON bank_accounts(tenant_id, iban) WHERE iban IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_statements (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_account_id   uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  file_id           uuid REFERENCES files(id) ON DELETE SET NULL,
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  opening_balance   numeric(20,4),
  closing_balance   numeric(20,4),
  status            text NOT NULL DEFAULT 'processed',
  source_file_name  text,
  row_count         integer NOT NULL DEFAULT 0,
  error             text,
  processed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT bank_statements_status_check CHECK (status IN ('processing', 'processed', 'reconciled', 'error')),
  CONSTRAINT bank_statements_period_check CHECK (period_to >= period_from)
);

CREATE INDEX IF NOT EXISTS bank_statements_tenant_account_period_idx
  ON bank_statements(tenant_id, bank_account_id, period_from, period_to);
CREATE UNIQUE INDEX IF NOT EXISTS bank_statements_file_key
  ON bank_statements(tenant_id, file_id) WHERE file_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id                         uuid PRIMARY KEY,
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement_id               uuid NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  line_no                    integer NOT NULL,
  txn_date                   date NOT NULL,
  description                text NOT NULL DEFAULT '',
  reference                  text,
  amount                     numeric(20,4) NOT NULL,
  balance                    numeric(20,4),
  matched_voucher_id         uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  matched_invoice_id         uuid,
  matched_invoice_type       text,
  match_confidence           numeric(5,4),
  match_reason               text,
  suggested_account_id       uuid REFERENCES accounts(id) ON DELETE SET NULL,
  suggested_cost_center_id   uuid REFERENCES cost_centers(id) ON DELETE SET NULL,
  status                     text NOT NULL DEFAULT 'pending',
  matched_at                 timestamptz,
  matched_by                 uuid,
  metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid,
  updated_at                 timestamptz,
  updated_by                 uuid,
  version                    integer NOT NULL DEFAULT 1,
  CONSTRAINT bank_statement_lines_status_check CHECK (status IN ('pending', 'matched', 'ignored')),
  CONSTRAINT bank_statement_lines_invoice_type_check CHECK (
    matched_invoice_type IS NULL OR matched_invoice_type IN ('sale', 'purchase')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_lines_statement_line_key
  ON bank_statement_lines(statement_id, line_no);
CREATE INDEX IF NOT EXISTS bank_statement_lines_tenant_status_idx
  ON bank_statement_lines(tenant_id, status);
CREATE INDEX IF NOT EXISTS bank_statement_lines_statement_date_idx
  ON bank_statement_lines(statement_id, txn_date);
CREATE INDEX IF NOT EXISTS bank_statement_lines_matched_voucher_idx
  ON bank_statement_lines(tenant_id, matched_voucher_id);
CREATE INDEX IF NOT EXISTS bank_statement_lines_matched_invoice_idx
  ON bank_statement_lines(tenant_id, matched_invoice_id);

CREATE TABLE IF NOT EXISTS bank_reconciliation_rules (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  keyword           text NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  cost_center_id    uuid REFERENCES cost_centers(id) ON DELETE SET NULL,
  priority          integer NOT NULL DEFAULT 100,
  status            text NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT bank_reconciliation_rules_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliation_rules_tenant_keyword_key
  ON bank_reconciliation_rules(tenant_id, keyword);
CREATE INDEX IF NOT EXISTS bank_reconciliation_rules_priority_idx
  ON bank_reconciliation_rules(tenant_id, priority);

-- All four surfaces are tenant-scoped. FORCE matters for the API role as well as the
-- table owner, and nullif avoids an empty pooled GUC being cast to uuid.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['bank_accounts', 'bank_statements', 'bank_statement_lines', 'bank_reconciliation_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t,
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_accounts TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_statements TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_statement_lines TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_reconciliation_rules TO erp_api;
GRANT ALL PRIVILEGES ON bank_accounts, bank_statements, bank_statement_lines, bank_reconciliation_rules TO erp_migrator;

-- New tenant permissions: declaration in packages/contracts/src/permissions.ts,
-- idempotent SQL seed here, and registry/migration coverage in permission-codes.spec.ts.
INSERT INTO permissions (code, module, description) VALUES
  ('treasury.bank.view', 'treasury', 'Read bank accounts, imported statements and reconciliation results.'),
  ('treasury.bank.manage', 'treasury', 'Create bank accounts, import statements, match lines and manage reconciliation rules.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — re-asserted on every migration.
ALTER ROLE erp_api NOBYPASSRLS;
