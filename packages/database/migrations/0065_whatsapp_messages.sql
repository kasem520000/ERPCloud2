-- Phase 11 part six — 📱 إرسال الفاتورة عبر واتساب
-- (`Desktop_ERP/SmartAuditERP/Class/WhatsAppSender.cs` 267 lines, `Class/Session.cs` L12-L31,
-- `Form_WPF/frmInvSale.xaml` L1190 «💬 واتساب» and `frmInvSale.xaml.cs` L3130-L3195.)
--
-- What the desktop does when the cashier clicks 💬 واتساب on a saved sale invoice:
--
--   Session.EnsureWhatsAppSessionAsync()        → a Chrome process driven by Selenium
--   WhatsAppSender.InitializeWhatsAppAsync()    → web.whatsapp.com, wait for «Scan me!»
--   print.RptExportToPdf("فاتورة_INV<no>.pdf")  → DevExpress renders the invoice sheet
--   waSender.SendInvoiceAsync(mobile, pdfPath,  → https://web.whatsapp.com/send?phone=…
--       "🧾 مرحباً {custName}، هذه فاتورتك رقم {invRef} من {foundName}")
--
-- i.e. the desktop's "integration" is a browser on the cashier's own machine: no account,
-- no credential, no record. Three things follow from that, and they are why this migration
-- adds two tables rather than none:
--
--   1. A server has no Chrome and no QR code to scan, so the transport is Meta's WhatsApp
--      Cloud API — and that needs the two things the desktop never had: a phone number id
--      and an access token. They are tenant configuration (`whatsapp_settings`), and the
--      token is encrypted with the same envelope as every other secret in this platform.
--   2. The desktop kept **no** record of what it sent. A message that leaves a server is a
--      message someone will ask about — «هل وصلت فاتورة العميل؟» — so every send is written
--      down (`whatsapp_messages`) with the number, the words, the attachment and the
--      provider's own message id.
--   3. The number itself is normalised the way the desktop normalised it (L113-L116):
--      anything that does not already start with 966 loses its leading zero and gains it.
--      The rule is stored rather than hard-coded, because a Yemeni or Emirati tenant is not
--      a hypothetical.
--
-- Two columns are ours by necessity, not by choice, and both are recorded in the spec:
--   `attach_document`  the desktop always attached the PDF; a server here cannot render one
--                      (Arabic shaping would mean shipping a font — a decision already made
--                      in `reporting.service.ts`, where a "pdf" export returns a print-ready
--                      HTML page for the *browser* to print). The sheet therefore travels as
--                      UTF-8 text, and the switch lets a tenant send the greeting alone.
--   `simulation`       🧪 — no tenant's real number is ever dialled by a test, a demo or CI.

CREATE TABLE IF NOT EXISTS whatsapp_settings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- تفعيل — the switch «💬 واتساب» cannot work without.
  active boolean NOT NULL DEFAULT false,
  -- Cloud API `{phone-number-id}` of the WhatsApp Business number sending the messages.
  phone_number_id text NOT NULL DEFAULT '',
  -- Cloud API access token — encrypted at rest (`v1:iv:tag:data`, AES-256-GCM).
  access_token_enc text,
  -- The desktop hard-coded "966" (`WhatsAppSender.cs` L113-L116); here it is a setting.
  default_country_code text NOT NULL DEFAULT '966',
  -- 📎 — attach the invoice sheet to the message.
  attach_document boolean NOT NULL DEFAULT true,
  -- 🧪 Simulation — the message is answered locally instead of dialled.
  simulation boolean NOT NULL DEFAULT true,
  -- The last 🧪 اختبار, so the window still shows it after a reload.
  last_test jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CONSTRAINT whatsapp_settings_country_code_check CHECK (default_country_code ~ '^[0-9]{1,4}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_settings_tenant_key ON whatsapp_settings (tenant_id);

ALTER TABLE whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_settings_tenant_isolation ON whatsapp_settings;
CREATE POLICY whatsapp_settings_tenant_isolation ON whatsapp_settings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid,
  party_id uuid,
  -- The number as it was dialled: country code and all, no `+`.
  phone text NOT NULL,
  -- The words that went out — the desktop's greeting line, or what the caller asked for.
  message text NOT NULL,
  -- 📎 «فاتورة-INV123.txt», or null when the greeting went alone.
  attachment_name text,
  -- `none` — no attachment · `sent` — it went with the message · `failed` — it did not.
  attachment_status text NOT NULL DEFAULT 'none'
    CHECK (attachment_status IN ('none', 'sent', 'failed')),
  -- sent · failed — the provider refused it · skipped — we never dialled.
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'skipped')),
  -- The provider's own `messages[0].id`, the handle a delivery dispute starts from.
  provider_message_id text,
  -- The id of the 📎 document message, when one went out beside the greeting.
  attachment_message_id text,
  error text,
  simulation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_recent_idx ON whatsapp_messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_invoice_idx ON whatsapp_messages (tenant_id, invoice_id);

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_messages_tenant_isolation ON whatsapp_messages;
CREATE POLICY whatsapp_messages_tenant_isolation ON whatsapp_messages
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
