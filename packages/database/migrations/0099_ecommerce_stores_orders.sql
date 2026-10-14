-- 0099 — provider-neutral e-commerce stores, orders and sync logs
--
-- Phase 03 deliberately keeps the product catalogue out of this migration. Orders and
-- simple stock updates are enough for the first integration surface; returns and complex
-- product variants remain outside this phase.

CREATE TABLE IF NOT EXISTS ecommerce_stores (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider             text NOT NULL,
  store_url            text,
  remote_store_id      text,
  access_token_enc     text NOT NULL,
  refresh_token_enc    text,
  webhook_secret_enc   text,
  status               text NOT NULL DEFAULT 'active',
  settings             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at         timestamptz,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz,
  updated_by           uuid,
  version              integer NOT NULL DEFAULT 1,
  CONSTRAINT ecommerce_stores_provider_check CHECK (provider IN ('salla', 'zid', 'shopify')),
  CONSTRAINT ecommerce_stores_status_check CHECK (status IN ('active', 'error')),
  CONSTRAINT ecommerce_stores_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS ecommerce_stores_tenant_provider_idx
  ON ecommerce_stores(tenant_id, provider);
CREATE INDEX IF NOT EXISTS ecommerce_stores_tenant_status_idx
  ON ecommerce_stores(tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ecommerce_stores_tenant_provider_remote_key
  ON ecommerce_stores(tenant_id, provider, remote_store_id)
  WHERE remote_store_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ecommerce_orders (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id            uuid NOT NULL,
  remote_id           text NOT NULL,
  remote_order_no     text,
  remote_status       text,
  status              text NOT NULL DEFAULT 'pending',
  customer_name       text,
  customer_mobile     text,
  currency            text NOT NULL DEFAULT 'SAR',
  total               numeric(20,4) NOT NULL DEFAULT 0,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  erp_invoice_id      uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,
  error               text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  imported_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz,
  updated_by          uuid,
  version              integer NOT NULL DEFAULT 1,
  CONSTRAINT ecommerce_orders_status_check CHECK (status IN ('pending', 'imported', 'failed')),
  CONSTRAINT ecommerce_orders_store_tenant_fk
    FOREIGN KEY (tenant_id, store_id)
    REFERENCES ecommerce_stores(tenant_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ecommerce_orders_store_remote_key
  ON ecommerce_orders(store_id, remote_id);
CREATE INDEX IF NOT EXISTS ecommerce_orders_tenant_remote_idx
  ON ecommerce_orders(tenant_id, remote_id);
CREATE INDEX IF NOT EXISTS ecommerce_orders_tenant_status_idx
  ON ecommerce_orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS ecommerce_orders_tenant_store_created_idx
  ON ecommerce_orders(tenant_id, store_id, created_at);

CREATE TABLE IF NOT EXISTS ecommerce_sync_logs (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id            uuid NOT NULL,
  direction           text NOT NULL,
  entity              text NOT NULL,
  status              text NOT NULL,
  message             text,
  records             numeric(12,0) NOT NULL DEFAULT 0,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz,
  updated_by          uuid,
  version              integer NOT NULL DEFAULT 1,
  CONSTRAINT ecommerce_sync_logs_direction_check CHECK (direction IN ('in', 'out')),
  CONSTRAINT ecommerce_sync_logs_status_check CHECK (status IN ('started', 'success', 'error')),
  CONSTRAINT ecommerce_sync_logs_store_tenant_fk
    FOREIGN KEY (tenant_id, store_id)
    REFERENCES ecommerce_stores(tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ecommerce_sync_logs_tenant_store_idx
  ON ecommerce_sync_logs(tenant_id, store_id, created_at);
CREATE INDEX IF NOT EXISTS ecommerce_sync_logs_tenant_status_idx
  ON ecommerce_sync_logs(tenant_id, status);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ecommerce_stores', 'ecommerce_orders', 'ecommerce_sync_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t,
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ecommerce_stores TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ecommerce_orders TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ecommerce_sync_logs TO erp_api;
GRANT ALL PRIVILEGES ON ecommerce_stores, ecommerce_orders, ecommerce_sync_logs TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('ecommerce.manage', 'ecommerce', 'Connect stores, synchronize orders and monitor e-commerce stock updates.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — the API role must never bypass tenant RLS.
ALTER ROLE erp_api NOBYPASSRLS;
