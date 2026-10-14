-- R17 — 📑 ربط الطابعات بالتقارير (`PrinterSettings` L2163-L2180)
-- Desktop_ERP: [Inv_Id] int, [PrintName] nvarchar(50), [Printer] nvarchar(50), [RptUrl] nvarchar(max), [RptName] nvarchar(50)
-- Cloud: scope text (same vocabulary as print_settings: default, purchases, sales, pos, rental, contracts, reports, report:<key>)
-- + print_name (PrintName), printer_name (Printer), rpt_url, rpt_name

CREATE TABLE IF NOT EXISTS printer_report_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope text NOT NULL,
  print_name text NOT NULL,
  printer_name text NOT NULL,
  rpt_url text,
  rpt_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS printer_report_links_tenant_scope_idx ON printer_report_links (tenant_id, scope);
CREATE INDEX IF NOT EXISTS printer_report_links_tenant_idx ON printer_report_links (tenant_id);

ALTER TABLE printer_report_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE printer_report_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS printer_report_links_tenant_isolation ON printer_report_links;
CREATE POLICY printer_report_links_tenant_isolation ON printer_report_links
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
