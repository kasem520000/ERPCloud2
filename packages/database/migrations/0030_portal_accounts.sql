-- 0030_portal_accounts.sql
-- Customer self-service accounts.
--
-- The portal (`apps/customer`) shows a buyer their own invoices, statement and payments. The
-- only safe way to build that is to bind a login to exactly one party: without this table the
-- portal would have to trust a query parameter for "which customer am I", which is the classic
-- way tenants end up reading each other's ledgers.
--
-- A portal account is an ordinary `users` row with an ordinary membership, so the existing
-- login, password policy, lockout and refresh flow apply unchanged. What makes it a *portal*
-- account is (a) this row, which names the party it may see, and (b) a role with **no**
-- permissions, so every ERP endpoint refuses it and only the `/portal/*` routes — which check
-- this table instead of a permission — will answer.
--
-- `UNIQUE (tenant_id, user_id)` is the load-bearing constraint: one login cannot be pointed at
-- two customers. A single party may have several logins (owner, accountant), which is why the
-- party side is only indexed.

CREATE TABLE IF NOT EXISTS portal_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  invited_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS portal_accounts_tenant_user_key ON portal_accounts(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS portal_accounts_party_idx ON portal_accounts(tenant_id, party_id);

ALTER TABLE portal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_accounts_tenant_isolation ON portal_accounts;
CREATE POLICY portal_accounts_tenant_isolation ON portal_accounts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
