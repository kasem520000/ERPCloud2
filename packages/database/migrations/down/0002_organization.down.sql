-- =============================================================================
-- 0002_organization.down.sql — reverse of 0002_organization.sql
-- =============================================================================
-- Applied by `pnpm db:migrate:down`. Drops the ten PHASE_05 organization tables
-- together with their policies, and restores `document_sequences.branch_id` to the
-- FK-less state PHASE_04 left it in.
--
-- WARNING: destructive. Branches, warehouses and cash locations are referenced by every
-- later module; this script is an operator rollback of an unreleased migration, not a
-- data-management tool.
-- =============================================================================

ALTER TABLE IF EXISTS document_sequences DROP CONSTRAINT IF EXISTS document_sequences_branch_id_fkey;

DROP POLICY IF EXISTS tenant_isolation ON branch_posting_profiles;
DROP POLICY IF EXISTS tenant_isolation ON price_list_items;
DROP POLICY IF EXISTS tenant_isolation ON price_lists;
DROP POLICY IF EXISTS tenant_isolation ON fx_rates;
DROP POLICY IF EXISTS tenant_isolation ON currencies;
DROP POLICY IF EXISTS tenant_isolation ON cash_location_balances;
DROP POLICY IF EXISTS tenant_isolation ON cash_locations;
DROP POLICY IF EXISTS tenant_isolation ON warehouses;
DROP POLICY IF EXISTS tenant_isolation ON branches;
DROP POLICY IF EXISTS tenant_isolation ON company_profiles;

ALTER TABLE IF EXISTS branch_posting_profiles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS branch_posting_profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS price_list_items        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS price_list_items        DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS price_lists             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS price_lists             DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS fx_rates                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS fx_rates                DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS currencies              NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS currencies              DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cash_location_balances  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cash_location_balances  DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cash_locations          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cash_locations          DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS warehouses              NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS warehouses              DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS branches                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS branches                DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS company_profiles        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS company_profiles        DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS branch_posting_profiles;
DROP TABLE IF EXISTS price_list_items;
DROP TABLE IF EXISTS price_lists;
DROP TABLE IF EXISTS fx_rates;
DROP TABLE IF EXISTS currencies;
DROP TABLE IF EXISTS cash_location_balances;
DROP TABLE IF EXISTS cash_locations;
DROP TABLE IF EXISTS warehouses;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS company_profiles;
