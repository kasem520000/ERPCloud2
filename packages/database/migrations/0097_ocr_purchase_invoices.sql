-- 0097 — OCR purchase invoices
--
-- OCR jobs are tenant-scoped. The object itself remains in `files`; this table stores only
-- the provider-neutral result and the state machine that the maintenance worker advances.

CREATE TABLE IF NOT EXISTS ocr_jobs (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id           uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  entity_type       text NOT NULL DEFAULT 'purchase_invoice',
  status            text NOT NULL DEFAULT 'queued',
  extracted         jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence        numeric(5,4),
  provider          text,
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  processed_at      timestamptz,
  draft_invoice_id  uuid REFERENCES purchase_invoices(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT ocr_jobs_entity_type_check CHECK (entity_type IN ('purchase_invoice')),
  CONSTRAINT ocr_jobs_status_check CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  CONSTRAINT ocr_jobs_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS ocr_jobs_tenant_status_created_idx
  ON ocr_jobs(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS ocr_jobs_tenant_file_idx
  ON ocr_jobs(tenant_id, file_id);
CREATE INDEX IF NOT EXISTS ocr_jobs_tenant_entity_idx
  ON ocr_jobs(tenant_id, entity_type, draft_invoice_id);

ALTER TABLE ocr_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ocr_jobs_tenant_isolation ON ocr_jobs;
CREATE POLICY ocr_jobs_tenant_isolation ON ocr_jobs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ocr_jobs TO erp_api;
GRANT ALL PRIVILEGES ON ocr_jobs TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('purchase.ocr.use', 'purchase', 'Upload purchase invoices and review OCR extraction results.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — the application role must never bypass this policy.
ALTER ROLE erp_api NOBYPASSRLS;
