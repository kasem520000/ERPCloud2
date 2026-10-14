-- Phase 11 part five — 💳 بوابات الدفع (جيديا · NeoLeap)
-- (`Desktop_ERP/SmartAuditERP/Class/Geidea.cs` 57 lines, `Class/NeoleapService.cs` 165 lines,
-- `Form_WPF/frmSettings.xaml` L1726-L1831 «إعدادات جيديا» + GroupBox «NeoLeap»,
-- `Form_WPF/frmSettings.xaml.cs` `BtnSaveGedia_Click` L2456 · `testGedia` L2498 ·
-- `BtnTestGedia_Click` L2513 · `Btnsavneoleap_Click` L2535 · `Btntestneoleap_Click` L4047,
-- `Form_WPF/frmPOSBill.xaml.cs` L460-L492 and `Form_WPF/frmPOSPay.xaml.cs` L428-L441).
--
-- What the desktop keeps, in two singleton rows of the company database:
--
--   GediaSetting (id=1) → IsGediaActive · GediaPort · GediaEnableReceiptPrint
--   SettingNeoleap (id=1) → IsNeoLeapActive · NeoLeapPort · NeoLeapEnableReceiptPrint ·
--                           neoleaptoken
--
-- Both are written by 💾 حفظ in «إعدادات جيديا» (a tab of `frmSettings`), and the sale
-- itself is a call the POS makes while the cashier waits: `Geidea.ConnectGeidea(Payment)`
-- writes `"<halalas>;1;1!"` to COM1 at 38400 baud and reads a five-byte answer whose
-- first three characters must be one of 000 · 001 · 003 · 007 · 087 · 089, otherwise the
-- desktop stops the save with «العملية مرفوضة، يرجى إعادة الدفع». `NeoleapService` is the
-- same idea over the `neoleapconnector` library: it posts a `SALE` request
-- (`requestType` · `merchantToken` · `amount` · `ecrRef` · `ecrToken` · `printFlag` ·
-- `cashBack`) and reads `ErrorMsg` / `TransactionResult.StatusCode` back — 00 Approved ·
-- 01 Declined · 02 Cancelled or Error.
--
-- Neither row survives the move unchanged, for one reason: **the desktop never recorded a
-- card transaction at all.** It printed a receipt and let the invoice's payment method say
-- شبكة or ATM. A server cannot print to a cashier's printer and must not keep money
-- movement only in a browser tab, so this migration adds the log the desktop never had
-- (`payment_gateway_transactions`) beside the settings it did have
-- (`payment_gateway_settings`):
--
--   - `reference` is the desktop's `ecrRef` — a GUID the caller invents, which makes a
--     double-tap on 💳 a *duplicate*, not a double charge (unique per tenant+provider);
--   - `sandbox` (🧪 Simulation) keeps every test, every CI run and every demo off a live
--     acquirer, exactly as `einvoice_settings.simulation` does for ZATCA;
--   - `raw_response` is the gateway's own answer, because a declined card is argued about
--     later and the argument is settled with the bank's words, not ours.
--
-- Two columns are ours, not the desktop's, and both are forced by the platform:
--   `base_url`   the desktop dialled a COM port or a socket on the till; a server dials a
--                URL. ما كان «المنفذ» يبقى المنفذ, and the host around it is config.
--   `callback_url` Geidea's hosted page needs somewhere to post the result; the desktop
--                got its answer synchronously and needed none.

CREATE TABLE IF NOT EXISTS payment_gateway_settings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- جيديا · NeoLeap — the two providers «إعدادات جيديا» configures.
  provider text NOT NULL CHECK (provider IN ('geidea', 'neoleap')),
  -- تفعيل الدفع عن طريق جيديا / تفعيل NeoLeap.
  active boolean NOT NULL DEFAULT false,
  -- طباعة ايصال / طباعة إيصال NeoLeap (NeoleapService sends it as printFlag 1/0).
  print_receipt boolean NOT NULL DEFAULT false,
  -- المنفذ — the desktop's GediaPort / NeoLeapPort.
  port integer,
  -- Where the gateway is dialled. Defaults are the providers' own published hosts.
  base_url text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'SAR',
  -- Geidea merchant public key (not a secret — it travels in Basic auth) · NeoLeap
  -- tranportal id.
  merchant_key text NOT NULL DEFAULT '',
  -- Geidea API password · NeoLeap merchant token — encrypted at rest with the same
  -- `v1:iv:tag:data` envelope `einvoice_credentials` uses.
  merchant_secret_enc text,
  -- Geidea's callbackUrl; the desktop had no equivalent.
  callback_url text NOT NULL DEFAULT '',
  -- 🧪 Simulation — the gateway is answered locally instead of dialled.
  simulation boolean NOT NULL DEFAULT true,
  -- «Logging»: the last 🧪 TEST / 🧪 Test, so the window still shows it after a reload.
  last_test jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CONSTRAINT payment_gateway_settings_port_check CHECK (port IS NULL OR (port >= 0 AND port <= 65535))
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_gateway_settings_tenant_provider_key
  ON payment_gateway_settings (tenant_id, provider);
CREATE INDEX IF NOT EXISTS payment_gateway_settings_tenant_idx ON payment_gateway_settings (tenant_id);

ALTER TABLE payment_gateway_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_gateway_settings_tenant_isolation ON payment_gateway_settings;
CREATE POLICY payment_gateway_settings_tenant_isolation ON payment_gateway_settings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS payment_gateway_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('geidea', 'neoleap')),
  -- The desktop's ecrRef (`NeoleapService.ProcessSale` L32) · Geidea merchantReferenceId.
  reference text NOT NULL,
  -- Geidea session.id / orderId · NeoLeap uuid.
  session_id text,
  invoice_id uuid,
  branch_id uuid,
  amount numeric(20, 4) NOT NULL,
  currency text NOT NULL DEFAULT 'SAR',
  -- initiated — the cardholder is still on the gateway page · approved · declined ·
  -- cancelled · unknown — the gateway answered in a code we do not read · error — we
  -- never reached it.
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'approved', 'declined', 'cancelled', 'unknown', 'error')),
  -- Geidea responseCode / detailedResponseCode · NeoLeap TransactionResult.StatusCode.
  response_code text,
  detailed_response_code text,
  -- responseMessage · detailedResponseMessage · Approved / Declined / Cancelled or Error.
  message text,
  -- The receipt fields the desktop read out of `TransactionResult`.
  approval_code text,
  rrn text,
  stan text,
  card_scheme text,
  pan_masked text,
  transaction_type text,
  -- Geidea's hosted page (`.../hpp/checkout/?<sessionId>`), for the cashier to open.
  checkout_url text,
  raw_response jsonb,
  simulation boolean NOT NULL DEFAULT false,
  -- True once the approved amount was recorded on the invoice.
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

-- Idempotency: the same ecrRef twice is one sale, not two.
CREATE UNIQUE INDEX IF NOT EXISTS payment_gateway_transactions_reference_key
  ON payment_gateway_transactions (tenant_id, provider, reference);
CREATE INDEX IF NOT EXISTS payment_gateway_transactions_recent_idx
  ON payment_gateway_transactions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_gateway_transactions_invoice_idx
  ON payment_gateway_transactions (tenant_id, invoice_id);

ALTER TABLE payment_gateway_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_gateway_transactions_tenant_isolation ON payment_gateway_transactions;
CREATE POLICY payment_gateway_transactions_tenant_isolation ON payment_gateway_transactions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
