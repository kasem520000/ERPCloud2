-- =============================================================================
-- 0000_platform_identity.sql — PHASE_03 Tenancy, Identity & Access
-- =============================================================================
-- Implements DATABASE_DESIGN §1 (platform), §2 (tenancy & access) and §3
-- (tenant_settings) plus the RLS policies of MULTI_TENANCY §3.
--
-- IDEMPOTENT: every statement is guarded (`IF NOT EXISTS`, `DROP ... IF EXISTS`,
-- `DO $$ ... $$`) so the file can be applied repeatedly. Reversible: see
-- `migrations/down/0000_platform_identity.down.sql`.
--
-- Primary keys are UUID v7 generated application-side (PROJECT_CONTRACT §2); no
-- `gen_random_uuid()` default is declared anywhere.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. tenants (platform — no tenant_id, no RLS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id             uuid PRIMARY KEY,
  code           text        NOT NULL,
  name           text        NOT NULL,
  status         text        NOT NULL DEFAULT 'active',
  base_currency  char(3)     NOT NULL DEFAULT 'SAR',
  timezone       text        NOT NULL DEFAULT 'Asia/Riyadh',
  locale         text        NOT NULL DEFAULT 'ar',
  country_code   char(2)     NOT NULL DEFAULT 'SA',
  meta           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz,
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  legacy_source  text,
  legacy_id      text,
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_code_key ON tenants (code);

-- -----------------------------------------------------------------------------
-- 2. users (platform — no tenant_id, no RLS)
--    password_hash is an Argon2id PHC string; NULL means "invited, not yet set".
--    PROJECT_CONTRACT §9: legacy plaintext passwords are NEVER imported — imported
--    users are flagged with must_change_password instead.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                     uuid PRIMARY KEY,
  email                  citext      NOT NULL,
  phone                  text,
  password_hash          text,
  full_name              text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'invited',
  is_platform_admin      boolean     NOT NULL DEFAULT false,
  mfa_secret_enc         bytea,
  failed_login_attempts  integer     NOT NULL DEFAULT 0,
  locked_until           timestamptz,
  must_change_password   boolean     NOT NULL DEFAULT false,
  password_changed_at    timestamptz,
  last_login_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz,
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  CONSTRAINT users_status_check CHECK (status IN ('active', 'invited', 'suspended'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

-- -----------------------------------------------------------------------------
-- 3. permissions (platform — code is the PK)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  code        text PRIMARY KEY,
  module      text NOT NULL,
  description text NOT NULL DEFAULT ''
);

-- -----------------------------------------------------------------------------
-- 4. refresh_tokens (platform — see the note in schema/platform.ts: capability-based,
--    resolved before a tenant context exists, therefore no RLS policy)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL,
  family      uuid        NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  ip          inet,
  user_agent  text,
  tenant_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_key ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_family_idx ON refresh_tokens (user_id, family);

-- -----------------------------------------------------------------------------
-- 5. memberships (tenant-scoped, RLS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memberships (
  id           uuid PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  display_name text        NOT NULL,
  branch_scope jsonb,
  status       text        NOT NULL DEFAULT 'invited',
  is_owner     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz,
  updated_by   uuid,
  version      integer     NOT NULL DEFAULT 1,
  deleted_at   timestamptz,
  deleted_by   uuid,
  CONSTRAINT memberships_status_check CHECK (status IN ('active', 'invited', 'suspended'))
);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_tenant_user_key
  ON memberships (tenant_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memberships_tenant_id_idx ON memberships (tenant_id);
CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id);

-- -----------------------------------------------------------------------------
-- 6. roles (tenant-scoped, RLS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text        NOT NULL,
  is_system   boolean     NOT NULL DEFAULT false,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz,
  updated_by  uuid,
  version     integer     NOT NULL DEFAULT 1,
  deleted_at  timestamptz,
  deleted_by  uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_tenant_id_name_key
  ON roles (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS roles_tenant_id_idx ON roles (tenant_id);

-- -----------------------------------------------------------------------------
-- 7. role_permissions (junction — isolation derived through roles)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions (code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- -----------------------------------------------------------------------------
-- 8. membership_roles (junction — isolation derived through memberships)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS membership_roles (
  membership_id uuid NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  PRIMARY KEY (membership_id, role_id)
);

CREATE INDEX IF NOT EXISTS membership_roles_role_id_idx ON membership_roles (role_id);

-- -----------------------------------------------------------------------------
-- 9. tenant_settings (tenant-scoped, RLS) — typed keys in packages/config
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key        text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- =============================================================================
-- Row-Level Security (MULTI_TENANCY §3.5)
-- `nullif(..., '')` makes an unset GUC evaluate to NULL → zero rows, which is the
-- safe failure mode; a plain cast would raise "invalid input syntax for type uuid".
-- =============================================================================

ALTER TABLE memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships    FORCE ROW LEVEL SECURITY;
ALTER TABLE roles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles          FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions   FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_roles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles   FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON memberships;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON roles;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON tenant_settings;
CREATE POLICY tenant_isolation ON tenant_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON role_permissions;
CREATE POLICY tenant_isolation ON role_permissions
  USING (EXISTS (
    SELECT 1 FROM roles AS parent
    WHERE parent.id = role_permissions.role_id
      AND parent.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM roles AS parent
    WHERE parent.id = role_permissions.role_id
      AND parent.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

DROP POLICY IF EXISTS tenant_isolation ON membership_roles;
CREATE POLICY tenant_isolation ON membership_roles
  USING (EXISTS (
    SELECT 1 FROM memberships AS parent
    WHERE parent.id = membership_roles.membership_id
      AND parent.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM memberships AS parent
    WHERE parent.id = membership_roles.membership_id
      AND parent.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

-- =============================================================================
-- Database roles (PHASE_03 §5.1: "API role / migrator role creation SQL,
-- BYPASSRLS for migrator only"). Created NOLOGIN: the deployment step (`pnpm db:roles`)
-- grants LOGIN and sets the password from the environment so no secret lands in SQL.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_api') THEN
    CREATE ROLE erp_api NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_migrator') THEN
    CREATE ROLE erp_migrator NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO erp_api;
GRANT USAGE ON SCHEMA public TO erp_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_api;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO erp_migrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_api, erp_migrator;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO erp_migrator;

-- PROJECT_CONTRACT §13.4: only the migration role and the platform-admin plane may
-- bypass RLS. `erp_api` is explicitly pinned to NOBYPASSRLS on every migration run.
ALTER ROLE erp_api NOBYPASSRLS;
