-- 0129_fixed_assets.sql
--
-- M6.1 — الأصول الثابتة: السجل والتصنيفات وجدول الإهلاك وترحيلاته.
--
-- The module is isolated by design (IMPLEMENTATION_ROADMAP M6.1): three new tables, zero
-- changes to existing ones. Every depreciation posting happens through
-- `AccountingService.postJournalInTx` — the balanced-entry, open-period and module-lock
-- guards live in one place — so this migration carries structure, not posting logic:
--
--   * `asset_categories` — code + name + the default useful life and the three posting
--     accounts (asset / accumulated depreciation / depreciation expense) a category
--     hands to its assets. Accounts are plain `accounts` FKs `ON DELETE RESTRICT`:
--     an account a category posts through can never be orphaned by a delete.
--   * `fixed_assets` — the register. `acquisition_date`'s month is the FIRST
--     depreciation month (no separate in-service date: one date, one meaning). Straight
--     line only for now (`method` column so the shape is forward-compatible), `status`
--     carries active / fully_depreciated / disposed.
--   * `asset_depreciation_entries` — the run ledger: one row per asset per month EVER
--     (`UNIQUE (tenant_id, asset_id, period)` — that constraint IS the run's
--     idempotency), each row pointing at the journal entry that posted it. It is not a
--     second balance: accumulated depreciation is always `SUM(amount)` over these rows.
--
-- Rules honoured: additive only, idempotent (`IF NOT EXISTS` guards), RLS with the
-- canonical tenant-isolation policy, `NOBYPASSRLS` re-asserted, and the three new
-- `accounting.assets.*` permission codes inserted idempotently (the registry in
-- `packages/contracts/src/permissions.ts` stays the single source; this insert makes
-- existing databases converge without a reseed).

INSERT INTO permissions (code, module, description) VALUES
  ('accounting.assets.view', 'accounting',
   'Read fixed-asset categories, the asset register, schedules and depreciation runs.'),
  ('accounting.assets.manage', 'accounting',
   'Create and update fixed-asset categories and register assets.'),
  ('accounting.assets.depreciate', 'accounting',
   'Run the monthly depreciation posting (creates journal entries).')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS asset_categories (
  id                          uuid PRIMARY KEY,
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                        text NOT NULL,
  name_ar                     text NOT NULL,
  name_en                     text,
  default_useful_life_months  integer NOT NULL,
  asset_account_id            uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  accumulated_account_id      uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  depreciation_account_id     uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_by                  uuid,
  version                     integer NOT NULL DEFAULT 1,
  deleted_at                  timestamptz,
  deleted_by                  uuid,
  legacy_source               text,
  legacy_id                   text,
  CONSTRAINT asset_categories_life_check CHECK (default_useful_life_months > 0),
  CONSTRAINT asset_categories_code_check CHECK (char_length(code) BETWEEN 1 AND 64),
  CONSTRAINT asset_categories_name_check CHECK (char_length(name_ar) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_tenant_code_key
  ON asset_categories(tenant_id, code);

CREATE TABLE IF NOT EXISTS fixed_assets (
  id                       uuid PRIMARY KEY,
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                     text NOT NULL,
  name_ar                  text NOT NULL,
  name_en                  text,
  category_id              uuid NOT NULL REFERENCES asset_categories(id) ON DELETE RESTRICT,
  branch_id                uuid REFERENCES branches(id) ON DELETE RESTRICT,
  acquisition_date         date NOT NULL,
  acquisition_cost         numeric(20, 4) NOT NULL,
  salvage_value            numeric(20, 4) NOT NULL DEFAULT 0,
  useful_life_months       integer NOT NULL,
  method                   text NOT NULL DEFAULT 'straight_line',
  status                   text NOT NULL DEFAULT 'active',
  asset_account_id         uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  accumulated_account_id   uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  depreciation_account_id  uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_by               uuid,
  version                  integer NOT NULL DEFAULT 1,
  deleted_at               timestamptz,
  deleted_by               uuid,
  legacy_source            text,
  legacy_id                text,
  CONSTRAINT fixed_assets_cost_check CHECK (acquisition_cost > 0),
  CONSTRAINT fixed_assets_salvage_check CHECK (salvage_value >= 0 AND salvage_value <= acquisition_cost),
  CONSTRAINT fixed_assets_life_check CHECK (useful_life_months > 0),
  CONSTRAINT fixed_assets_method_check CHECK (method IN ('straight_line')),
  CONSTRAINT fixed_assets_status_check CHECK (status IN ('active', 'fully_depreciated', 'disposed')),
  CONSTRAINT fixed_assets_code_check CHECK (char_length(code) BETWEEN 1 AND 64),
  CONSTRAINT fixed_assets_name_check CHECK (char_length(name_ar) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_tenant_code_key
  ON fixed_assets(tenant_id, code);
CREATE INDEX IF NOT EXISTS fixed_assets_tenant_status_idx
  ON fixed_assets(tenant_id, status);
CREATE INDEX IF NOT EXISTS fixed_assets_tenant_category_idx
  ON fixed_assets(tenant_id, category_id);

CREATE TABLE IF NOT EXISTS asset_depreciation_entries (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id            uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  period              text NOT NULL,
  depreciation_date   date NOT NULL,
  amount              numeric(20, 4) NOT NULL,
  journal_entry_id    uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  fiscal_period_id    uuid REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  branch_id           uuid REFERENCES branches(id) ON DELETE RESTRICT,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_depreciation_entries_period_check
    CHECK (period ~ '^[0-9]{4}-[0-9]{2}$' AND period >= '0001-01' AND period <= '9999-12'),
  CONSTRAINT asset_depreciation_entries_amount_check CHECK (amount > 0)
);

-- One depreciation posting per asset per month, ever — the run's idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS asset_depreciation_entries_asset_period_key
  ON asset_depreciation_entries(tenant_id, asset_id, period);
CREATE INDEX IF NOT EXISTS asset_depreciation_entries_tenant_period_idx
  ON asset_depreciation_entries(tenant_id, period);
CREATE INDEX IF NOT EXISTS asset_depreciation_entries_journal_idx
  ON asset_depreciation_entries(journal_entry_id);

ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_categories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_categories_tenant_isolation ON asset_categories;
CREATE POLICY asset_categories_tenant_isolation ON asset_categories
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fixed_assets_tenant_isolation ON fixed_assets;
CREATE POLICY fixed_assets_tenant_isolation ON fixed_assets
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE asset_depreciation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_depreciation_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_depreciation_entries_tenant_isolation ON asset_depreciation_entries;
CREATE POLICY asset_depreciation_entries_tenant_isolation ON asset_depreciation_entries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON asset_categories TO erp_api;
GRANT ALL PRIVILEGES ON asset_categories TO erp_migrator;
GRANT SELECT, INSERT, UPDATE ON fixed_assets TO erp_api;
GRANT ALL PRIVILEGES ON fixed_assets TO erp_migrator;
GRANT SELECT, INSERT ON asset_depreciation_entries TO erp_api;
GRANT ALL PRIVILEGES ON asset_depreciation_entries TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;

COMMENT ON TABLE asset_categories IS
  'M6.1 fixed assets: categories with default useful life and posting accounts';
COMMENT ON COLUMN asset_categories.default_useful_life_months IS
  'Default useful life in months inherited by a new asset that names none';
COMMENT ON TABLE fixed_assets IS
  'M6.1 fixed assets: the register; acquisition month is the first depreciation month';
COMMENT ON COLUMN fixed_assets.method IS
  'Depreciation method — straight_line only (column kept for forward compatibility)';
COMMENT ON COLUMN fixed_assets.status IS
  'active = depreciating, fully_depreciated = life months all posted, disposed = removed (disposal flow is a follow-up)';
COMMENT ON TABLE asset_depreciation_entries IS
  'M6.1 fixed assets: one posted depreciation month per asset — the unique (tenant, asset, period) is the run idempotency';
COMMENT ON COLUMN asset_depreciation_entries.period IS
  'Accounting month YYYY-MM the depreciation belongs to';
COMMENT ON COLUMN asset_depreciation_entries.journal_entry_id IS
  'The posted entry (created through postJournalInTx) — never a second balance source';
