-- 0032_platform_roles_devices_scopes.down.sql
-- Reverts migration 0032. The new tables/columns carry only new-plane data, so the
-- rollback drops them; legacy representations (`users.is_platform_admin`,
-- `compat_devices`, `platform.*` permission rows) were never touched and stay intact.
--
-- NOTE: rows created through the new plane after the migration (platform role
-- grants beyond the backfill, enrolled devices, role scopes) are removed by this
-- rollback. That is inherent to a down-migration, not silent data loss: the
-- pre-0032 state is restored exactly.

DELETE FROM permissions WHERE code LIKE 'tenant.%' OR code LIKE 'console.%';

DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS membership_role_scopes;

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_kind_check;
DROP INDEX IF EXISTS memberships_kind_idx;
ALTER TABLE memberships DROP COLUMN IF EXISTS kind;

DROP TABLE IF EXISTS platform_memberships;
DROP TABLE IF EXISTS platform_roles;
