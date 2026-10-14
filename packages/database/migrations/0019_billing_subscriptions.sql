-- 0019_billing_subscriptions.sql
-- Real billing state for Stripe and manual activation. No demo rows are inserted.

CREATE TABLE IF NOT EXISTS billing_plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  interval text NOT NULL CHECK (interval IN ('month', 'year')),
  amount numeric(20,4) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'SAR',
  stripe_price_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES billing_plans(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'past_due', 'canceled', 'incomplete')),
  provider text NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual', 'stripe')),
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  activated_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_provider_key
  ON tenant_subscriptions(provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_subscriptions_tenant_status_idx
  ON tenant_subscriptions(tenant_id, status);

CREATE TABLE IF NOT EXISTS activation_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES billing_plans(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'canceled')),
  notes text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE INDEX IF NOT EXISTS activation_requests_status_created_idx
  ON activation_requests(status, created_at);
CREATE INDEX IF NOT EXISTS activation_requests_tenant_status_idx
  ON activation_requests(tenant_id, status);

ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_subscriptions;
CREATE POLICY tenant_isolation ON tenant_subscriptions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON activation_requests;
CREATE POLICY tenant_isolation ON activation_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON billing_plans TO erp_api;
GRANT SELECT, INSERT, UPDATE ON tenant_subscriptions, activation_requests TO erp_api;
GRANT ALL PRIVILEGES ON billing_plans, tenant_subscriptions, activation_requests TO erp_migrator;
ALTER ROLE erp_api NOBYPASSRLS;
