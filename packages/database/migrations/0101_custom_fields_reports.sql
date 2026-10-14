-- 0101 — tenant-scoped custom fields, values and safe saved reports (PHASE_05)
-- 0100 belongs to the approval workflow engine; custom fields intentionally follow it.

CREATE TABLE IF NOT EXISTS custom_fields (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity       text NOT NULL,
  key          text NOT NULL,
  label_ar     text NOT NULL,
  label_en     text,
  type         text NOT NULL,
  options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_required  boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  version      integer NOT NULL DEFAULT 1,
  deleted_at   timestamptz,
  deleted_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT custom_fields_entity_check CHECK (entity IN ('party', 'item', 'invoice', 'employee')),
  CONSTRAINT custom_fields_type_check CHECK (type IN ('text', 'number', 'date', 'select', 'boolean')),
  CONSTRAINT custom_fields_key_check CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT custom_fields_options_array_check CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT custom_fields_tenant_entity_key UNIQUE (tenant_id, entity, key)
);
CREATE INDEX IF NOT EXISTS custom_fields_tenant_entity_order_idx ON custom_fields(tenant_id, entity, sort_order);
CREATE INDEX IF NOT EXISTS custom_fields_tenant_active_idx ON custom_fields(tenant_id, entity, is_active);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  field_id    uuid NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  value       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  version     integer NOT NULL DEFAULT 1,
  CONSTRAINT custom_field_values_entity_check CHECK (entity_type IN ('party', 'item', 'invoice', 'employee')),
  CONSTRAINT custom_field_values_tenant_entity_field_key UNIQUE (tenant_id, entity_type, entity_id, field_id)
);
CREATE INDEX IF NOT EXISTS custom_field_values_tenant_entity_idx ON custom_field_values(tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS custom_field_values_tenant_field_idx ON custom_field_values(tenant_id, field_id);

CREATE TABLE IF NOT EXISTS custom_reports (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  base_entity text NOT NULL,
  columns     jsonb NOT NULL DEFAULT '[]'::jsonb,
  filters     jsonb NOT NULL DEFAULT '[]'::jsonb,
  chart_type  text NOT NULL DEFAULT 'table',
  is_public   boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  version     integer NOT NULL DEFAULT 1,
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT custom_reports_base_entity_check CHECK (base_entity IN ('party', 'item', 'invoice', 'employee', 'sales_invoice')),
  CONSTRAINT custom_reports_chart_type_check CHECK (chart_type IN ('table', 'bar', 'line', 'pie')),
  CONSTRAINT custom_reports_tenant_name_key UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS custom_reports_tenant_entity_idx ON custom_reports(tenant_id, base_entity, created_at);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['custom_fields', 'custom_field_values', 'custom_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

DROP POLICY IF EXISTS custom_fields_tenant_isolation ON custom_fields;
CREATE POLICY custom_fields_tenant_isolation ON custom_fields
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS custom_field_values_tenant_isolation ON custom_field_values;
CREATE POLICY custom_field_values_tenant_isolation ON custom_field_values
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM custom_fields f WHERE f.id = custom_field_values.field_id AND f.tenant_id = custom_field_values.tenant_id)
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM custom_fields f WHERE f.id = custom_field_values.field_id AND f.tenant_id = custom_field_values.tenant_id)
  );

DROP POLICY IF EXISTS custom_reports_tenant_isolation ON custom_reports;
CREATE POLICY custom_reports_tenant_isolation ON custom_reports
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_fields, custom_field_values, custom_reports TO erp_api;
GRANT ALL PRIVILEGES ON custom_fields, custom_field_values, custom_reports TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('custom_fields.manage', 'custom_fields', 'Create, update and deactivate custom fields and their values.'),
  ('custom_fields.view', 'custom_fields', 'Read custom field definitions and values.'),
  ('custom_reports.manage', 'reporting', 'Create and maintain saved custom report definitions.'),
  ('custom_reports.view', 'reporting', 'Run and read saved custom reports.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;
