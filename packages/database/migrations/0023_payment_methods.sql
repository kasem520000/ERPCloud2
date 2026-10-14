-- 0023_payment_methods.sql
-- Customer payment methods (طريقة دفع عميل).
--
-- The desktop product lets a customer be filed under a payment method — cash, card,
-- transfer, cheque or open credit — and that choice drives the default due date on the
-- invoice. Storing it as a row (rather than an enum) lets a tenant name its own methods
-- and point each one at the cash location the money actually lands in.

CREATE TABLE IF NOT EXISTS payment_methods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name_ar text NOT NULL,
  name_en text,
  kind text NOT NULL DEFAULT 'cash',
  due_days int NOT NULL DEFAULT 0 CHECK (due_days >= 0),
  cash_location_id uuid REFERENCES cash_locations(id),
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_tenant_code_key
  ON payment_methods(tenant_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_tenant_default_key
  ON payment_methods(tenant_id) WHERE is_default AND deleted_at IS NULL;

ALTER TABLE parties ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES payment_methods(id);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_methods_tenant_isolation ON payment_methods;
CREATE POLICY payment_methods_tenant_isolation ON payment_methods
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
