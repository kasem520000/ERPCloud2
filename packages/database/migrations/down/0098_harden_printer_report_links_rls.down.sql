-- 0098 down — restore the previous printer/report-link policy definition.
DROP POLICY IF EXISTS printer_report_links_tenant_isolation ON printer_report_links;
CREATE POLICY printer_report_links_tenant_isolation ON printer_report_links
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
