# Payments module — 💳 بوابات الدفع

Card payment through a gateway: **جيديا (Geidea)** and **NeoLeap**, the two providers of
`Desktop_ERP/SmartAuditERP/Form_WPF/frmSettings.xaml` L1726-L1831 — the tab «إعدادات جيديا»
and the GroupBox «NeoLeap» inside it.

The desktop charged a card inside the POS save (`frmPOSBill.xaml.cs` L460-L492,
`frmPOSPay.xaml.cs` L428-L441) and kept **nothing**: it printed a receipt and let the
invoice's payment method say شبكة or ATM. A server cannot print to a till and must not keep
money movement in a browser tab, so this module keeps the desktop's two settings rows and
adds the log it never had.

## What is ported from where

| `Desktop_ERP` | here |
| --- | --- |
| `GediaSetting (id=1)` → `IsGediaActive` · `GediaPort` · `GediaEnableReceiptPrint` (written by `BtnSaveGedia_Click`, `frmSettings.xaml.cs` L2456) | `payment_gateway_settings` row `provider='geidea'` |
| `SettingNeoleap (id=1)` → `IsNeoLeapActive` · `NeoLeapPort` · `NeoLeapEnableReceiptPrint` · `neoleaptoken` (`Btnsavneoleap_Click` L2535) | `payment_gateway_settings` row `provider='neoleap'` |
| `Class/Geidea.cs` `ConnectGeidea` (L16-L56) — `"<halalas>;1;1!"` to **COM1 at 38400 baud** through `madaapi.dll`, answer read from five bytes | `gateways/geidea.ts` — the provider's own HTTP calls (below) |
| the six accepted codes `000 · 001 · 003 · 007 · 087 · 089`, else «العملية مرفوضة، يرجى إعادة الدفع» (`frmPOSBill.xaml.cs` L471-L475) | Geidea `responseCode` / `detailedResponseCode`: `000` is success, anything else is an error |
| `Class/NeoleapService.cs` `ProcessSale` (L23-L36) — `requestType` · `merchantToken` · `amount` · `ecrRef` · `ecrToken` · `printFlag` · `cashBack` | `gateways/neoleap.ts` — the same JSON, over HTTP |
| `NeoleapService.ParseResponse` (L85-L163) — `ErrorMsg`, then `TransactionResult.StatusCode` `00` Approved · `01` Declined · `02` Cancelled or Error · default Unknown Status, plus `uuid` · `Amount.PurchaseAmount` · `ApprovalCode` · `RRN` · `STAN` · `CardScheme.English` · `PAN` · `TransactionType.English` | the same mapping and the same words |
| 🧪 TEST (`BtnTestGedia_Click` L2513) / 🧪 Test (`Btntestneoleap_Click` L4047), the latter with the hard-coded test token and 0.50 (L61-L62) | `POST /payment-gateways/:provider/test`, answer kept in `last_test` («Logging») |
| «المنفذ» (`txtportneoleap`, L2577) | `base_url`, defaulting to `http://127.0.0.1:<port>` for NeoLeap |

## The two providers

**جيديا** — the published Geidea API (https://docs.geidea.net), KSA host
`https://api.ksamerchant.geidea.net`:

| call | endpoint |
| --- | --- |
| open a session | `POST /payment-intent/api/v2/direct/session` (Basic `merchantPublicKey:apiPassword`) |
| ask how it ended | `GET /pgw/api/v1/direct/order?MerchantReferenceId=…` |
| the cardholder's page | `https://www.ksamerchant.geidea.net/hpp/checkout/?<sessionId>` |

The signature is the provider's own recipe:
`base64(HMAC-SHA256(apiPassword, merchantPublicKey ‖ amount(F2) ‖ currency ‖ merchantReferenceId ‖ timestamp))`.
A session is created (`responseCode` 000) and stays `initiated` until the cardholder pays;
`POST /payment-gateways/transactions/:id/refresh` asks the order endpoint and records the
verdict. `queryable: true`.

**NeoLeap** — the connector's request/answer contract as the desktop source spells it out.
The transport is *not* ported: `neoleapconnector` is a compiled library that is not in this
repository, so the address is configuration and the call is a plain HTTP POST of the same
JSON. The terminal answers the sale there and then — `00`/`01`/`02` — so there is no status
call to make and none is invented: `queryable: false`.

## 🧪 Simulation

`payment_gateway_settings.simulation` is **on by default** and answers locally, as
`einvoice_settings.simulation` does for ZATCA: no acquirer is dialled and no card is
charged. The cardholder's answer is taken from the `ecrRef` prefix — the only way a test
can ask for a refusal without a real card:

| prefix | verdict |
| --- | --- |
| `DECLINE-…` | ❌ مرفوضة |
| `CANCEL-…` | 🚫 ملغاة |
| `ERROR-…` | ⚠️ تعذّر الوصول |
| `UNKNOWN-…` | ❓ ردٌّ لا نقرؤه |
| `PENDING-…` | ⏳ تبقى معلّقة (جيديا وحدها) |
| anything else | ✅ مقبولة |

## Endpoints

| method | path | permission | what |
| --- | --- | --- | --- |
| `GET` | `/payment-gateways` | `pos.config.manage` | both cards, secrets masked |
| `PUT` | `/payment-gateways/:provider` | `pos.config.manage` | 💾 حفظ |
| `POST` | `/payment-gateways/:provider/test` | `pos.config.manage` | 🧪 TEST · 🧪 Test |
| `POST` | `/payment-gateways/:provider/sale` | `sales.invoice.pay` | 💳 the sale |
| `GET` | `/payment-gateways/transactions` | `sales.view` | 📜 the log |
| `POST` | `/payment-gateways/transactions/:id/refresh` | `sales.invoice.pay` | 🔄 ask again |

An approved sale with an `invoiceId` is settled once, through
`SalesService.addPayment({ method: 'card', idempotencyKey: <reference> })` — the same call
`POST /sales/invoices/:id/payments` makes — and the row is marked `settled`, so a second
🔄 cannot pay the invoice twice.

## Refusals, in the desktop's words where it had any

| code | status | when |
| --- | --- | --- |
| `PAYMENT_GATEWAY_DISABLED` | 409 | «الرجاء تفعيل الدفع عن طريق جيديا!» / «الرجاء تفعيل NeoLeap!» (L2519) |
| `PAYMENT_GATEWAY_NOT_CONFIGURED` | 404/422 | no saved settings row, or no address to dial |
| `PAYMENT_AMOUNT_INVALID` | 422 | the money is not positive |
| `SALES_INVOICE_NOT_POSTED` | 409 | «لا يمكن تحصيل فاتورة غير مرحَّلة» |
| `PAYMENT_EXCEEDS_DUE` | 422 | «قيمة مدفوع الشبكة يجب أن تساوي صافي الفاتورة» (L505) — the balance is the ceiling |
| `PAYMENT_REFERENCE_DUPLICATED` | 409 | the same `ecrRef` twice is one sale, not two charges |
| `PAYMENT_PORT_INVALID` | 422 | «المنفذ» is 0–65535 |
| `PAYMENT_PROVIDER_UNKNOWN` | 422 | anything other than جيديا / NeoLeap |

## Security

- Both tables run with `ENABLE` + `FORCE` row-level security and a `tenant_id` policy
  (migration `0064`), like every tenant-scoped table in the platform.
- The merchant secret is encrypted at rest with the same `v1:iv:tag:data` AES-256-GCM
  envelope as `einvoice_credentials`, and is only ever returned masked (`****1234`).
- The gateway's raw answer is stored because a disputed card is argued about with the
  bank's words — with every occurrence of the secret cut out first (`redactSecrets`).
- Card numbers are never stored: only `****` + the last four digits, as the receipt prints.

## Tests and live verification

- `apps/api/test/payment-gateways.spec.ts` — 16 tests (settings, 🧪 TEST, both providers,
  the pending جيديا session, refusals, money guards, idempotency, settlement, RBAC,
  tenant isolation).
- `scripts/verify-payment-gateways.mjs` — 64 live checks against a running stack; it
  snapshots both providers and restores them at the end, and never turns 🧪 Simulation
  off.
