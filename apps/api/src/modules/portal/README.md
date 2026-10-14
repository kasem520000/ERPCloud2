# Customer portal (`/portal/*` + `/portal-access`)

Self-service for the tenant's **customers** — the people who receive the invoices, not the
staff who issue them. A buyer signs in to the customer app (`apps/customer`, port 3002) and
sees their own invoices, statement and payments; nothing else in the tenant is reachable.

## How a portal login is authorised

A portal login is deliberately boring: an ordinary `users` row plus an ordinary `memberships`
row, so it goes through the same argon2 password check, lockout, refresh-token rotation and
tenant resolution as any other login. What makes it a *portal* login is what it is missing:

1. Its membership carries a single system role, **`Customer portal`** (`is_system = true`,
   created lazily per tenant), whose permission set is **empty**. Every back-office route is
   annotated with `@RequiresPermission`, so all of them answer `403` for this token —
   `/parties`, `/accounts`, `/sales/invoices`, `/reports`, everything.
2. The `/portal/*` routes carry **no** `@RequiresPermission`. `PermissionsGuard` allows a route
   with no permission metadata to any authenticated member of the tenant, which is exactly the
   hole the portal needs, and only the portal fits through it.
3. Authorisation inside those routes is the **`portal_accounts` row**, resolved from the token
   by `PortalService.accountFor(tenantId, userId)`. The party id is never read from the
   request, so there is no id for a caller to tamper with. A missing row is
   `403 PORTAL_ACCESS_REQUIRED`; a suspended one is `403 PORTAL_ACCESS_SUSPENDED`.

A document belonging to another customer answers **`404`, not `403`** — a portal must not
confirm that an invoice id exists in a tenant the caller cannot see.

## Back-office routes (`parties.view` / `parties.manage`)

| Route | Purpose |
|---|---|
| `GET /portal-access?partyId=` | All portal logins in the tenant, or one customer's |
| `GET /parties/:id/portal-access` | Logins for one customer |
| `POST /parties/:id/portal-access` | Grant access: `{ email, fullName?, password?, notify? }` |
| `PATCH /portal-access/:id` | `{ status: 'active' \| 'suspended' }` |
| `DELETE /portal-access/:id` | Revoke: drops the link **and** soft-deletes the membership |

`POST` creates the user when the email is new to the platform and returns a generated
`temporaryPassword` **once** (`mustChangePassword = true`); if the email already belongs to a
user it is linked instead and no password is returned. `409 PORTAL_ACCOUNT_TAKEN` means that
login already serves a different customer in this tenant, `409 PORTAL_ACCOUNT_EXISTS` means it
already serves this one. When a password was generated, it is also e-mailed to the buyer
through the configured mail transport (`MAIL_TRANSPORT=smtp`, MailHog in the compose file)
unless the caller passes `notify: false`; a delivery failure is logged and never rolls back
the grant. Admin UI: **المبيعات ← أخرى ← وصول العملاء للبوابة** (`/sales/portal-access`).

## Customer routes (no permission, portal account required)

| Route | Returns |
|---|---|
| `GET /portal/me` | Own party card, the supplier's company profile, current balance |
| `GET /portal/invoices?from&to` | Posted invoices for the party |
| `GET /portal/invoices/:id` | Invoice header, lines, payments |
| `GET /portal/invoices/:id/print` | The same A4 RTL HTML the back office prints |
| `GET /portal/statement?from&to` | Document-level statement with a running balance |
| `GET /portal/payments` | Posted receipt/payment vouchers on the party |

The statement is built from documents (posted invoices debit, posted receipts credit) rather
than `journal_entry_lines`. A buyer asks "which invoice is still open", and a document-level
statement also stays correct in a tenant whose posting profiles are still being set up.

`GET /portal/me` touches `last_seen_at`, which is what the admin screen shows as "آخر زيارة
للبوابة".

## Data

`portal_accounts (id, tenant_id, party_id, user_id, status, invited_at, last_seen_at, …)` —
migration `0030`, RLS enabled and forced, `UNIQUE (tenant_id, user_id)` so one login can never
point at two customers.

## Tests

`apps/api/test/portal.spec.ts` — grant → login → read own invoice → **404 on a foreign
invoice** → **403 on five ERP endpoints** → suspend → revoke. The containment assertions are
the point of the suite; the happy path is the easy half.
