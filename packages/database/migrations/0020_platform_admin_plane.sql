-- 0020_platform_admin_plane.sql
-- The SaaS control plane (platform console): customers, licences, subscriptions.
--
-- `tenants` and `users` are platform tables with no RLS, so they were already readable
-- by an operator. `tenant_subscriptions` and `activation_requests` however carry the
-- canonical tenant-isolation policy, which made a cross-tenant listing return zero rows
-- for the API role (erp_api is NOBYPASSRLS by design, MULTI_TENANCY §3).
--
-- A second PERMISSIVE policy is added to each: multiple permissive policies are OR-ed,
-- so a request that binds `app.is_platform_admin = 'on'` for the duration of its
-- transaction sees every tenant, and every other request keeps exactly the isolation it
-- had before. The GUC is transaction-local (`set_config(..., true)`), so a pooled
-- connection can never leak the elevated scope into the next request.

DROP POLICY IF EXISTS platform_admin_plane ON tenant_subscriptions;
CREATE POLICY platform_admin_plane ON tenant_subscriptions
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS platform_admin_plane ON activation_requests;
CREATE POLICY platform_admin_plane ON activation_requests
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- Plans are a platform catalogue, not tenant data: an operator has to be able to create
-- and retire them from the console.
GRANT INSERT, UPDATE ON billing_plans TO erp_api;

DROP POLICY IF EXISTS billing_plans_readable ON billing_plans;
CREATE POLICY billing_plans_readable ON billing_plans
  USING (true)
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- Tenant lifecycle: the console suspends and reactivates customers.
GRANT INSERT, UPDATE ON tenants TO erp_api;

-- Creating a customer creates its owner user and membership too.
GRANT INSERT, UPDATE ON users TO erp_api;

-- The console also *reads* tenant-scoped identity tables across tenants (how many users
-- and branches does this customer have?). Read-only elevation is enough: the write path
-- for a new tenant binds `app.tenant_id` and passes the canonical isolation policy.
DROP POLICY IF EXISTS platform_admin_plane ON memberships;
CREATE POLICY platform_admin_plane ON memberships
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS platform_admin_plane ON branches;
CREATE POLICY platform_admin_plane ON branches
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

ALTER ROLE erp_api NOBYPASSRLS;
