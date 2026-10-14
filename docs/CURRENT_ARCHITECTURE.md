# Current Architecture (as found)

Assessment date: 2026-10-15. Branch `main`, single commit `9ec342c Initial commit - Cloud SaaS ERP`.

Legend: **[V]** = verified by reading code / running a command in this assessment. **[A]** = assumption or inference, not verified. **[U]** = claim found in existing docs and not re-verified.

## 1. Monorepo

- [V] pnpm workspace, `packageManager: pnpm@9.15.0`. Root scripts: `test` = `pnpm -r run test`, `typecheck` builds `./packages/*` first and then typechecks everything.
- [V] Workspace packages have to be **built** (`dist/`) before dependent tests can run. `packages/database/src/rls.spec.ts` fails with `Failed to resolve entry for package "@erp/config"` until you run `pnpm --filter "./packages/*" run build`.

| Path | Name | Stack | Role |
|---|---|---|---|
| `apps/api` | `@erp/api` | NestJS, Drizzle, pg, BullMQ, jose, argon2, Stripe, pino, zod | The single backend for every app |
| `apps/staff` | `@erp/staff` | Next.js, React Query, react-hook-form | The current tenant ERP UI (accounting, inventory, sales, ...) |
| `apps/platform-admin` | `@erp/platform-admin` | Next.js | Platform-owner console |
| `apps/customer-portal` | `@erp/customer-portal` | Next.js | Tenant customers' portal |
| `apps/marketing` | `@erp/marketing` | Next.js | Public site and signup |
| `apps/migrator` | `@erp/migrator` | TS CLI | Imports legacy desktop data |
| `packages/config` | `@erp/config` | zod | Env parsing |
| `packages/contracts` | `@erp/contracts` | zod, decimal.js | Shared DTO and validation contracts |
| `packages/database` | `@erp/database` | Drizzle, pg | Schema, 128 SQL migrations (`0000`–`0127`), 112 down migrations, RLS helpers, seeds |
| `packages/testing` | `@erp/testing` | pg | Test DB harness (it starts an embedded/local PostgreSQL; the server logs showed up during test runs) |
| `packages/ui` | `@erp/ui` | React | Shared UI components and theme |

Deployment descriptors: `deploy/` and `deploy/k8s` (9 files) [V exists; content not reviewed].

## 2. API (`apps/api/src/modules`)

[V] There are about 40 Nest modules. Grouped:

- **Platform / control plane:** `platform/{auth,identity,tenancy,guards,decorators,scopes,rate-limit,billing,signup,leads,admin,context}`.
  - Auth: argon2 password hashing, jose JWT (`token.service.ts`), TOTP MFA, `secret-box.ts` for secrets at rest, and a password policy. Each of these has a spec.
  - Guards: `auth`, `tenant`, `permissions`, `branch-scope`, `platform-admin`, `rate-limit`.
- **Platform services:** `platform-services/{files,jobs,notifications,audit}`, `email`, `usage`, `backups`, `support`.
- **Accounting core:** `accounting` (chart of accounts, fiscal years and periods, period/module locks, journals, opening balances, statements), `treasury`, `banking`, `payments`, `installments`.
- **Inventory / trade:** `inventory` (15 files), `sales`, `purchases`, `pos`, `van-sales`, `operations`.
- **Tax:** `einvoicing/zatca` (`ubl.ts`, `qr.ts`, `csr.ts`, `gateway.ts`, `filing.ts`, `compliance-check.ts`, `zatca.spec.ts`).
- **Other verticals:** `hrm`, `employee`, `projects`, `marina`, `ecommerce`, `integrations/{salla,whatsapp}`, `ocr`, `ai`, `crm`, `dashboards`, `reporting`, `custom-fields`, `developer`, `supplier-portal`, `compat`, `migration`.

## 3. Data access and tenancy (summary; details in DATABASE_AND_TENANCY.md)

- [V] `packages/database/src/client.ts`:
  - `withTenantTx(db, tenantId, work)` opens a transaction and sets `app.tenant_id` with `set_config(..., true)` (transaction-local).
  - `withPlatformAdminTx` sets `app.is_platform_admin='on'` and leaves the tenant GUC unset.
  - `withTx` is platform scope only.
- [V] RLS policies have the form `tenant_id = current_setting('app.tenant_id', true)::uuid` for both USING and WITH CHECK.
- [V] `erp_api` is pinned `NOBYPASSRLS` (`src/cli/roles.ts`). Migrations run as a separate `erp_migrator` role.

## 4. Accounting posting

- [V] Schema (`0004_accounting.sql`):
  - `journal_entries` has `status` (`draft|posted|void`), `kind` (`manual|auto|reversal`), `source_type/source_id`, `reversal_of`, `idempotency_key`, and a unique index `(tenant_id, idempotency_key)`.
  - `journal_entry_lines` uses `numeric(20,4)` and a per-line CHECK that exactly one of debit/credit is > 0.
- [V] Trigger `prevent_posted_journal_mutation`: a posted entry cannot be changed, except an UPDATE that sets `status = 'void'`.
- [V] **There is one journal writer.** All modules post through `apps/api/src/modules/accounting/accounting.service.ts` (`postJournal` opens its own tx; `postJournalInTx` joins the caller's tx). The service enforces the balance (Σdebit = Σcredit).
  - [A] I found no DB-level balance constraint or deferred trigger in the migration grep. Balance is enforced in the service only.
- [V] Reversal conventions are defined by `0047_reversal_voids_original.sql` and `0125_journal_reversal_convention.sql`. `test/journal-reversal-consistency.spec.ts` passed (5 tests). It covers: voiding a sales invoice restores the trial balance exactly, and a cancelled stock transfer leaves inventory and goods-in-transit at net zero, including when two cancellations race.

## 5. Inventory ledger

- [V] `inventory_transactions` is append-only: trigger `inventory_transactions_immutable` rejects UPDATE and DELETE (`0006_inventory.sql`).
- [V] There is one ledger insert site: `apps/api/src/modules/inventory/inventory.service.ts:310`.
- [V] Projection `stock_balances` (quantity, value, `average_cost`) is maintained in the same service (lines ~263, 331, 598).
- [V] Costing modes: `inWithCost | outAtAvg | returnAtOriginalCost | outAtOriginalCost` (weighted moving average).
- [V] `test/inventory.spec.ts` passed (8 tests).

## 6. Van sales / representative custody

- [V] `apps/api/src/modules/van-sales/` is 3 files and 6,925 lines. Almost all of it is in `van-sales.service.ts`, written mostly as raw SQL.
- [V] Recent migrations: `0119`–`0124` (schema reconcile, idempotency, rep workspace, receipt workflow, stock and custody settlement) and `0126` (permissions).
- [V] What the module does correctly:
  - It uses `idempotency_key` on loads, moves, sales and receipts.
  - It locks rows with `FOR UPDATE` / `FOR UPDATE OF l`.
  - It creates its invoices through the authoritative sales engine (`this.sales.createInTx` / `this.sales.postInTx`, lines ~3429 and 3499).
- [V] It keeps its own `van_stock_movements`-style table. These moves write rows with `prod-move:`, `load-move:` and `prod-scrap:` key prefixes. Its relationship to `inventory_transactions` needs a reconciliation test (see risk R-05).
- [V] The controller exposes dashboard, reports, `me`, salesmen and account linking. I found **no offline sync or batch-upload endpoint** (grep for `offline|sync` in the controller found nothing).
- [V] `offline_queue` (an idempotency ledger for offline POS invoices) exists and is RLS-protected. It is a reusable pattern.

## 7. Frontends

- [V] `apps/staff` is the only tenant back-office UI. There is no dedicated accounting app and no field-representative app.
- [V] `apps/platform-admin` covers tenants, billing, identity, analytics, usage, email and console (API: `platform/admin/*.controller.ts`).

## 8. Existing documentation

[V] These files already exist and were **not modified**: `docs/CLOUD_ERP_TRANSFORMATION_MASTER_PLAN.md`, `PRODUCTION_POSTING_AND_MATERIAL_SOURCE_REPORT.md`, `PROJECT_AUDIT_FINDINGS_REVIEWED.md`, `PROJECT_AUDIT_IMPROVEMENTS_REVIEWED.md`, `VAN_SALES_*` (3 files), `docs/phases/PHASE_A`–`E`. Their claims are treated as **[U]** unless they are re-verified here.
