# Salla integration (Phase 22 + Phase 09 part eight)

Feature flag: `integration.salla`. OAuth access/refresh tokens and webhook secrets are encrypted with AES-256-GCM. Export queue/log endpoints use a mockable worker path; diff flags mirror legacy `vw_Items_Salla_Status` fields: name, price, cost and qty. Order webhooks require HMAC-SHA256 verification before creating sales invoices.

## Where it comes from (Phase 09 part eight)

| Window | File | What it holds |
|---|---|---|
| 🛒 تكامل Salla API | `Form_WPF/FrmSallah.xaml` («تكامل Salla API» — لوحته «🛒 تكامل منصة Salla») | أربعة أزرار: «📦 جلب المنتجات» · «📋 جلب الطلبات» · «➕ إضافة منتج» · «📥 جلب الطلبات (2)» |
| العميل | `Class/SallaAPI.cs` | `https://api.salla.dev/admin/v2` · Bearer · `GET/POST/PUT/DELETE` · `«خطأ في الطلب: {status} - {body}»` |
| 📦 المنتجات | `Class/ProductsManager.cs` | `products` · `products/{id}` · `POST products` · `PUT products/{id}` · `DELETE products/{id}` |
| 📋 الطلبات | `Class/OrdersManager.cs` | `orders` · `orders/{id}` · `PUT orders/{id}/status` بـ`{ status }` |
| 👥 العملاء | `Class/CustomersManager.cs` | `customers` · `customers/{id}` |
| 🔑 التوثيق | `Class/SallaAuth.cs` | `POST https://accounts.salla.sa/oauth2/token` · «خطأ في الحصول على Access Token: …» |

Three things about the desktop are worth knowing before reading the code here:

1. **The token is a literal** — `new SallaAPI("2adcaba8-c5a8-426c-8fc9-3281fa4b056d")` in
   `FrmSallah.xaml.cs`. This module keeps it encrypted per tenant (`salla_connections`).
2. **The window counts and forgets** — there is no `SallaProducts` or `SallaOrders` table in
   `CrystalLiteDB.txt`. «📦 جلب المنتجات» shows «تم جلب {n} منتج.» and keeps nothing, so
   this part adds `salla_products` and `salla_orders` to hold what it counted.
3. **The «متجر سلة» menu items are empty** (`Home.xaml` L394 — المنتجات · إدارة الطلبات ·
   ربط المستودعات) and the windows they would open are commented out in `Home.xaml.cs`
   L257–L261. «📥 جلب الطلبات (2)» is `await Task.Run(() => { })` and is not migrated.

`Class/ManagerOnline.cs` is **not** part of Salla: it is the licence heartbeat (`QLicense`)
and the ZATCA expiry check against `https://app-cloud-rmxb.onrender.com`.

## The transport is injected

`SallaClient` speaks to a `SallaTransport` — a function, not a hard-wired `HttpClient`:

| Transport | When |
|---|---|
| `createFetchTransport()` | production — `fetch` against `api.salla.dev` |
| `createMockTransport()` | `SALLA_TRANSPORT=mock`, or a **store id that starts with `MOCK-`** |

A mocked store keeps its state between calls (a product pushed by «➕ إضافة منتج» shows up
in the next «📦 جلب المنتجات»), which is what `apps/api/test/salla-store.spec.ts` and
`scripts/verify-salla.mjs` run against — no credential, no network.

## Endpoints

| Method | Path | Permission | What it is |
|---|---|---|---|
| GET | `/integrations/salla/oauth/authorize` | manage | `SallaAuth` — build the authorize URL |
| POST/GET | `/integrations/salla/connections` | manage / view | ربط متجر · قائمة المتاجر (secrets masked) |
| DELETE | `/integrations/salla/connections/{id}` | manage | قطع المتجر — mappings and product mirrors go with it |
| POST/GET | `/integrations/salla/branch-mappings` | manage / view | «ربط المستودعات» |
| GET | `/integrations/salla/products` | view | الأصناف محلياً وحالة مزامنتها |
| POST | `/integrations/salla/products/pull` | manage | «📦 جلب المنتجات» → «تم جلب {n} منتج.» |
| POST | `/integrations/salla/products/push` | manage | «➕ إضافة منتج» → «تم إضافة المنتج بنجاح.» |
| PUT | `/integrations/salla/products/{remoteId}` | manage | `ProductsManager.UpdateProduct` |
| DELETE | `/integrations/salla/products/{remoteId}` | manage | `ProductsManager.DeleteProduct` |
| GET | `/integrations/salla/catalog` | view | منتجات المتجر كما جُلبت |
| GET | `/integrations/salla/customers` | view | «👥 العملاء» — read, stored nowhere |
| POST | `/integrations/salla/orders/pull` | manage | «📋 جلب الطلبات» → فاتورة لكل طلب (الرقم البعيد يمنع التكرار) |
| GET | `/integrations/salla/orders` | view | «إدارة الطلبات» — invoices tagged `salla` |
| PUT | `/integrations/salla/orders/{id}/status` | manage | `OrdersManager.UpdateOrderStatus` بـ`{ status }` |
| DELETE | `/integrations/salla/orders/{id}` | manage | المرآة ومسوّدتها؛ المُرحَّل يُرفض |
| POST | `/integrations/salla/export-queue` · `export-next` | manage | طابور التصدير |
| GET | `/integrations/salla/export-log` | view | سجل التصدير |
| POST | `/integrations/salla/webhooks/{storeId}/orders` | — (HMAC) | طلبٌ وارد → فاتورة مبيعات |

## Tests

- `apps/api/test/salla-store.spec.ts` — 10 tests: pull/push/update/delete products, customers,
  the order import and its idempotency, status update, deleting an order with its draft, the
  refusals (including `SallaAPI`'s own «خطأ في الطلب: 404 …»), the permission split, tenant
  isolation and disconnecting a store.
- `scripts/verify-salla.mjs` — 40 live checks against a running stack, driven entirely through
  HTTP against a `MOCK-` store; everything it writes is deleted in a `finally`.

## Staff screens

`/integrations/salla/products` (📦 منتجات متجر سلة — local items and the store's own products)
and `/integrations/salla/orders` (📋 إدارة طلبات سلة — pull, status, delete, open the invoice),
with `/integrations/salla/warehouses` (ربط المستودعات) and `/integrations/salla/settings`
(إعدادات ربط سلة).
