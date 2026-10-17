# CURRENT_ARCHITECTURE.md — ERP_Cloud2 platform as it exists today

> **Status:** Assessment deliverable (2026-10-14). Documentation only — no implementation.
> **Evidence discipline:** every claim below is marked **[V]** (verified by direct code read or an executed
> command in this session) or **[R]** (reported by an existing repository document, not re-verified line-by-line
> here). Nothing is claimed from memory or assumption. Test commands and their actual results are listed in
> `PROGRESS.md`.

---

## 1. Repository shape

pnpm monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`), Node ≥ 22, TypeScript 5 strict
(`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noEmitOnError`). **[V]**

| Path | Package | Stack | Role |
|---|---|---|---|
| `apps/api` | `@erp/api` | NestJS 11, Drizzle ORM 0.45, `pg`, Express, jose (RS256 JWT), BullMQ, Stripe | The single backend API + background worker |
| `apps/staff` | `@erp/staff` | Next.js 15 (App Router), React 19, TanStack Query, Tailwind 4, `@erp/ui` | Tenant back-office UI (the whole ERP: accounting, inventory, sales, POS, purchases, treasury, HRM, manufacturing, van-sales, verticals) |
| `apps/platform-admin` | `@erp/platform-admin` | Next.js 15 | Platform-owner console (tenants, plans, subscriptions, billing, audit, jobs, backups, marketplace approvals, support, usage, dunning, announcements, content, developer) |
| `apps/marketing` | `@erp/marketing` | Next.js 15 | Public marketing site, pricing, signup, blog |
| `apps/customer-portal` | `@erp/customer-portal` | Next.js 15 | External customer portal (invoices/statements) |
| `apps/migrator` | `@erp/migrator` | Node CLI, TypeScript | Legacy desktop (SQL Server) → cloud migration engine with a wave/dependency registry |
| `packages/database` | `@erp/database` | Drizzle, `pg` | Schema (41 files), 127 forward migrations (numbered 0000–0127; 0086 absent — a gap, not a file count error) + 112 down migrations, RLS helpers, seeds, migration CLI |
| `packages/contracts` | `@erp/contracts` | Zod | Shared contracts: error codes, permissions registry + alias canonicalization, invoice math, inventory valuation/lifecycle, landed cost, ZATCA QR |
| `packages/config` | `@erp/config` | Zod | Env validation, tenant settings schema, seeds (roles), data-encryption-key handling |
| `packages/testing` | `@erp/testing` | Vitest harness | Embedded PostgreSQL 16 boot, role provisioning, isolation suite, factories |
| `packages/ui` | `@erp/ui` | React + tokens.css | Shared design system (22+ components, RTL/LTR, dark mode) used by all three Next.js apps |

Repository scale (measured): `apps/api` ≈ 164k LOC, `apps/staff` ≈ 68k LOC, `packages/database` ≈ 24k LOC,
`packages/contracts` ≈ 16k LOC, `apps/platform-admin` ≈ 22k LOC. **[V]**

Root scripts (`package.json`): `pnpm verify` = typegen → typecheck → lint → build → API smoke → all tests →
OpenAPI export. CI (`.github/workflows/verify.yml`) runs exactly `pnpm verify` on PRs and pushes to
`main`/`arena/**`. **[V]**

Deployment: `deploy/k8s/` — namespace, `api` Deployment + HPA, separate `worker` Deployment (same image,
`WORKER=1`), `web` deployment, `migrate-job.yaml` as an Argo CD `PreSync` hook (roles → migrations → seed),
Ingress. Local: `infrastructure/docker-compose.yml` (Postgres 16, Redis 7, MinIO, Mailhog). **[V]**

## 2. The API process and its pipeline

NestJS module tree in `apps/api/src/app.module.ts` wires ~50 domain modules. **[V]** The request pipeline is
explicitly frozen (comment in `app.module.ts`, "API_ARCHITECTURE §2"):

```
RateLimitGuard → AuthGuard → TenantGuard → BranchScopeGuard → PermissionsGuard → (ImpersonationGuard) → handler
```

**[V]** — `apps/api/src/app.module.ts` and `apps/api/src/modules/platform/guards/*`.

- **Request context** (`apps/api/src/request-context/request-context.ts`): `AsyncLocalStorage` store holding
  `auth` (userId, claimedTenantId, membershipId, scopes, platform roles, impersonation id), `tenant`
  (permissions, branchScope, role scopes, discount limits, membership kind `staff|portal`), `branchId`,
  `clientIp`/`userAgent`, `auditTenantId` (for public webhooks), and a `system` context
  (`runAsSystem`) for background jobs — no synthetic users. **[V]**
- **Auth** (`apps/api/src/modules/platform/auth/`): Argon2id password hashing with frozen parameters,
  RS256 access (15 min) + refresh (30 d) tokens with rotation, TOTP MFA (`mfa.service.ts`, `totp.ts`),
  login lockout, password policy, session handoff codes (migration 0116), device sessions
  (migration 0032/0115). Refresh-token rotation is a compare-and-swap `UPDATE … WHERE revoked_at IS NULL`
  (AUD-07 fix, `auth.service.ts` ~L256–267). **[V]**
- **Authorization** (`apps/api/src/modules/platform/guards/permissions.guard.ts`, `packages/contracts/src/permissions.ts`):
  `@RequiresPermission(...codes)` per route; permission codes are canonicalized so legacy aliases still
  authorize; membership kind `portal` is denied on every `@RequiresPermission` route. **[V]**
- **Idempotency** (`apps/api/src/common/interceptors/idempotency.interceptor.ts` +
  `apps/api/src/modules/platform-services/idempotency/idempotency.store.ts`): durable `idempotency_keys`
  table, key claimed *before* the handler in its own transaction; semantics: `started | replay (byte-identical
  stored response) | in_progress (409) | conflict (409, different payload)`, TTL-expired keys are reusable. **[V]**
- **Audit** (`apps/api/src/modules/platform-services/audit/`): `AuditInterceptor` writes `audit_log` rows with
  before/after diffs, redaction rules, and `audit_log` is append-only (`REVOKE UPDATE, DELETE, TRUNCATE`). **[V]**
- **Rate limiting** per route class; OpenAPI export (`apps/api/src/openapi`) with a smoke check
  (`apps/api/scripts/smoke-check.mjs`). **[V]**

## 3. Tenancy model and PostgreSQL

Single PostgreSQL database, **shared schema with `tenant_id` + Row-Level Security** on every tenant-scoped
table. **[V]**

- Roles: `erp_api` (runtime, `NOBYPASSRLS`) and `erp_migrator` (DDL), provisioned by
  `pnpm db:roles` (`packages/database/src/cli/roles.ts`). Migrations run only through
  `DATABASE_MIGRATOR_URL`, never the runtime role. **[V]**
- RLS (`packages/database/src/rls.ts`): every tenant table gets
  `ENABLE` + `FORCE ROW LEVEL SECURITY` and one canonical policy
  `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`
  (`USING` and `WITH CHECK`). Junction tables without `tenant_id` get parent-derived policies;
  `audit_log` uses an `IS NOT DISTINCT FROM` variant so platform rows (NULL tenant) are write-only. **[V]**
- The GUC is **transaction-local** (`set_config(..., true)`), set by `withTenantTx(db, tenantId, work)`
  (`packages/database/src/client.ts`) — the only sanctioned way to touch tenant data (1,165 call sites in
  `apps/api`). A pooled connection cannot leak a tenant because the setting dies at COMMIT/ROLLBACK. **[V]**
- Platform control plane (`withPlatformAdminTx`) sets `app.is_platform_admin = 'on'` without setting a
  tenant GUC, so canonical policies still see zero rows; only migration-0020 "platform admin plane" tables
  (tenants, subscriptions, …) match. Guarded by `PlatformAdminGuard`. **[V]**
- `TenantGuard` verifies the token's `tid`+`mid` is an **active membership of an active tenant**, loads the
  effective permission set (UNION over roles) under the claimed tenant's GUC, and publishes the tenant
  context; a forged `tid` finds nothing. **[V]** (`apps/api/src/modules/platform/guards/tenant.guard.ts`)
- Finer-grained scoping: `memberships.branch_scope` (+ `X-Branch-Id` validated by `BranchScopeGuard`) and
  `membership_role_scopes` (branch/warehouse/cash_location/pos_terminal per role) exist in the schema, but
  scope enforcement beyond branch scope is **opt-in per endpoint** via `ScopePolicy.assertScope()` and is
  currently consumed only by platform backups (`apps/api/src/modules/backups/platform-backups.service.ts`). **[V]**
  (This is open audit item AUD-03 — see `LEGACY_RISK_REGISTER.md`.)
- Isolation is tested, not assumed: `apps/api/test/isolation*.spec.ts`, `surface-isolation.spec.ts`,
  `rbac.spec.ts`, plus `packages/database/src/rls.spec.ts`; tests connect as `erp_api` (NOBYPASSRLS) so RLS
  is genuinely exercised. **[V]**

### Identity tables (shared across the whole platform) — `packages/database/src/schema/platform.ts`, `tenancy.ts`, `organization.ts` **[V]**

- `tenants`, `users`, `memberships` (status, kind staff|portal, branchScope, discount limits),
  `roles` + `role_permissions` + `membership_roles` + `membership_role_scopes`, `tenant_settings`,
  platform roles/devices/scopes (migration 0032), `portal_accounts` (0300), MFA (0031).
- Organization: `company_profiles`, `branches`, `warehouses`, `cash_locations` (+balances),
  `currencies`, `fx_rates`, `price_lists`, `branch_posting_profiles` (per-branch GL posting map),
  payment methods (0023).

### Database discipline

- Migration runner (`packages/database/src/migrate.ts`): checksummed `erp_migrations` ledger; an applied
  migration whose file changed **fails the run** ("Applied migrations are immutable"). Each migration is
  applied in one transaction. 127 forward migrations (0000–0127, number 0086 absent), 112 `down/` counterparts. **[V]**
- Reversibility is tested for recent migrations (`apps/api/test/migration-01{23,24,25,27}-reversibility.spec.ts`). **[V]**
- Money is `numeric(precision, 20, scale 4)`; runtime arithmetic uses `decimal.js` with explicit rounding
  (`audit-money-precision.spec.ts`). **[V]**

## 4. The authoritative business engines (single source of truth)

The platform's defining property: **there is exactly one accounting engine, one inventory ledger, one
sales-invoice engine, one treasury voucher engine**, and every feature (POS, van-sales, e-commerce imports,
purchases, production) posts through them. This is the constraint the new product must preserve.

### 4.1 Accounting engine — `apps/api/src/modules/accounting/accounting.service.ts` (2,685 LOC) **[V]**

- `postJournalInTx`: validates ≥ 2 lines, **debit = credit** (tolerance 0.00005), fiscal period open,
  per-period module locks (`period_module_locks`), allocates the document number from
  `SequencesService` (per-tenant/branch/doc-type/fiscal-year counter, displayed `JE-000001`), inserts entry
  + lines with dimensions (cost center, party, salesman, branch, currency + fx). Entries are `posted` or
  drafts; **only `status='posted'` counts in every report**. **[V]**
- `reverseJournalInTx` — the **single reversal mechanism**: `SELECT … FOR UPDATE` on the original, refuses
  non-posted originals, refuses double reversal (`reversalOf` unique lookup) with `reuse` mode for saga
  retries, mirrors every line (debit↔credit) with all dimensions, keeps the original `posted`
  (convention of migration 0047/0125 — "أصل يبقى مرحّلاً والعكس مرآة"), carries `sourceType/sourceId`,
  idempotency key. **[V]**
- Fiscal periods with overlap checks, open/close/reopen with reason; per-module locks; account cards with
  opening balances (0045); trial balance, income statement, account/cost-center statements, general ledger;
  stock valuation bridge (`stockValueAt`). **[V]**
- Posting profiles (`apps/api/src/modules/organization/posting-profiles/` + `branch_posting_profiles`):
  per-branch GL account map (receivables, revenue, VAT output, COGS, inventory, in-transit, damage,
  cash-by-method, production raw/finished since 0127). Nothing auto-creates accounts; unmapped = neutral or
  explicit 422 (`PRODUCTION_ACCOUNTS_INCOMPLETE`). **[V]**

### 4.2 Inventory ledger — `apps/api/src/modules/inventory/inventory.service.ts` (3,533 LOC) **[V]**

- `recordInTx`: per (item, warehouse) `stock_balances` row locked `FOR UPDATE` with `version` optimistic
  counter; **perpetual weighted-average costing** (value moves at the movement's own `unitCost`, reversal of
  an issue consumes at original cost — R3); negative stock refused unless explicitly allowed; every movement
  writes an `inventory_transactions` row (doc type/id/line, base qty via unit factor, lot/serial). **[V]**
- Transfers: `createTransfer/sendTransfer/receiveTransfer/closeTransfer/cancelTransfer` — two-legged
  (out + in-transit GL account; in-transit → destination on receipt), `pending_receipt` states, partial
  receipt with shortage modes, cancellation reverses the journal through the unified reversal engine. **[V]**
- Stock vouchers (in/out with reasons), stock adjustments (counted vs expected → `variance_value` journal
  Dr inventory-adjustment / Cr inventory), lots, serials (status transitions, `stock_document_serials`
  linkage), bins/WMS + BOM + manufacturing orders (0106/0107) with production posting
  (`production-posting.ts` used by both `WmsBomService.produce` and `ProductionOrdersService.complete`). **[V]**
- `assertStockable` enforces item kind/lot/serial rules; `valueOfMovements` reads back booked value rather
  than recomputing. **[V]**

### 4.3 Sales invoice engine — `apps/api/src/modules/sales/sales.service.ts` (2,655 LOC) **[V]**

- `postInTx`: re-reads and locks the draft (`status='draft'`), gates (warehouse required when stock lines,
  customer or cash-customer required, non-negative totals), allocates numbers, **`recordAutoStock`** moves
  stock through the inventory ledger, posts revenue + VAT output + COGS journals via the posting profile,
  links `journal_entry_id`, maintains `invoice_payments`/`paid_total`/`payment_status`. Quotations convert,
  never post. Returns/debit/credit notes are document kinds on the same engine. **[V]**
- Concurrency is covered by tests (`sales-collection-concurrency.spec.ts`), idempotency keys on payments
  (`ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`). **[V]**

### 4.4 Treasury — `apps/api/src/modules/treasury/` **[V]**

- `vouchers` (receipt/payment) posted through `postVoucherInTx` with counter-accounts from party
  receivable/payable or profile; cheque lifecycle (collection/clearing/bounce); cash transfers with
  cash-in-transit account; shift close with counted vs expected and custody accounts; `cash_location_custodians`
  (custody by employee); salesman dimension on vouchers. Balances updated in the same transaction as posting.
- Bank feeds (0096): CSV statement import, auto-match suggestions against posted invoices/vouchers,
  reconciliation report — **no automatic posting**. **[V]**

### 4.5 E-invoicing (ZATCA) — `apps/api/src/modules/einvoicing/` **[V]**

- Credential store (encrypted with `DATA_ENC_KEY`, AES-GCM), UBL XML builder (`zatca/ubl.ts`), TLV QR
  (`packages/contracts/src/zatca-qr.ts`), hash chain with PIH genesis, onboarding (CSR/CSID) and filing
  against simulation/production, submission ledger (`einvoice_submissions`), invoice `zatca_*` columns,
  explicit stop-reasons instead of silent failure, sync batching. Full vs simplified invoices by customer
  VAT presence. **[V]**

### 4.6 Van-sales (field distribution) — `apps/api/src/modules/van-sales/van-sales.service.ts` (6,479 LOC) **[V]**

Implements rep custody end-to-end against the official ledgers:

- **Van warehouse per rep** — custody is a real `stock_balances` row in a van warehouse, not a derived number. **[V]**
- Load orders: `createLoadOrder` (stock availability check, official `stock_transfers` two-legged movement,
  `pending_receipt`) → `confirmReceipt` (rep confirms, discrepancy path) → sell. **[V]**
- Sales documents: one official `sales_invoices` row per rep document via `sales.postInTx`, bonus lines as
  zero-price lines (`metadata.isBonus`), per-customer prices (`van_sales_customer_prices`), settlement
  accounts resolved from cash locations/posting profile — never invented accounts. **[V]**
- Collections: official receipt vouchers via `treasury.createVoucherInTx/postVoucherInTx` with
  idempotent `invoice_payments`. **[V]**
- Closing/settlement: expected vs counted vs shortage with explicit policy states
  (`shortage_policy_status`, `pending_policy_approval`), damage vouchers + journals, stock settlement via
  posted `stock_adjustments` with delegated authority, `remaining_action` (return to main / carry over),
  settle-stock blocked while a settlement is running. The historical bug — "custody declared settled while
  the official van balance still held stock" — is fixed and regression-tested (approveClosing refuses to
  settle when official balance ≠ count; `van-sales-stock-settlement.spec.ts`). **[V]**
- Production batches (factory): official `recordInTx` movements, scrap separated from produced qty,
  lot/batch tracking to prevent mixing bakeries (production date + batch), idempotent resubmission. **[V]**
- Permissions: explicit `van_sales.*` codes (migration 0126); implied grants limited to operational trio;
  approvals (`van_sales.closing.approve`, `van_sales.override.approve`) require explicit grants. **[V]**

### 4.7 Offline POS — the existing offline-first pattern **[V]**

- Server: `GET /pos/offline-data` (full offline catalog: items, prices, taxes, customers, warehouses, cash
  locations, defaults) and `POST /pos/offline-sync` (batch replay with `offlineId` + `sequenceNo`). **[V]**
- Client (`apps/staff/lib/offline-db.ts`, `sync-engine.ts`, `apps/staff/app/pos/offline/page.tsx`):
  native IndexedDB (no Dexie), queue with per-device sequence, browser owns the offline copy while
  **the API remains the authority after replay**. **[V]**
- DB: `offline_queue` (migration 0102) is deliberately *not a second invoice store*: it records the original
  payload, replay identity and the outcome of the canonical POS checkout path; unique
  `(tenant_id, offline_id)` and `(tenant_id, device_id, sequence_no)`; statuses `pending|synced|conflict`
  with error codes surfaced to the cashier. **[V]**

### 4.8 Platform services & platform-owner plane **[V]**

- Jobs: BullMQ queue + `outbox_jobs` outbox pattern (`outbox.publisher.ts`), worker runner
  (`worker.runner.ts`, `WORKER=1` deployment), jobs console for platform admins.
- Notifications (in-app + email via Mailhog/SMTP), files (S3/MinIO with presigned URLs, download tokens,
  virus-scanner hook), usage metering (0069), announcements, support desk/tickets, weekly report,
  platform backups (S3-encrypted artifacts), developer plane (API keys), site analytics, content/CMS.
- Billing: `billing_plans`, `tenant_subscriptions`, `activation_requests` (request → platform admin review),
  Stripe checkout + webhook with `billing_webhook_events` dedupe `(provider, event_id)` (AUD-05/06 fixed;
  legacy `/billing/*` kept for live consumers but now runs under proper RLS contexts), dunning.
- Marketplace: `marketplace_apps` catalog (salla, zid, shopify, moyasar, ocr, esign, wms) + `tenant_apps`
  activation flags gating staff screens (`visibleModules` appGate) — activation is a row flag, **never
  executable code**. **[V]**
- Signup (public or disabled), leads, campaigns, impersonation (support) with explicit client consent,
  MFA, platform RBAC (`platform_memberships`/roles).

## 5. Frontend applications **[V]**

- `apps/staff` — the tenant ERP. Sidebar modules (`apps/staff/lib/navigation.ts`, ~2,300 LOC): dashboards,
  accounting (accounts, journal entries, ledger, trial balance, income statement, cost centers, periods,
  expenses, payment methods), inventory (+warehouse documents, vouchers), sales, POS (incl. offline),
  purchases, treasury, HRM/payroll, manufacturing, projects, approvals, reports, integrations, settings,
  van-sales (manager page ≈ 3,400 LOC + rep workspace `/van-sales/rep` ≈ 1,000 LOC), verticals (marina,
  optics, tailoring), employee self-service `/m/*` (attendance, requests, approvals), support.
  Session in `lib/session.tsx`; same-origin `/api/v1/*` proxy to the API (browsers never call the API host
  directly). AR/EN bilingual with `dir` switching. Offline IndexedDB for POS.
- `apps/platform-admin` — 30 console areas (see §4.8), dark-mode default.
- `apps/marketing`, `apps/customer-portal` — public surfaces; portal uses `portal` membership kind.
- Shared `@erp/ui` design system (tokens, RTL, dark mode, print).

## 6. Legacy context (why this exists)

- `docs/legacy/sql.txt`: a SQL Server DDL dump of the legacy desktop ERP (`Data16`, 185 `CREATE TABLE`
  statements, Arabic column semantics) — the desktop system the cloud platform replaces. **[V]**
- `apps/migrator` — wave-based migration engine with per-entity registry
  (`apps/migrator/src/registry/maps.ts`, generated `docs/registry-index.md`): foundation → branches →
  accounts → parties → items → journal replay → invoices → **inventory replay from documents** → vouchers →
  shift closes → FX → e-invoice artifacts → attachments, with variance payloads and blocking rules
  (unbalanced entries block; unknown document kinds block). **[V]**
- `apps/api/src/modules/compat/` — a narrow compat gateway for the *existing desktop client* (device keys,
  master pulls, document pushes with idempotency, per-device cursors). **[V]**

## 7. What is verifiably NOT there today

Verified by code search (no matches in `apps/api`/`packages/database`): **[V]**

- No fixed-assets register/depreciation.
- No budgets or budget-vs-actual.
- No standard costing (only perpetual weighted average; no cost-variance accounts).
- No dedicated offline-first *field-rep* application (offline exists only for POS invoices in `apps/staff`;
  `/van-sales/rep` is an online web page).
- No mobile app shell (the `/m/*` employee surface is a responsive web area inside `apps/staff`).
- No second product line or workspace separation — one product, one API, one deployment.

Partially there (needs decision/extension for the new product): WIP accounts for multi-stage manufacturing
(deliberately omitted — production consumes and outputs in one transaction, `wipAccountId` documented as
intentionally absent), bank reconciliation auto-posting (import + match + report only), bank feeds formats
beyond CSV, e-invoicing beyond ZATCA/KSA, multi-book/parallel accounting, intercompany.
