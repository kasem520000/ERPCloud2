# Supplier portal and simple e-sign

Future enhancement 11. A supplier is not a staff user and holds no ERP permissions. The signature is a drawing plus a one-time code. It is not a legally qualified XAdES signature.

Migration `0107_supplier_portal_esign.sql`. Schema `packages/database/src/schema/supplier-portal.ts`. All six tables are tenant-scoped with `ENABLE` and `FORCE` row-level security.

| Table | Role |
| --- | --- |
| `supplier_portal_users` | Login bound to one supplier party |
| `supplier_portal_sessions` | Hashed bearer; the raw token is not stored |
| `supplier_rfqs` | Request for quote; one response, then closed to a second reply |
| `supplier_invoice_uploads` | Declared bill from the supplier; not a posted purchase invoice |
| `esign_requests` | Hashed link secret and one-time code, expiry, signed PDF bytes |
| `esign_events` | `sent` / `viewed` / `signed` / `declined` |

## Routes

Staff (`supplier_portal.access` / `esign.manage`): invite users, open RFQs, read uploads, send a signature request.

Supplier bearer: `POST /supplier-portal/auth/login`, then invoices, payments, quotations, one response per RFQ, and an invoice upload. A document that belongs to another party is hidden.

Public signature page: `GET /esign/:token`, `POST /esign/:token/sign`, `GET /esign/:token/pdf`. An expired link answers `410`.

## Screens

`/purchases/supplier-portal` invites the supplier. `/supplier-portal` is the supplier's own board. `/sales/quotations/[id]/esign` sends the link. `/esign/[token]` is the public drawing page.

Rules and the eight acceptance cases live in `supplier-esign.ts` and `supplier-esign.spec.ts`.
