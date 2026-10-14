-- 0032_platform_roles_devices_scopes.sql
-- 2026-09 architecture/RBAC reorganisation (docs/architecture-rbac/).
--
-- Three additive, loss-free changes:
--
--   1. Platform roles (`platform_roles`, `platform_memberships`). Platform tables —
--      no `tenant_id`, no RLS — replacing the `users.is_platform_admin` boolean with
--      a real role model (family A of the catalogue in `@erp/contracts/rbac`).
--      The flag column is NOT dropped: existing deployments keep working, and the
--      backfill below copies every flagged user into `platform_memberships` as
--      `platform_owner`, so the two representations agree from day one.
--
--   2. Membership audience (`memberships.kind`, CHECK(staff,portal)). Defaults to
--      `staff`; portal memberships are backfilled from `portal_accounts`, so
--      external-customer logins become explicitly marked without touching any
--      other row.
--
--   3. Canonical device registry (`devices`) + per-role scopes
--      (`membership_role_scopes`). Both are tenant-scoped with the canonical RLS
--      policy. `devices` is backfilled from `compat_devices` (legacy desktop
--      gateway, left untouched and still serving) as `device_type = 'compat'`.
--
-- Nothing is dropped, renamed or narrowed: every statement is IF NOT EXISTS /
-- additive, and every backfill is INSERT … SELECT … WHERE NOT EXISTS, so the
-- migration is idempotent and re-runnable.

-- =============================================================================
-- 1. Platform roles (platform plane — no tenant_id, no RLS)
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_roles (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS platform_memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES platform_roles(code) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_memberships_user_role_key
  ON platform_memberships(user_id, role_code);
CREATE INDEX IF NOT EXISTS platform_memberships_user_idx ON platform_memberships(user_id);

-- Catalogue seed (family A). Descriptions mirror `@erp/contracts` `platformRoleCatalog`.
INSERT INTO platform_roles (code, name, description) VALUES
  ('platform_owner', 'Platform owner', 'Full control of the SaaS platform: tenants, billing, plans, users, support.'),
  ('platform_operations', 'Platform operations', 'Day-to-day platform operations and health monitoring. No billing, no user grants.'),
  ('platform_billing', 'Platform billing', 'Subscriptions, plans, activation reviews and dunning. No tenant mutation.'),
  ('platform_support', 'Platform support', 'Customer support with read-only tenant visibility and ticket handling.'),
  ('platform_auditor', 'Platform auditor', 'Read-only oversight across tenants, audit trail, health and queues.')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

-- Backfill: every legacy platform admin becomes a platform_owner. No data loss in
-- either direction — the flag stays, and the membership row is created once.
INSERT INTO platform_memberships (id, user_id, role_code, granted_at)
SELECT gen_random_uuid(), u.id, 'platform_owner', now()
FROM users u
WHERE u.is_platform_admin = true
  AND NOT EXISTS (
    SELECT 1 FROM platform_memberships pm
    WHERE pm.user_id = u.id AND pm.role_code = 'platform_owner'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_roles, platform_memberships TO erp_api;
GRANT ALL PRIVILEGES ON platform_roles, platform_memberships TO erp_migrator;

-- =============================================================================
-- 2. Membership audience
-- =============================================================================

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'staff';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memberships_kind_check'
  ) THEN
    ALTER TABLE memberships
      ADD CONSTRAINT memberships_kind_check CHECK (kind IN ('staff', 'portal'));
  END IF;
END
$$;

-- Backfill: a membership whose user holds a portal account is a portal membership.
UPDATE memberships m
SET kind = 'portal'
WHERE m.kind = 'staff'
  AND EXISTS (
    SELECT 1 FROM portal_accounts pa
    WHERE pa.tenant_id = m.tenant_id AND pa.user_id = m.user_id
  );

CREATE INDEX IF NOT EXISTS memberships_kind_idx ON memberships(tenant_id, kind);

-- =============================================================================
-- 3a. Per-role scopes (junction — isolation derived through `memberships`)
-- =============================================================================

CREATE TABLE IF NOT EXISTS membership_role_scopes (
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('branch', 'warehouse', 'cash_location', 'pos_terminal')),
  scope_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  PRIMARY KEY (membership_id, role_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS membership_role_scopes_role_idx
  ON membership_role_scopes(role_id);
CREATE INDEX IF NOT EXISTS membership_role_scopes_scope_idx
  ON membership_role_scopes(scope_type, scope_id);

ALTER TABLE membership_role_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_role_scopes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON membership_role_scopes;
CREATE POLICY tenant_isolation ON membership_role_scopes
  USING (EXISTS (
    SELECT 1 FROM memberships AS parent
    WHERE parent.id = membership_role_scopes.membership_id
      AND parent.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM memberships AS parent
    WHERE parent.id = membership_role_scopes.membership_id
      AND parent.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON membership_role_scopes TO erp_api;
GRANT ALL PRIVILEGES ON membership_role_scopes TO erp_migrator;

-- =============================================================================
-- 3b. Canonical device registry (tenant-scoped, RLS)
-- =============================================================================

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  device_type text NOT NULL,
  device_name text NOT NULL,
  activation_status text NOT NULL DEFAULT 'pending'
    CHECK (activation_status IN ('pending', 'active', 'suspended', 'revoked')),
  credential_hash text,
  last_seen_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_tenant_branch_name_key
  ON devices(tenant_id, branch_id, device_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS devices_branch_idx ON devices(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS devices_status_idx ON devices(tenant_id, activation_status);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON devices;
CREATE POLICY tenant_isolation ON devices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON devices TO erp_api;
GRANT ALL PRIVILEGES ON devices TO erp_migrator;

-- Backfill: mirror the legacy compat registry into the canonical inventory.
-- `compat_devices` keeps serving the compat gateway unchanged; this is a copy,
-- keyed to run exactly once per source row.
INSERT INTO devices (
  id, tenant_id, branch_id, device_type, device_name, activation_status,
  credential_hash, last_seen_at, capabilities, created_at, created_by, updated_at, updated_by
)
SELECT
  c.id, c.tenant_id, c.branch_id, 'compat', c.name,
  CASE WHEN c.status = 'active' THEN 'active' ELSE 'suspended' END,
  c.api_key_hash, c.last_seen_at,
  jsonb_build_object('compat', true, 'cursors', c.cursors),
  c.created_at, c.created_by, c.updated_at, c.updated_by
FROM compat_devices c
WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = c.id);

-- New permission codes (registry delta of this reorganisation). The seed upserts
-- the same rows idempotently; doing it here keeps SQL-only deployments complete.
INSERT INTO permissions (code, module, description) VALUES
  ('tenant.view', 'tenant', 'Read the own tenant record and its effective settings.'),
  ('tenant.manage', 'tenant', 'Update the own tenant record and typed settings in bulk.'),
  ('tenant.membership.manage', 'tenant', 'Invite, update and remove tenant memberships.'),
  ('tenant.role.manage', 'tenant', 'Create and maintain roles and their permission sets.'),
  ('tenant.settings.manage', 'tenant', 'Read and write individual typed tenant settings.'),
  ('tenant.audit.view', 'tenant', 'Read the tenant audit log.'),
  ('tenant.file.upload', 'tenant', 'Request pre-signed uploads, attach and download files.'),
  ('tenant.notification.view', 'tenant', 'Read own in-app notifications and mark them read.'),
  ('tenant.notification.manage', 'tenant', 'Create notifications for other memberships of the tenant.'),
  ('tenant.job.view', 'tenant', 'Read the transactional outbox and background-queue health.'),
  ('tenant.device.view', 'tenant', 'List and read registered tenant devices.'),
  ('tenant.device.manage', 'tenant', 'Register, activate, suspend and rotate credentials of tenant devices.'),
  ('console.tenants.view', 'console', 'List and read tenants in the platform console.'),
  ('console.tenants.manage', 'console', 'Create, suspend and reactivate tenants.'),
  ('console.subscriptions.manage', 'console', 'Create, renew and cancel tenant subscriptions.'),
  ('console.plans.manage', 'console', 'Create and retire billing plans.'),
  ('console.activation.review', 'console', 'Approve or reject tenant activation requests.'),
  ('console.users.view', 'console', 'List platform users.'),
  ('console.users.manage', 'console', 'Grant and revoke platform roles.'),
  ('console.audit.view', 'console', 'Read the cross-tenant audit trail.'),
  ('console.health.view', 'console', 'Read system health and readiness.'),
  ('console.jobs.view', 'console', 'Read background-queue and outbox health.'),
  ('console.billing.manage', 'console', 'Manage billing operations and dunning.'),
  ('console.support.manage', 'console', 'Handle platform support tickets and break-glass access.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — re-asserted on every migration run.
ALTER ROLE erp_api NOBYPASSRLS;
