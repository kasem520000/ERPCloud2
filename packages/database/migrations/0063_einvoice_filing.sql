-- Phase 11 part two — 🧾 الإرسال والتوقيع والسلسلة
-- (`Desktop_ERP/SmartAuditERP/Class/ZatcaService.cs` `IntegrateInvoice`, L371-L405, and
-- `Class/InvoiceOper.cs` `SendZatca`, L2213-L2250).
--
-- What the desktop does after a filing, in one transaction with the sale:
--
--   update Inv set QRCode=@QRCode, InvoiceHash=@InvoiceHash, UUID=@UUID,
--                      ZatcaSent=@ZatcaSent where InvGlobalID=@InvGlobalID
--   insert ZatcaResponse (InvGlobalID, Message, Status)
--
-- i.e. the document's identity is written onto the invoice row, and the authority's answer
-- — its status word and its message — is kept beside it. Our `einvoice_submissions` row is
-- that `ZatcaResponse` row, and it already carried the answer inside a `jsonb` column.
-- Three things it could not do, which this migration adds as real columns:
--
--   chain_index      the invoice counter value (ICV). It was only inside `request_payload`,
--                    so the grid could not sort by it, filter on it, or show it to an
--                    auditor without parsing a JSON blob. ZATCA's whole point in the
--                    counter is that it is sequential and inspectable.
--   authority_status the authority's own word (`REPORTED` / `CLEARED`), which is exactly
--                    `ZatcaResponse.Status` — `ReportingStatus` when the invoice was
--                    reported, otherwise `ClearanceStatus` (L538-L540).
--   cleared_invoice  the re-signed document a standard invoice comes back with. The
--                    desktop overwrote `EncodedInvoice` with it and re-read the QR out of
--                    it (`ZatcaService.cs` L390-L392); it belongs on the row, next to the
--                    request that produced it, because it is the document an auditor asks
--                    for — not a diagnostic to be fished out of a response blob.
--
-- No new table, so no new policy: `einvoice_submissions` already runs with row-level
-- security enabled and forced from migration 0012, and these columns inherit it. The
-- `DO` block below re-asserts both rather than trusting the past — a table whose RLS was
-- switched off by hand is a table that leaks, and re-asserting is free.

ALTER TABLE einvoice_submissions ADD COLUMN IF NOT EXISTS chain_index integer;
ALTER TABLE einvoice_submissions ADD COLUMN IF NOT EXISTS authority_status text;
ALTER TABLE einvoice_submissions ADD COLUMN IF NOT EXISTS cleared_invoice text;

-- The grid «🧾 الفواتير المرفوعة على موقع الضرائب» pages newest-first (رقم الصفحة /
-- حجم الصفحة in `frmSentEinvoice.xaml`), which is the one query that needs help.
CREATE INDEX IF NOT EXISTS einvoice_submissions_recent_idx ON einvoice_submissions (tenant_id, created_at DESC);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE einvoice_submissions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE einvoice_submissions FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS einvoice_submissions_tenant_isolation ON einvoice_submissions';
  EXECUTE 'CREATE POLICY einvoice_submissions_tenant_isolation ON einvoice_submissions USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;
