# E-invoicing module

Saudi (ZATCA) e-invoicing, plus the placeholder boundary for Egypt's ETA.

## What actually happens when an invoice is submitted

`POST /sales-invoices/:id/einvoice/submit` (permission `einvoice.submit`) on a **posted**
invoice:

1. **Builds the document.** `zatca/ubl.ts` produces a UBL 2.1 `Invoice` from the real
   invoice: seller party from `company_profiles` (VAT number, CR number, national address),
   buyer party from `parties`, one `cac:InvoiceLine` per line with its own tax category, one
   `cac:TaxSubtotal` per VAT rate, and a `cac:LegalMonetaryTotal` whose arithmetic closes.
   `cbc:InvoiceTypeCode` is `388` for a sale and `381` for a credit note; its `name` attribute
   is `0100000` when the buyer has a VAT number (standard/B2B) and `0200000` otherwise
   (simplified/B2C).
2. **Chains it.** `einvoice_chain` hands out the previous invoice's hash (PIH — the genesis
   value is base64 SHA-256 of `"0"`) and the next invoice counter (ICV) under `FOR UPDATE`,
   so two invoices filed at the same instant cannot share a counter. Both are embedded in the
   document as `cac:AdditionalDocumentReference` entries.
3. **Hashes it.** `hashInvoiceXml` — base64 of the SHA-256 digest of the XML.
4. **Signs it, if it can.** When the tenant has uploaded an EC private key
   (`PUT /einvoice/credentials`), the hash is signed with ECDSA/SHA-256 and the public key is
   exported in DER. A key that is missing, malformed or not EC produces no signature and a
   logged warning — never a fake one.
5. **Builds the QR.** TLV, base64: tags 1–5 (seller name, VAT number, timestamp, total with
   VAT, VAT amount) always; tags 6–8 (hash, signature, public key) only when step 4 succeeded.
6. **Files it, if the tenant is linked.** The gateway and the credential pair come from the
   link saved in «⚙️ إعدادات الربط الضريبي» (`einvoice_settings`), not from the request: 🧪
   Simulation answers locally, 🔵 Compliance dials the sandbox and 🔴 Production dials the
   core host (`ZATCA_API_BASE_URL` overrides both). A standard invoice (`0100000`) is sent to
   `/invoices/clearance/single` with `Clearance-Status: 1` and comes back **re-signed**, and
   that document — not ours — is what is stored, with the QR read out of it; a simplified one
   (`0200000`) goes to `/invoices/reporting/single` and keeps the QR we computed. Both carry
   `Accept-Version: V2` and basic auth. A caller may override the environment per filing
   (`{ "environment": "simulation" }`); nothing else about the document changes.

## The submission states, and why they are not all "reported"

| status | meaning |
|---|---|
| `prepared` | The compliant document exists, is hashed and chained, and carries a valid phase-1 QR. Nothing was sent, because the tenant has not uploaded credentials. |
| `signed` | Same, plus a real signature and phase-2 QR tags. Waiting for a gateway URL. |
| `reported` / `cleared` | The authority answered `2xx`. The response body is stored, and `authority_status` carries its own word (`REPORTED` / `CLEARED`). `cleared` also stores the re-signed document in `cleared_invoice`. |
| `failed` | The authority answered an error, or the call could not be made. `error` says which. |

An accepted invoice is never filed twice: a second `POST` on the same invoice, or a retry of a
submission already accepted, is `409 EINVOICE_ALREADY_ACCEPTED`. A filing that stops short —
⏸ إيقاف الربط, or no CSID to authenticate with — keeps the status it earned (`signed`) and
records the reason (`LINK_PAUSED`, `NO_GATEWAY_CONFIGURED`, `NO_CREDENTIALS`) on `response`.

An invoice is never marked as accepted by an authority the system never spoke to. This is the
one thing a compliance feature must not lie about, and it is why `prepared` exists at all.

## What is still missing for full phase-2 certification

- **The XAdES enveloped signature and `UBLExtensions` block.** The signature bytes are
  produced, but wrapping them in the `ds:Signature`/`xades:QualifyingProperties` structure and
  canonicalising (C14N 1.1, excluding the signature, QR and extension nodes) is not
  implemented. Our generator never writes those three nodes, so the document as produced *is*
  its own hashed form; the canonicaliser has to strip them once they exist.
- **The XAdES signature is not wrapped** (see the bullet above); onboarding, by contrast, is
  no longer missing — see the next section.
- **Certificate tag 9** (the CA's signature over the certificate public key) is only available
  from the issued certificate, so it is emitted once the certificate itself is stored.

Everything above is credential-bound, not code-bound: no ZATCA sandbox account can be created
from inside this repository's CI.

## Phase 11 part one — ⚙️ إعدادات الربط الضريبي (`frmZatcaSetting`)

The window the customer used to do onboarding **on their own device and paste the result back**
is now a first-class part of the API. Everything below is ported from
`Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml(.cs)`; the full rule-by-rule account
is in `docs/desktop-parity/PHASE_11_EINVOICING.md` §4.

| step | button | endpoint | permission |
|---|---|---|---|
| read the window | — | `GET /einvoice/settings` | `einvoice.view` |
| 💾 حفظ الإعدادات | Save Settings | `PUT /einvoice/settings` | `einvoice.manage` |
| 🔄 تعبئة تلقائي | fill from بطاقة المنشأة | `POST /einvoice/settings/fill-from-company` | `einvoice.manage` |
| ⚡ توليد | Generate | `POST /einvoice/csr/generate` | `einvoice.credentials.manage` |
| 🔵 compliance CSID | needs the 🔑 OTP | `POST /einvoice/onboarding/compliance-csid` | `einvoice.credentials.manage` |
| 🔐 حفظ مفتاح التشفير | Get PCSID | `POST /einvoice/onboarding/production-csid` | `einvoice.credentials.manage` |
| 🧪 اختبار الربط | Test Compliance | `POST /einvoice/onboarding/compliance-check` | `einvoice.credentials.manage` |
| 🔄 Renews CSID | تجديد الشهادة بعد 5 سنوات | `POST /einvoice/onboarding/renew` | `einvoice.credentials.manage` |
| ⏸ إيقاف الربط / ▶ تشغيل | the link switch | `POST /einvoice/link/toggle` | `einvoice.manage` |

Three rules worth knowing before you touch this code:

- **A new CSR revokes the issued CSIDs.** A certificate is bound to the key that requested it,
  so generating again clears both pairs — the desktop does the same with
  `DELETE FROM ZatcaCredential`.
- **The order is enforced, in the desktop's own words.** No production CSID without a
  compliance one, no compliance CSID without a CSR, no compliance check without both, and the
  link cannot be switched off before it is configured.
- **The gateway has three modes.** 🧪 Simulation answers locally (deterministically, so tests
  and re-runs agree), 🔵 Compliance dials the sandbox, 🔴 Production dials the core host.
  An unreachable or refusing gateway is a `502 EINVOICE_GATEWAY_UNREACHABLE`, never a 500.

## Phase 11 part two — 🧾 الإرسال والتوقيع والسلسلة (`ZatcaService.IntegrateInvoice`)

The second half of the desktop's filing path is now wired: the document was always built,
chained and signed here, but the authority round-trip was one branch behind an environment
variable. It is now a first-class step, ported from
`Class/ZatcaService.cs` `IntegrateInvoice` (L371-L405) and `Class/InvoiceOper.cs` `SendZatca`
(L2213-L2250), in `zatca/filing.ts`:

| the desktop | here |
|---|---|
| `CallReportingAPI(..., isSimplified: false)` for `0100000` | `gateway.clearInvoice()` → `POST /invoices/clearance/single` (`Clearance-Status: 1`) |
| `CallReportingAPI(..., isSimplified: true)` for `0200000` | `gateway.reportInvoice()` → `POST /invoices/reporting/single` |
| `invoice.EncodedInvoice = response.ClearedInvoice` | `cleared_invoice` + `request_payload.clearedXml` |
| `GetEncodedInvoiceQRCode(EncodedInvoice)` | `qrFromClearedInvoice()` — the QR is read out of the cleared XML |
| `update Inv set QRCode=…, InvoiceHash=…, UUID=…, ZatcaSent=…` | `sales_invoices.zatca_qr / zatca_hash / zatca_uuid / zatca_status` |
| `insert ZatcaResponse (InvGlobalID, Message, Status)` | the submission row: `authority_status`, `response.errorMessages`, `error` |

Endpoints (all tenant-scoped, all real):

| endpoint | permission | what it is |
|---|---|---|
| `GET /einvoice/filings?pageNo&pageSize&status&from&to` | `einvoice.view` | 🧾 الفواتير المرفوعة — the paged grid, newest first, joined to the invoice (رقم الفاتورة · العميل · الفرع · المستخدم) |
| `GET /einvoice/filings/:id` | `einvoice.view` | 📄 بيانات الفاتورة — the document, the cleared document, the QR decoded into tags, and the chain slot |
| `GET /einvoice/chain` | `einvoice.view` | the last hash filed and the counter that follows it |
| `POST /sales-invoices/:id/einvoice/submit` | `einvoice.submit` | builds, signs and files — following the saved link unless the body overrides the environment |
| `POST /einvoice/submissions/:id/retry` | `einvoice.submit` | 🔁 إعادة الإرسال — re-files the stored document; the hash never moves |

Four rules worth knowing before you touch this code:

- **A filing that throws is a failed filing, not a failed sale.** No network, a refused TLS
  handshake, a 503: the document is already stored, so the error is written onto the submission
  and the caller gets a `201` with `status: failed`.
- **A cleared invoice's QR belongs to the authority.** It is read out of the returned document;
  the one we computed locally is discarded.
- **The document is checked before it is dialled.** `inspectInvoiceXml()` closes the monetary
  arithmetic and refuses a filing the authority would reject anyway; a seller VAT number that is
  not shaped like a Saudi one is a warning, never a block.
- **`cbc:PrepaidAmount` is always `0.00`.** The desktop's document model has no prepayment
  field, and declaring the till's cash as a prepayment would force `PayableAmount` to zero.

## Phase 11 part three — 📊 حالة المزامنة (`frmInvsSyncStatusZatca`)

The window that answers «which of these invoices did ZATCA take?» is now a registered
report (`einvoice-sync-status`, in `modules/reporting/report-catalog.ts`) plus one action
endpoint. Registering it is what makes 🖨️ طباعة, 👁️ معاينة and 📊 تصدير Excel the same
engine every `frmRpt*` window uses — the desktop prints `Reports/rptInvSumByClient.repx`,
and the exported workbook is now a real one instead of the CSV the desktop writes behind
that label.

| endpoint | permission | what it is |
|---|---|---|
| `GET /reports/einvoice-sync-status?status&kind&from&to&branchId` | `reporting.view` | the grid: every posted invoice with ✅ مرسل / ❌ لم يُرسل, the authority's «الرسالة», and the summary cards |
| `POST /einvoice/sync` | `einvoice.submit` | 🔄 مزامنة ZATCA — files the invoices the clerk ticked, one by one, and reports what happened to each |

What `POST /einvoice/sync` answers:

| outcome | when |
|---|---|
| `sent` | the authority accepted it (`reported` or `cleared`) |
| `failed` | it was dialled and refused — the message is the authority's own |
| `skipped` | a draft, an invoice the authority already has, or ⏸ إيقاف الربط — with the reason |

`message` is «تمت العملية بنجاح ✅», the desktop's own line, when every selected row was
accepted, and the count of what was not otherwise.

Reading the grid is `reporting.view` because the grid *is* a report; filing is
`einvoice.submit`; producing the file is `reporting.export.execute`. Three separate
permissions, because three different people press those buttons.

## Runbook

1. Fill in بطاقة المنشأة — a missing VAT number makes every document invalid.
2. Complete onboarding in الإعدادات ← إعدادات الربط مع هيئة الزكاة والضريبة: 🔄 تعبئة تلقائي
   fills the CSR properties from بطاقة المنشأة, ⚡ توليد mints the key and the PKCS#10 request
   (the private key is shown **once**), 🔵 issues the compliance CSID with the OTP, 🔐 exchanges
   it for the production CSID, then 🧪 اختبار الربط proves the six documents. Everything is
   stored encrypted (AES-256-GCM) and read back masked. `PUT /einvoice/credentials` still works
   for a tenant that prefers to paste its own grant.
3. Choose the link in الإعدادات ← إعدادات الربط مع هيئة الزكاة والضريبة: 🧪 Simulation تجريبي
   answers locally and is the only mode that needs no network; otherwise 🔵 Compliance dials the
   sandbox and 🔴 Production the core host, and `ZATCA_API_BASE_URL` overrides the host for
   both. ⏸ إيقاف الربط stops filings without touching the link's configuration.
4. Post invoices normally; posting is never blocked by e-invoicing.
5. Watch الإعدادات ← إعدادات الربط مع هيئة الزكاة والضريبة ← الفواتير المرفوعة على موقع
   الضرائب (`GET /einvoice/filings`), or الإعدادات ← المزامنة ← Zatca
   (`GET /einvoice/submissions`), and retry failures there. Retry re-files the stored document;
   it never rebuilds it, because the hash may not move.
6. `node scripts/verify-einvoice-zatca-filing.mjs` drives the whole path against a running
   stack — sign, clear, report, chain, credit note, pause, retry, paging, permissions — through
   the 🧪 simulator, and restores what it changed.
7. 🔄 مزامنة الفواتير - ZATCA (`/settings/zatca/status`) is where a day's work is swept up:
   filter by ❌ غير مرسل, tick what should have gone, press 🔄 مزامنة ZATCA. Unsent invoices
   are the ones the authority does not have — a failed filing is a stored document waiting
   for 🔁 إعادة الإرسال, and a skipped one never left the building.

Egypt ETA keeps the same adapter boundary and returns an explicit `501 ETA_NOT_IMPLEMENTED`
until certification scope is approved.
