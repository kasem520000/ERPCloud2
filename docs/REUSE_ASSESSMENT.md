# REUSE_ASSESSMENT.md — Component-by-component reuse decision

> **Status:** assessment complete (2026-10-14); M0 safety-net fixes implemented 2026-10-15 — the two
> known-failing specs below are FIXED (R-01/R-20, see `PROGRESS.md` §7). No product reuse started yet.
> Categories: **REUSE** (safe as-is) · **REFACTOR** (reuse after refactoring) · **REFERENCE** (pattern/source
> reference only, do not wire into the new product) · **REPLACE/UNSAFE** (must not be reused as-is) ·
> **MISSING** (new implementation required).
> Evidence markers: **[V]** verified by code read or executed command this session · **[R]** reported by an
> existing repo document (not re-verified line-by-line) · **[A]** assumption to validate.

## 1. Summary decision matrix

| # | Component | Decision | Confidence |
|---|---|---|---|
| 1 | Tenant isolation (RLS + GUC + `withTenantTx` + guards) | **REUSE** | High **[V]** |
| 2 | Auth & session (JWT RS256, Argon2id, MFA, lockout, rotation CAS) | **REUSE** | High **[V]** |
| 3 | RBAC (roles, permission registry, aliases, `@RequiresPermission`) | **REUSE** | High **[V]** |
| 4 | Accounting engine (`accounting.service.ts`: posting, reversal, periods, locks, statements) | **REUSE** | High **[V]** |
| 5 | Inventory ledger (`inventory.service.ts`: recordInTx, balances, transfers, adjustments, vouchers) | **REUSE** | High **[V]** |
| 6 | Sales invoice engine (`sales.service.ts` `postInTx` + payments) | **REUSE** | High **[V]** |
| 7 | Treasury (vouchers, custody, cash transfers, shift close) | **REUSE** | High **[V]** |
| 8 | Purchases (+ landed cost) | **REUSE** | High **[V]** |
| 9 | Production/manufacturing (production orders, WMS BOM, batch costing) | **REUSE + EXTEND** (WIP stage, standard-cost decision) | High on current scope **[V]** |
| 10 | ZATCA e-invoicing | **REUSE** | High **[V]** |
| 11 | Van-sales domain (custody, load orders, closing/settlement) | **REFACTOR** (decompose 6.5k-line service; keep tables & engine calls) | High **[V]** |
| 12 | Offline POS pattern (offline-data/offline-sync, `offline_queue`, IndexedDB) | **REFACTOR → GENERALIZE** into a shared offline-sync service for the rep app | High **[V]** |
| 13 | `apps/staff` van-sales screens (manager + `/van-sales/rep`) | **REFERENCE** for the new dedicated rep app; the online rep page is not offline-first | High **[V]** |
| 14 | Platform-owner console (`apps/platform-admin` + platform modules) | **REUSE** | High **[V]** |
| 15 | Billing/licensing (plans, subscriptions, activation, Stripe, dunning, usage) | **REUSE** | High **[V]** |
| 16 | Marketplace/add-on gating (`marketplace_apps`, `tenant_apps`, appGate) | **REUSE + EXTEND** (new app codes for the product packs) | High **[V]** |
| 17 | Platform services: idempotency, sequences, audit log, files, notifications, jobs/outbox, rate limit | **REUSE** | High **[V]** |
| 18 | `packages/contracts`, `packages/config`, `packages/ui`, `packages/testing` | **REUSE** | High **[V]** |
| 19 | Migration tooling (`apps/migrator` wave engine + registry) | **REUSE + EXTEND** (for onboarding manufacturers from legacy systems) | High **[V]** |
| 20 | Compat gateway (`modules/compat`) for the legacy desktop client | **REFERENCE only** for the new product (do not extend it into the new apps) | High **[V]** |
| 21 | Legacy desktop schema (now `docs/legacy/sql.txt`) | **REFERENCE only** | High **[V]** |
| 22 | Dedicated offline-first field-rep application | **MISSING** (new frontend app + sync service) | — |
| 23 | New specialized accounting application (UI) | **MISSING** (new frontend app; backend largely exists) | — |
| 24 | Fixed assets, budgets, standard costing, WIP accounts | **MISSING** (verified absent) | High **[V]** |
| 25 | Known-failing specs (`printing-and-cards.spec.ts`, `employee-movements.spec.ts` — see PROGRESS.md §2) | ~~FIX BEFORE REUSE~~ **FIXED in M0 (2026-10-15)** — both suites green; root causes removed (R-01, R-20) | ~~High~~ Resolved **[V]** |

## 2. Detail per component

### 2.1 REUSE as-is — with exact paths and why it is safe

**Tenant isolation.** `packages/database/src/rls.ts`, `packages/database/src/client.ts`
(`withTenantTx`/`withPlatformAdminTx`), `apps/api/src/modules/platform/guards/tenant.guard.ts`.
Enforced by PostgreSQL against `NOBYPASSRLS`; transaction-local GUC cannot leak across pooled connections;
membership bootstrap itself is RLS-scoped; forged tokens/suspended tenants covered by executed specs. The
new apps get isolation for free by simply using the same API and transaction helpers. **[V]**

**Auth/session.** `apps/api/src/modules/platform/auth/` — status checks at login *and* refresh (AUD-01
fixed), CAS refresh rotation (AUD-07 fixed), MFA/TOTP, lockout, password policy, session handoff codes,
device sessions. Rep devices can be modeled with the existing device registry
(`devices`, migration 0032). **[V]**

**Accounting engine.** `apps/api/src/modules/accounting/accounting.service.ts`. Balanced-entry validation,
fiscal period + module locks, one reversal mechanism (`reverseJournalInTx`, mirror convention, original
stays posted), sequences, cost centers, statements, trial balance. The new accounting app is a new *UI +
workflows*, not a new engine. Posting profiles (`branch_posting_profiles`) keep GL mapping a per-tenant
decision. **[V]**

**Inventory ledger.** `apps/api/src/modules/inventory/inventory.service.ts` — weighted average with
`FOR UPDATE` + version, reversal at original cost, transfers with in-transit leg, adjustments with variance
journal, lots/serials, bins/BOM. `recordInTx` is the only sanctioned movement writer; the new rep app will
never write `stock_balances` directly. **[V]**

**Sales engine.** `sales.service.ts` `postInTx` — lock-checked draft→posted, auto stock, revenue/VAT/COGS
posting, payments with idempotency. Van-sales already routes every rep invoice through it; the new rep app
must do the same. **[V]**

**Treasury.** Receipt/payment vouchers with party counter-accounts, cheque lifecycle, cash transfers,
shift close with custody accounts, `cash_location_custodians` for rep cash custody. **[V]**

**ZATCA e-invoicing.** Full KSA compliance path (QR, UBL, chain, onboarding, filing, simulation/production).
Food-factory/van-sales invoices must be tax invoices — this is already integrated with `sales.postInTx`
(`zatca_status`, submissions). **[V]**

**Platform owner plane.** Console + services (§4.8 of `CURRENT_ARCHITECTURE.md`): tenants, plans,
subscriptions, activation requests, Stripe with event dedupe, usage metering, backups, audit, jobs console,
announcements, support, impersonation, API keys. The new product becomes *plans/marketplace packs on the
same plane* — zero new platform infrastructure needed. **[V]**

**Platform services.** `IdempotencyStore` (durable, pre-claim), `SequencesService` (per-tenant/branch/doc
numbering — critical for offline replay ordering), `AuditInterceptor` + append-only `audit_log`, files
(S3 + presigned + tokens), notifications, BullMQ outbox worker, rate limiting. All tenant-scoped with RLS. **[V]**

**Shared packages.** `contracts` (error codes, permission registry + canonicalization, invoice math,
valuation), `config` (env validation, tenant settings), `ui` (design system), `testing` (embedded PG +
isolation harness — this is what makes "reuse is safe" a tested claim rather than a hope). **[V]**

### 2.2 REFACTOR — reusable after refactoring

**Van-sales service decomposition.** `apps/api/src/modules/van-sales/van-sales.service.ts` is 6,479 lines:
load orders, receipts, documents, collections, closing, settlement, production batches, prices, dashboards,
reports, legacy reconciliation in one class. The domain logic is correct (heavily regression-tested — 5
van-sales spec files) but the shape is a maintenance risk and the controller surface is bakery-flavored
(`production-batches`, `legacy-reconciliation`). Recommended refactor before the new product builds on it:
split into `load-orders` / `rep-documents` / `custody-settlement` / `production` services (or a `van-sales/`
folder of controllers) with the same table set, keep every `InTx` engine call, keep the specs green while
moving code. **[V]**

**Offline sync generalization.** The POS offline pattern (`pos.service.ts` `offlineData`/`offlineSync`,
`offline_queue`, `apps/staff/lib/offline-db.ts` + `sync-engine.ts`) is exactly the right architecture
(browser/phone owns the working copy; API is authority; queue = ledger of replays; conflicts surfaced, never
silent), but it is hard-wired to POS invoices (`invoice_id`, `invoice_number` columns; canonical POS
checkout replay). Refactor into a shared sync contract: per-device sequence + `offlineId` idempotency +
replay-through-canonical-service, with document *kinds* (rep invoice, rep collection, rep return, stock
count). The rep app needs richer master data (customer prices, van stock, routes) than the POS catalog —
extend the offline-data payload shape rather than inventing a second sync stack. **[V]**

**Employee mobile surface.** `/m/*` (staff app) + `employee-mobile` module (0105) prove mobile-shaped
access (geofences, attendance, requests, push) but are employee-self-service, not offline sales. Reuse the
auth/permission/scope patterns and push plumbing; the offline sales capability comes from the generalized
sync above. **[V]**

**Marketplace catalog.** `MARKETPLACE_APPS` is a static list (salla/zid/shopify/moyasar/ocr/esign/wms);
PHASE_C gated the vertical packs (manufacturing, van_sales, tailoring, …) through `tenant_apps`. For the new
product, add explicit app codes for the accounting-ERP packs and rep app entitlement, and gate the new
apps' screens with the same `visibleModules` appGate mechanism. **[V]**

### 2.3 REFERENCE only

**Compat gateway** (`apps/api/src/modules/compat/`): a deliberate bridge for the *legacy desktop client*
(device keys, master pulls, document pushes). The new product must not route through it; it exists so
existing desktop users can transition. Keep it isolated; it is not part of the new architecture. **[V]**

**Legacy desktop schema** (now `docs/legacy/sql.txt`) and the migrator registry maps: the source of truth for onboarding
manufacturers running the legacy system — use as reference for field mappings, not as a design template. **[V]**

**Vertical packs** (marina, optics, tailoring): useful as the reference implementation of "sector pack as
marketplace add-on on top of the core engines". **[V]**

### 2.4 UNSAFE / must fix before reuse

- **Print view of unissued invoices** — `printing-and-cards.spec.ts` fails today: the test expects the
  print HTML of an invoice with no issue data to say "لم تُصدِر بعد" (not yet issued), and instead the
  template renders a full document ("expected html to contain 'لم تُصدِر بعد'"). Pre-existing, documented in
  `PRODUCTION_POSTING_AND_MATERIAL_SOURCE_REPORT.md`, still red in this session's runs (twice). Any new app
  that prints rep invoices must not inherit this path until fixed. **[V]**
- **No core-engine component was found unsafe for reuse.** The engine-level suites all passed in this
  session's full runs: journal reversal consistency, trial balance, income statement, accounting statements,
  sales posting/documents/concurrency, purchase posting, inventory (documents, serials, units, closure,
  BOM), production and returns, production posting profile, treasury (vouchers, custody, transfers, day
  close, shift entry), ZATCA (onboarding/sync/filing), idempotency, money precision, tenant isolation, and
  the five van-sales suites. The 9 failing tests sit in the print path (item above) and an HRM report spec
  that is timezone/time-of-day flaky (see `LEGACY_RISK_REGISTER.md` R-20) — neither is an engine-correctness
  failure, but both must be fixed before reuse claims rest on a green gate. Historical engine defects found
  in earlier audits (reversal convention, custody settlement, double-reversal, original-cost reversal) were
  fixed with regression tests that are green in this session. Reuse therefore does not depend on trusting
  old reports — it was re-verified by executing the suites. **[V]**
- Policy-level gaps that block specific *new* promises (not current features): scope enforcement (AUD-03)
  if the rep app promises warehouse-scoped access; six open van-sales accounting policy decisions
  (shortage responsibility, etc. — `VAN_SALES_IMPLEMENTATION_AUDIT.md` §9) that the new product must decide
  explicitly. **[R]**

### 2.5 MISSING — new implementation required

1. **Dedicated field-sales rep app (offline-first).** New frontend application in the monorepo (see
   `TARGET_ARCHITECTURE.md` for the shape decision). Server side: generalized offline sync service +
   rep-scoped endpoints. Nothing offline-first exists for sales outside POS invoices today. **[V]**
2. **New specialized accounting application UI.** The backend GL is complete for the basics; the new app is
   a new frontend surface + workflows (and the missing features below).
3. **Fixed assets** (register, depreciation runs, GL posting). **[V]** (verified absent)
4. **Budgets & budget-vs-actual.** **[V]** (absent)
5. **Standard costing / cost variance** — today only perpetual weighted average; food factories often need
   standard cost + variance analysis. Requires an engine decision (see `DECISIONS.md` D-007). **[V]** (absent)
6. **WIP accounts for multi-stage production** — currently consume+output in one transaction by design;
   `wipAccountId` deliberately absent. **[V]**
7. **Bank reconciliation auto-posting / more feed formats** — import + match + report exists; auto-posting
   explicitly out of scope so far. **[V]**
8. **Multi-book / parallel accounting, intercompany** — absent. **[V]** (only if the new product's scope
   demands them — decision point, not a default.)

## 3. Reuse safety net (what makes "reuse" defensible)

- 198 API spec files (1660 passing this session) include engine-level regression suites: journal reversal
  consistency, trial balance, sales posting, purchase posting, inventory closure, production and returns,
  treasury custody, van-sales stock acceptance/settlement, idempotency, money precision, RLS isolation. **[V]**
- The `pnpm verify` gate (typegen, typecheck, lint, build, smoke, tests, OpenAPI) runs on every PR. **[V]**
- Migrations are checksummed and forward-only in practice. **[V]**

## 4. Explicit non-goals for reuse

- Do not reuse the *van-sales manager screen* as the rep app (it is online-only, desktop-shaped).
- Do not reuse the *compat gateway* for new-product sync.
- Do not reuse `/billing/*` legacy endpoints for new-product monetization — use the modern
  `PlatformBillingService` + activation flow (the legacy route is kept only for its live consumers). **[V]**
