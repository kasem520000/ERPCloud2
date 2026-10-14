-- 0098 — harden the printer/report-link tenant policy against an empty pooled GUC.
-- Migration 0095 used a direct cast of current_setting(...), which raises when a pooled
-- connection carries the transaction-local empty value. Keep the policy aligned with the
-- canonical tenant-isolation expression used by the rest of the schema.

ALTER TABLE printer_report_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE printer_report_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS printer_report_links_tenant_isolation ON printer_report_links;
CREATE POLICY printer_report_links_tenant_isolation ON printer_report_links
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
