-- Phase 10 part seven — 🖨️ إعدادات الطباعة (`Form_WPF/frmSettings.xaml` «خيارات الطباعة»,
-- `Class/Print.cs`, `Reports/header.repx` · `Reports/footer.repx`).
--
-- The desktop keeps one `SettingPrint` row per `Inv_Id`, and two windows disagree about
-- what those integers mean: `frmSettings.xaml.cs` L2095-L2116 saves 0 الإفتراضي ·
-- 1 مشتريات · 2 مبيعات · 3 نقطة بيع · 4 تأجير · 5 عقود · 6 تقارير, while `frmRptKhzna`
-- L106 reads `Inv_Id=12`, `frmRptEntries` reads 9 and `frmRptRentInvoices` L541 reads 14.
-- This table keeps the meaning and drops the integers: `scope` is a name, and a report
-- may carry settings of its own under `report:<key>`.
--
-- The three images are URLs rather than the desktop's `[image]` bytes: this platform has
-- no byte store (`vessel_groups.image_url` set the precedent).

CREATE TABLE IF NOT EXISTS print_settings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope text NOT NULL,
  print_type int NOT NULL DEFAULT 1 CHECK (print_type IN (1, 2)),
  print_header boolean NOT NULL DEFAULT true,
  print_footer boolean NOT NULL DEFAULT false,
  print_stamp boolean NOT NULL DEFAULT true,
  print_item_details boolean NOT NULL DEFAULT false,
  print_item_groups boolean NOT NULL DEFAULT false,
  print_components_individually boolean NOT NULL DEFAULT false,
  print_make_pay boolean NOT NULL DEFAULT false,
  print_no int NOT NULL DEFAULT 1 CHECK (print_no BETWEEN 1 AND 50),
  print_item_type int NOT NULL DEFAULT 1,
  casher_printer text,
  kitchen_printer text,
  rpt_name text,
  rpt_url text,
  note text,
  header_image_url text,
  footer_image_url text,
  stamp_image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS print_settings_tenant_scope_key
  ON print_settings (tenant_id, scope);
CREATE INDEX IF NOT EXISTS print_settings_tenant_idx ON print_settings (tenant_id);

ALTER TABLE print_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS print_settings_tenant_isolation ON print_settings;
CREATE POLICY print_settings_tenant_isolation ON print_settings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
