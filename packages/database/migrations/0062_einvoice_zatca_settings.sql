-- Phase 11 part one — ⚙️ إعدادات الربط الضريبي - زاتكا ZATCA
-- (`Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml` + `.xaml.cs`).
--
-- The desktop keeps three singleton rows in the company database:
--
--   SettingZatca (ID=1)  → filePath · isProduction · IsActive · IsSimulation ·
--                          SyncManual · StartDate · EndDate (= StartDate + 1 year)
--   CSRProperties (Id=1) → commonName · serialNumber · organizationIdentifier ·
--                          organizationUnitName · organizationName · countryName ·
--                          invoiceType · address · industry
--   ZatcaCredential (ID=1) → CSR · PrivateKey · CSID · Secret · RequestID +
--                            P_RequestID · P_CSID · P_Secret (the production pair)
--
-- Rows keyed `ID=1` work because a desktop database is one company. This platform is
-- multi-tenant, so the singleton becomes a unique key on `(tenant_id, authority)` and every
-- column above is carried across verbatim — the CSR properties included, because they are
-- what the authority signs into the certificate.
--
-- Two additions of our own, both of them timestamps the desktop never stored: the window
-- only ever showed the *current* state, so it could not tell you when the CSR was last
-- generated or when the last compliance test ran. The checklist on `GET /einvoice/settings`
-- needs both.

CREATE TABLE IF NOT EXISTS einvoice_settings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  authority text NOT NULL DEFAULT 'zatca' CHECK (authority IN ('zatca', 'eta')),
  -- 🔵 Compliance تجريبي / 🔴 Production ربط فعلي (rdCompliance / rdProduction).
  environment text NOT NULL DEFAULT 'compliance' CHECK (environment IN ('compliance', 'production')),
  -- 🧪 Simulation تجريبي — the gateway is answered locally instead of dialled.
  simulation boolean NOT NULL DEFAULT false,
  -- ✅ تمكين Activate, flipped by ⏸ إيقاف الربط / ▶ تشغيل.
  active boolean NOT NULL DEFAULT true,
  -- Sync manual.
  sync_manual boolean NOT NULL DEFAULT false,
  -- 📅 التاريخ; the desktop wrote EndDate = StartDate + 1 year.
  start_date date NOT NULL DEFAULT CURRENT_DATE,
  end_date date NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1 year'),
  -- 📋 خصائص شهادة CSR
  common_name text NOT NULL DEFAULT '',
  serial_number text NOT NULL DEFAULT '',
  organization_identifier text NOT NULL DEFAULT '',
  organization_unit_name text NOT NULL DEFAULT '',
  organization_name text NOT NULL DEFAULT '',
  country_name text NOT NULL DEFAULT 'SA',
  invoice_type text NOT NULL DEFAULT '1100',
  address text NOT NULL DEFAULT '',
  industry text NOT NULL DEFAULT '',
  csr_generated_at timestamptz,
  compliance_csid_at timestamptz,
  production_csid_at timestamptz,
  compliance_checked_at timestamptz,
  renewed_at timestamptz,
  -- The six rows «🧪 اختبار الربط» returned the last time it ran, so the window still shows
  -- them after a reload instead of only in the message box the desktop used.
  last_compliance_check jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CONSTRAINT einvoice_settings_serial_number_check CHECK (length(serial_number) <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS einvoice_settings_tenant_authority_key
  ON einvoice_settings (tenant_id, authority);
CREATE INDEX IF NOT EXISTS einvoice_settings_tenant_idx ON einvoice_settings (tenant_id);

ALTER TABLE einvoice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoice_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS einvoice_settings_tenant_isolation ON einvoice_settings;
CREATE POLICY einvoice_settings_tenant_isolation ON einvoice_settings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The compliance pair (RequestID) and the production pair (P_RequestID · P_CSID · P_Secret),
-- which the desktop held in the same `ZatcaCredential` row next to the compliance one.
ALTER TABLE einvoice_credentials ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE einvoice_credentials ADD COLUMN IF NOT EXISTS p_request_id text;
ALTER TABLE einvoice_credentials ADD COLUMN IF NOT EXISTS p_csid_enc text;
ALTER TABLE einvoice_credentials ADD COLUMN IF NOT EXISTS p_secret_enc text;
