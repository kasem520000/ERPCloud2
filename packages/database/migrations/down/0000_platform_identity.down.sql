-- =============================================================================
-- 0000_platform_identity.down.sql — reverse of 0000_platform_identity.sql
-- =============================================================================
-- Applied by `pnpm db:migrate:down` in reverse file order. Drops the nine platform
-- tables of PHASE_03 together with their RLS policies. The database roles are only
-- stripped of their grants: dropping a role is a cluster-wide operation that must be
-- an explicit operator action, never a side effect of a schema rollback.
--
-- WARNING: destructive. No tenant business data exists yet at this phase
-- (PHASE_03 §6: "No tenant business data yet"), which is why a hard drop is safe here.
-- From PHASE_05 onwards rollback scripts must be data-preserving.
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON membership_roles;
DROP POLICY IF EXISTS tenant_isolation ON role_permissions;
DROP POLICY IF EXISTS tenant_isolation ON tenant_settings;
DROP POLICY IF EXISTS tenant_isolation ON roles;
DROP POLICY IF EXISTS tenant_isolation ON memberships;

ALTER TABLE IF EXISTS membership_roles  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS membership_roles  DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS role_permissions  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS role_permissions  DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tenant_settings   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tenant_settings   DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS roles             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS roles             DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS memberships       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS memberships       DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS tenant_settings;
DROP TABLE IF EXISTS membership_roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM erp_api;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM erp_migrator;
