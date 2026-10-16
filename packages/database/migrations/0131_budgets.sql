-- 0131_budgets.sql
--
-- M6.4 — الموازنات والمقارنة بالفعلي.
--
-- Two additive tables, zero changes to existing ones. A budget is a fiscal-year plan:
-- per postable account, an amount per fiscal period. The annual figure the accountant
-- types is distributed across the year's periods (even instalment, exact remainder in
-- the last period), and approving the budget freezes its lines — a plan people are
-- measured against does not silently move.
--
-- The variance side is never stored: "actual" is the posted journal movement of each
-- account (the trial balance's own reading), so there is no second balance to drift
-- from the ledger. Closing a period after a budget exists changes nothing for the
-- budget; the report simply reads the posted entries.
--
-- Rules honoured: additive only, idempotent (`IF NOT EXISTS` guards), RLS with the
-- canonical tenant-isolation policy, `NOBYPASSRLS` re-asserted, and the two new
-- `accounting.budget.*` permission codes inserted idempotently (the registry in
-- `packages/contracts/src/permissions.ts` stays the single source; this insert makes
-- existing databases converge without a reseed).

INSERT INTO permissions (code, module, description) VALUES
  ('accounting.budget.view', 'accounting',
   'Read budgets and the budget-versus-actual report.'),
  ('accounting.budget.manage', 'accounting',
   'Create, update, approve and delete draft budgets.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS budgets (
  id                          uuid PRIMARY KEY,
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                        text NOT NULL,
  fiscal_year_id              uuid NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
  status                      text NOT NULL DEFAULT 'draft',
  notes                       text,
  approved_at                 timestamptz,
  approved_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_by                  uuid,
  version                     integer NOT NULL DEFAULT 1,
  deleted_at                  timestamptz,
  deleted_by                  uuid,
  legacy_source               text,
  legacy_id                   text,
  CONSTRAINT budgets_status_check CHECK (status IN ('draft', 'approved')),
  CONSTRAINT budgets_name_check CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS budgets_tenant_year_name_key
  ON budgets(tenant_id, fiscal_year_id, name);
CREATE INDEX IF NOT EXISTS budgets_tenant_status_idx
  ON budgets(tenant_id, status);

CREATE TABLE IF NOT EXISTS budget_lines (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  budget_id           uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  fiscal_period_id    uuid NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  amount              numeric(20, 4) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  version             integer NOT NULL DEFAULT 1,
  legacy_source       text,
  legacy_id           text,
  CONSTRAINT budget_lines_amount_check CHECK (amount >= 0)
);

-- One amount per (budget, account, period) — the rest is derived by SUM, never stored.
CREATE UNIQUE INDEX IF NOT EXISTS budget_lines_budget_account_period_key
  ON budget_lines(budget_id, account_id, fiscal_period_id);
CREATE INDEX IF NOT EXISTS budget_lines_tenant_account_idx
  ON budget_lines(tenant_id, account_id);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budgets_tenant_isolation ON budgets;
CREATE POLICY budgets_tenant_isolation ON budgets
  USING (tenant_id = (nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_lines_tenant_isolation ON budget_lines;
CREATE POLICY budget_lines_tenant_isolation ON budget_lines
  USING (tenant_id = (nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (nullif(current_setting('app.tenant_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON budgets TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_lines TO erp_api;

COMMENT ON TABLE budgets IS
  'M6.4 — موازنة سنة مالية: مسودة تُوزَّع سطورها على الفترات، واعتمادها يجمّدها';
COMMENT ON TABLE budget_lines IS
  'M6.4 — سطر موازنة: مبلغ حساب في فترة؛ المجموع مشتق بـSUM لا مخزَّن، والمقارنة بالفعلي تُحسب من القيود المُرحَّلة';

-- The API role never bypasses RLS (re-asserted with every migration that adds tables).
ALTER ROLE erp_api NOBYPASSRLS;
