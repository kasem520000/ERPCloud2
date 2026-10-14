# WhatsApp integration — 📱 إرسال الفاتورة عبر واتساب

Sending a sales invoice to its customer over WhatsApp: the «💬 واتساب» menu item of
`Desktop_ERP/SmartAuditERP/Form_WPF/frmInvSale.xaml` L1190, handled by
`SendWhatsapp_Click` → `printwhatsapp` (`frmInvSale.xaml.cs` L3124-L3199), behind
`Class/WhatsAppSender.cs` (267) and `Class/Session.cs` (L12-L31).

The desktop did it **inside the cashier's browser**: `WhatsAppSender` drives a Chrome
window over a persistent profile (`%LocalAppData%\MyApp\chrome-profile`, L43-L48), which
means somebody had to have scanned the QR code (`InitializeWhatsAppAsync`, L66); it waits
twenty-five seconds for the chat to open (L119-L142), types the greeting (L151-L153),
hands the exported PDF to `input[type='file']` (L188) — and records **nothing**. The
result was a message box that the next click erased.

A server has no browser, no QR code and no cashier, so:
- *which number am I* is a setting (`phone_number_id` + a sealed `access_token`) instead of
  a Chrome profile;
- *which country do my customers dial from* is a setting (`default_country_code`) instead
  of the hard-coded `966`;
- *did it arrive* is a row (`whatsapp_messages`) instead of a message box.

## What is ported from where

| `Desktop_ERP` | here |
| --- | --- |
| `frmInvSale.xaml` L1190 `<MenuItem x:Name="SendWhatsapp" Header="💬 واتساب" …>` | `POST /whatsapp/send`, and the «💬 واتساب» card on the invoice window |
| `frmInvSale.xaml.cs` L3132-L3139 «لا يمكن إرسال الفاتورة قبل الحفظ» | `409 SALES_INVOICE_NOT_POSTED` — «لا يمكن إرسال الفاتورة قبل ترحيلها — رحّلها أولاً.» |
| L3143-L3145 `print.RptName = "rptPOSA4.repx"` (or `rptPricingInv.repx` when `ProcType == 4`) + `ExportToPdf` | `invoiceSheet()` → `فاتورة-INV<no>.txt` (see *The attachment*) |
| L3152 `SELECT name, mobile FROM Customers WHERE id=…` | `parties.phone`, or `salesInvoices.cash_customer_mobile` for a cash sale |
| L3161 «❌ لا يوجد رقم جوال للعميل» | `422 WHATSAPP_PHONE_MISSING` — the same words |
| L3166 `invRef = "INV" + txtNo.Text` | `INV<invoice.number>` — the number exists once the invoice is posted |
| L3180 `Common.FoundationInfoDT.Rows[0]["nameA"]` | `companyProfiles.nameAr` |
| L3182-L3183 `🧾 مرحباً {custName}، هذه فاتورتك رقم {invRef} من {foundName}` | the same string, character for character |
| `Class/WhatsAppSender.cs` L113-L116 `if (!text.StartsWith("966")) text = "966" + text.TrimStart('0');` | `normalizePhone(raw, defaultCountryCode)` |
| L151-L153 text first, L188 the file | text first, then `POST /{phone-number-id}/media`, then the document message |
| L142 «❌ الرقم غير مرتبط بحساب WhatsApp أو لم يتم تحميل المحادثة.» | a `failed` row with that message; in 🧪 Simulation a number ending `0000` asks for it |
| `Class/Session.cs` L12-L31 `EnsureWhatsAppSessionAsync` (re-init on an invalid session) | 🧪 اختبار — `GET /{phone-number-id}`: is this number ours and is this token good for it? |

## The Cloud API, as published

Graph `v21.0` on `https://graph.facebook.com`, `AbortSignal.timeout(20_000)` on every
call, and Meta's own `error.message` + `error.code` surfaced verbatim:

| call | endpoint |
| --- | --- |
| text message | `POST /{phone-number-id}/messages` (`type: 'text'`) |
| upload the sheet | `POST /{phone-number-id}/media` (multipart, `messaging_product=whatsapp`; the media lives 30 days) |
| document message | `POST /{phone-number-id}/messages` (`type: 'document'` with the `media.id`) |
| 🧪 اختبار | `GET /{phone-number-id}` → `display_phone_number` · `verified_name` |

## The attachment

The desktop exported a DevExpress `.repx` to PDF in the application folder. There is **no
PDF library in this repository**, and rendering Arabic server-side would mean shipping an
Arabic-shaping font — the reason `reporting.service.ts` already answers a "pdf" export with
a print-ready HTML page for the browser to print. So the sheet is UTF-8 `text/plain` named
`فاتورة-INV<no>.txt`, which is a document type WhatsApp accepts. The door is open: when a
server-side PDF exists, `invoiceSheet()` is the one function to replace.

## 🧪 Simulation

`whatsapp_settings.simulation` is **on by default**, like
`einvoice_settings.simulation` and `payment_gateway_settings.simulation`: no number is
dialled and no message leaves the machine. It answers locally and stably — ids are
`wamid.SIM-<sha1>` and `SIM-MEDIA-<sha1>`, so a repeated send is assertable — and one rule
lets a test ask for a failure: a number ending `0000` is not on WhatsApp
(`SIMULATION_UNDELIVERABLE_SUFFIX`), which records the desktop's own sentence.

## Endpoints

| method | path | permission | what |
| --- | --- | --- | --- |
| `GET` | `/whatsapp/settings` | `tenant.settings.manage` | ⚙️ الإعدادات, token masked |
| `PUT` | `/whatsapp/settings` | `tenant.settings.manage` | 💾 حفظ |
| `POST` | `/whatsapp/test` | `tenant.settings.manage` | 🧪 اختبار, answer kept in `last_test` («Logging») |
| `POST` | `/whatsapp/send` | `sales.view` | 💬 واتساب — whoever may open the invoice window |
| `GET` | `/whatsapp/messages` | `sales.view` | 📜 السجل: `?status=` · `?invoiceId=` · `?limit=` |

Two permissions for two different jobs, and neither is new: `tenant.settings.manage`
decides *where the messages come from*, `sales.view` decides *who may send an invoice* —
exactly who may open the window the desktop's menu item lived in.

## Refusals, in the desktop's words where it had any

| code | status | when |
| --- | --- | --- |
| `WHATSAPP_NOT_CONFIGURED` | 404 | the tenant never saved a settings row |
| `WHATSAPP_DISABLED` | 409 | «الرجاء تفعيل الإرسال عبر واتساب.» |
| `SALES_INVOICE_NOT_POSTED` | 409 | «لا يمكن إرسال الفاتورة قبل ترحيلها — رحّلها أولاً.» |
| `WHATSAPP_PHONE_MISSING` | 422 | «❌ لا يوجد رقم جوال للعميل» |
| `WHATSAPP_PHONE_INVALID` | 422 | a number was given and it makes no sense |
| `SECRET_DECRYPT_FAILED` | 500 | the stored token cannot be opened — save it again |

## Security

- Both tables run with `ENABLE` + `FORCE` row-level security and a `tenant_id` policy
  (migration `0065`), like every tenant-scoped table in the platform.
- The access token is encrypted at rest with the same `v1:iv:tag:data` AES-256-GCM
  envelope as `einvoice_credentials` and the payment gateways, and is only ever returned
  masked (`****0001`).
- A failure to open it is reported as `SECRET_DECRYPT_FAILED`, never as a generic error.

## Tests and live verification

- `apps/api/test/whatsapp-invoice.spec.ts` — 17 tests (defaults, 💾 حفظ and the masked
  token, 🧪 اختبار and its Logging, the greeting and the normalised number, 📎 with and
  without the sheet, the number that is not on WhatsApp, the five refusals, a custom
  message, the log's order and filters, RBAC, tenant isolation, `normalizePhone`).
- `scripts/verify-whatsapp.mjs` — 71 live checks against a running stack in eleven
  sections; it snapshots the settings row and restores it at the end, and never turns
  🧪 محاكاة off.
