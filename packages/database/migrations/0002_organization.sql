-- =============================================================================
-- 0002_organization.sql — PHASE_05 Organization Structure
-- =============================================================================
-- Implements DATABASE_DESIGN §5 (company_profiles, branches, branch_posting_profiles,
-- warehouses, cash_locations, cash_location_balances, price_lists, price_list_items)
-- and the currency tables of §3 (currencies, fx_rates), plus the RLS policies of
-- MULTI_TENANCY §3.
--
-- It also closes a PHASE_04 hand-off: `document_sequences.branch_id` finally gets its
-- foreign key, now that `branches` exists.
--
-- IDEMPOTENT: every statement is guarded (`IF NOT EXISTS`, `DROP … IF EXISTS`,
-- `DO $$ … $$`), so the file can be applied repeatedly. Reversible: see
-- `migrations/down/0002_organization.down.sql`.
--
-- Two documented deferrals (PHASE_05 §4/§6, CR-006):
--   * no FK to `accounts` — that table arrives in PHASE_07, which also turns
--     `cash_locations.account_id` NOT NULL;
--   * no FK from `price_list_items.item_id` to `items` — that table arrives in PHASE_06.
--
-- Uniqueness is *partial* everywhere soft delete applies: a deleted branch must not keep
-- its code reserved (PROJECT_CONTRACT §5).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. company_profiles — one row per tenant (legacy `Foundation`)
--    PK is the tenant id, so the API surface is an upsert, not a collection.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_profiles (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  name_ar         text        NOT NULL,
  name_en         text,
  tax_no          text,
  cr_no           text,
  logo_file_id    uuid        REFERENCES files (id) ON DELETE SET NULL,
  address         jsonb,
  phones          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  email           text,
  country_code    char(2),
  einvoice_flags  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz,
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  legacy_source   text,
  legacy_id       text,
  CONSTRAINT company_profiles_phones_check CHECK (jsonb_typeof(phones) = 'array')
);

CREATE INDEX IF NOT EXISTS company_profiles_logo_file_idx ON company_profiles (logo_file_id);

-- -----------------------------------------------------------------------------
-- 2. branches (legacy `Branches`)
--    `branches_tenant_default_key` is the invariant behind PHASE_05 §11: at most one
--    default branch per tenant, enforced by the database rather than by a read-modify-
--    write in the service, so concurrent writers cannot both win.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
  id             uuid PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code           text        NOT NULL,
  name_ar        text        NOT NULL,
  name_en        text,
  address        jsonb,
  phone          text,
  mobile         text,
  email          text,
  is_default     boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  legacy_source  text,
  legacy_id      text
);

CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_code_key
  ON branches (tenant_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_default_key
  ON branches (tenant_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS branches_tenant_active_idx ON branches (tenant_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_legacy_key
  ON branches (tenant_id, legacy_source, legacy_id) WHERE legacy_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. warehouses (legacy `Stocks`)
--    `inventory_account_id` is ValidatedAtRuntime: P07 — no FK to `accounts` yet.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouses (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id             uuid        NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  code                  text        NOT NULL,
  name                  text        NOT NULL,
  inventory_account_id  uuid,
  is_default            boolean     NOT NULL DEFAULT false,
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz,
  updated_by            uuid,
  version               integer     NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  deleted_by            uuid,
  legacy_source         text,
  legacy_id             text
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouses_tenant_code_key
  ON warehouses (tenant_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_tenant_default_key
  ON warehouses (tenant_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS warehouses_tenant_branch_idx ON warehouses (tenant_id, branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_tenant_legacy_key
  ON warehouses (tenant_id, legacy_source, legacy_id) WHERE legacy_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. cash_locations — `Safes` + `Banks` + `treasury` unified (DOMAIN_MODEL §3)
--    One default per (tenant, kind): a tenant has a default safe *and* a default bank.
--    `account_id` is nullable in PHASE_05 (CR-006) and becomes NOT NULL + FK in P07.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_locations (
  id             uuid PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id      uuid        NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  kind           text        NOT NULL,
  name           text        NOT NULL,
  account_id     uuid,
  currency_code  char(3),
  is_default     boolean     NOT NULL DEFAULT false,
  bank           jsonb,
  change_in_pos  boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  legacy_source  text,
  legacy_id      text,
  CONSTRAINT cash_locations_kind_check CHECK (kind IN ('safe', 'bank')),
  -- A safe has no bank block; a bank row may not be empty. Keeps the two legacy
  -- tables' invariants alive now that they share one table.
  CONSTRAINT cash_locations_bank_block_check CHECK (kind = 'bank' OR bank IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_locations_tenant_kind_default_key
  ON cash_locations (tenant_id, kind) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS cash_locations_tenant_branch_idx
  ON cash_locations (tenant_id, branch_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS cash_locations_tenant_legacy_key
  ON cash_locations (tenant_id, legacy_source, legacy_id) WHERE legacy_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. cash_location_balances (legacy `Currency_SafeBalance`)
--    Denormalised cache; the truth is the journal (DATABASE_DESIGN §5). PHASE_05 seeds
--    zeros and reads — the writers arrive with treasury in PHASE_12.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_location_balances (
  tenant_id         uuid           NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  cash_location_id  uuid           NOT NULL REFERENCES cash_locations (id) ON DELETE CASCADE,
  currency_code     char(3)        NOT NULL,
  balance           numeric(20, 4) NOT NULL DEFAULT 0,
  updated_at        timestamptz,
  PRIMARY KEY (cash_location_id, currency_code)
);

CREATE INDEX IF NOT EXISTS cash_location_balances_tenant_idx ON cash_location_balances (tenant_id);

-- -----------------------------------------------------------------------------
-- 6. currencies (DATABASE_DESIGN §3) — PK(tenant_id, code), one base per tenant
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS currencies (
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code         char(3)     NOT NULL,
  name_ar      text        NOT NULL,
  name_en      text,
  minor_units  smallint    NOT NULL DEFAULT 2,
  is_base      boolean     NOT NULL DEFAULT false,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz,
  updated_by   uuid,
  version      integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, code),
  CONSTRAINT currencies_minor_units_check CHECK (minor_units BETWEEN 0 AND 4)
);

CREATE UNIQUE INDEX IF NOT EXISTS currencies_tenant_base_key ON currencies (tenant_id) WHERE is_base;

-- -----------------------------------------------------------------------------
-- 7. fx_rates (DATABASE_DESIGN §3, legacy `Currency_Lastprice`)
--    A journal of rates: one row per (pair, effective_from); `resolveFx` reads the
--    newest row on or before a date.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_rates (
  id              uuid PRIMARY KEY,
  tenant_id       uuid            NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  from_code       char(3)         NOT NULL,
  to_code         char(3)         NOT NULL,
  rate            numeric(20, 10) NOT NULL,
  effective_from  date            NOT NULL,
  created_at      timestamptz     NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz,
  updated_by      uuid,
  version         integer         NOT NULL DEFAULT 1,
  legacy_source   text,
  legacy_id       text,
  CONSTRAINT fx_rates_rate_check      CHECK (rate > 0),
  CONSTRAINT fx_rates_distinct_check  CHECK (from_code <> to_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_tenant_pair_from_key
  ON fx_rates (tenant_id, from_code, to_code, effective_from);
CREATE INDEX IF NOT EXISTS fx_rates_tenant_pair_effective_idx
  ON fx_rates (tenant_id, from_code, to_code, effective_from);

-- -----------------------------------------------------------------------------
-- 8. price_lists (legacy `priceTypes` / `Pricing`)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_lists (
  id             uuid PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name           text        NOT NULL,
  currency_code  char(3)     NOT NULL,
  is_default     boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  legacy_source  text,
  legacy_id      text
);

CREATE UNIQUE INDEX IF NOT EXISTS price_lists_tenant_name_key
  ON price_lists (tenant_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS price_lists_tenant_default_key
  ON price_lists (tenant_id) WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS price_lists_tenant_legacy_key
  ON price_lists (tenant_id, legacy_source, legacy_id) WHERE legacy_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 9. price_list_items
--    `item_id` is a nullable uuid placeholder: PHASE_06 creates `items` and adds the FK
--    (PHASE_05 §4). The unique scope folds NULL into the nil uuid so a list cannot hold
--    two rows for the same (item, quantity break).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_list_items (
  id             uuid PRIMARY KEY,
  tenant_id      uuid           NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  price_list_id  uuid           NOT NULL REFERENCES price_lists (id) ON DELETE CASCADE,
  item_id        uuid,
  unit_price     numeric(20, 4) NOT NULL,
  min_qty        numeric(20, 4) NOT NULL DEFAULT 0,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  version        integer        NOT NULL DEFAULT 1,
  CONSTRAINT price_list_items_unit_price_check CHECK (unit_price >= 0),
  CONSTRAINT price_list_items_min_qty_check    CHECK (min_qty >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_scope_key
  ON price_list_items (
    price_list_id,
    coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid),
    min_qty
  );
CREATE INDEX IF NOT EXISTS price_list_items_list_idx   ON price_list_items (price_list_id, item_id);
CREATE INDEX IF NOT EXISTS price_list_items_tenant_idx ON price_list_items (tenant_id);

-- -----------------------------------------------------------------------------
-- 10. branch_posting_profiles — legacy `SettingGeneral.*Acc` + `Branches.*Acc` merged
--     DATABASE_DESIGN §5 specifies PK(branch_id, doc_type); a NULL branch_id (the
--     tenant-wide default) cannot sit in a primary key, so the scope is a unique index
--     over coalesce(branch_id, nil-uuid) — the technique `document_sequences` already
--     uses. `doc_type = '*'` is the catch-all profile.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branch_posting_profiles (
  id             uuid PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id      uuid        REFERENCES branches (id) ON DELETE CASCADE,
  doc_type       text        NOT NULL,
  mapping        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  legacy_source  text,
  legacy_id      text,
  CONSTRAINT branch_posting_profiles_mapping_check CHECK (jsonb_typeof(mapping) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS branch_posting_profiles_scope_key
  ON branch_posting_profiles (
    tenant_id,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    doc_type
  );
CREATE INDEX IF NOT EXISTS branch_posting_profiles_tenant_doc_type_idx
  ON branch_posting_profiles (tenant_id, doc_type);

-- -----------------------------------------------------------------------------
-- 11. PHASE_04 hand-off: `document_sequences.branch_id` gets its foreign key now that
--     `branches` exists (noted in 0001_platform_services.sql and in the P04 report).
--     ON DELETE RESTRICT: losing a branch must never silently orphan its numbering.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_sequences_branch_id_fkey'
  ) THEN
    ALTER TABLE document_sequences
      ADD CONSTRAINT document_sequences_branch_id_fkey
      FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- =============================================================================
-- Row-Level Security (MULTI_TENANCY §3.5) — every table above is tenant-scoped.
-- =============================================================================

ALTER TABLE company_profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profiles        FORCE  ROW LEVEL SECURITY;
ALTER TABLE branches                ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches                FORCE  ROW LEVEL SECURITY;
ALTER TABLE warehouses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses              FORCE  ROW LEVEL SECURITY;
ALTER TABLE cash_locations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_locations          FORCE  ROW LEVEL SECURITY;
ALTER TABLE cash_location_balances  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_location_balances  FORCE  ROW LEVEL SECURITY;
ALTER TABLE currencies              ENABLE ROW LEVEL SECURITY;
ALTER TABLE currencies              FORCE  ROW LEVEL SECURITY;
ALTER TABLE fx_rates                ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates                FORCE  ROW LEVEL SECURITY;
ALTER TABLE price_lists             ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_lists             FORCE  ROW LEVEL SECURITY;
ALTER TABLE price_list_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_items        FORCE  ROW LEVEL SECURITY;
ALTER TABLE branch_posting_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_posting_profiles FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON company_profiles;
CREATE POLICY tenant_isolation ON company_profiles
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON branches;
CREATE POLICY tenant_isolation ON branches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON warehouses;
CREATE POLICY tenant_isolation ON warehouses
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON cash_locations;
CREATE POLICY tenant_isolation ON cash_locations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON cash_location_balances;
CREATE POLICY tenant_isolation ON cash_location_balances
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON currencies;
CREATE POLICY tenant_isolation ON currencies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON fx_rates;
CREATE POLICY tenant_isolation ON fx_rates
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON price_lists;
CREATE POLICY tenant_isolation ON price_lists
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON price_list_items;
CREATE POLICY tenant_isolation ON price_list_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON branch_posting_profiles;
CREATE POLICY tenant_isolation ON branch_posting_profiles
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- =============================================================================
-- Privileges (restated explicitly — see the note in 0001_platform_services.sql).
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  company_profiles, branches, warehouses, cash_locations, cash_location_balances,
  currencies, fx_rates, price_lists, price_list_items, branch_posting_profiles
  TO erp_api;
GRANT ALL PRIVILEGES ON
  company_profiles, branches, warehouses, cash_locations, cash_location_balances,
  currencies, fx_rates, price_lists, price_list_items, branch_posting_profiles
  TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — re-asserted on every migration run.
ALTER ROLE erp_api NOBYPASSRLS;
