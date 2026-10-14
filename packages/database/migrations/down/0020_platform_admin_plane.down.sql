-- 0020_platform_admin_plane.down.sql
DROP POLICY IF EXISTS platform_admin_plane ON tenant_subscriptions;
DROP POLICY IF EXISTS platform_admin_plane ON activation_requests;
DROP POLICY IF EXISTS billing_plans_readable ON billing_plans;
REVOKE INSERT, UPDATE ON billing_plans FROM erp_api;
REVOKE INSERT, UPDATE ON tenants FROM erp_api;
REVOKE INSERT, UPDATE ON users FROM erp_api;
DROP POLICY IF EXISTS platform_admin_plane ON memberships;
DROP POLICY IF EXISTS platform_admin_plane ON branches;
