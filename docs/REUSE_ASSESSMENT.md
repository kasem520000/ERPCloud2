# Reuse Assessment

Categories:
1. Reuse as-is
2. Reuse after refactor
3. Reference only
4. Unsafe / unsuitable
5. Missing (needs new implementation)

"Tests" lists only tests actually executed in this assessment. "Not run" means the component has not been proven by this assessment.

## Platform

| Component | Path | Cat. | Evidence / reason | Action |
|---|---|---|---|---|
| Nest API server, bootstrap, logging | `apps/api/src` | 1 | Running architecture; helmet, pino | Host new modules here |
| Auth (argon2, JWT, MFA, secret box) | `apps/api/src/modules/platform/auth` | 1 | Unit specs passed (part of 123/123) | Reuse. Add a device-bound refresh flow for the rep app (cat. 5) |
| Guards (auth, tenant, permissions, branch scope, platform admin, rate limit) | `platform/guards` | 1 | Specs passed | Reuse. Add a `product-entitlement` guard (cat. 5) |
| Tenancy / memberships / roles | `platform/tenancy`, `platform/scopes` | 1 | Scope-policy spec passed | Reuse. Add rep and accountant roles through a new migration |
| Platform admin console + API | `apps/platform-admin`, `platform/admin` | 2 | Not run | Add per-product licensing and entitlements |
| Billing / subscriptions (Stripe) | `platform/billing` | 2 | Not run | Add product SKUs; no structural change expected [A] |
| Files, jobs (BullMQ), notifications, audit | `modules/platform-services/*` | 1 | `isolation-platform-services.spec.ts` exists (not run) | Reuse |
| Idempotency keys | `idempotency_keys` + middleware | 1 | `idempotency.spec.ts` 6/6 passed | Reuse for every write from both new apps |

## Database and tenancy

| Component | Path | Cat. | Evidence | Action |
|---|---|---|---|---|
| `withTenantTx` / `withPlatformAdminTx`, GUC model, NOBYPASSRLS role | `packages/database/src/client.ts`, `rls.ts`, `cli/roles.ts` | 1 | `rls.spec` 7/7, `isolation.spec` 9/9 | Reuse |
| RLS coverage | migrations | 2 | 16 tenant tables without RLS detected, 18 without FORCE detected (static) | Forward migration + catalog test (P0-1) |
| `rlsProtectedTables` constant | `rls.ts` | 3 | Stale | Replace with a catalog-driven check |
| Migration runner + down migrations | `packages/database/src/migrate.ts`, `migrations/down` | 1 | Reversibility specs exist (not run) | Reuse |

## Accounting

| Component | Path | Cat. | Evidence | Action |
|---|---|---|---|---|
| Journal schema + immutability trigger + idempotency index | `0004_accounting.sql` | 1 | DDL read | Reuse. Add a DB-level balance check (deferred constraint trigger) through a new migration |
| Posting engine `postJournal` / `postJournalInTx` | `modules/accounting/accounting.service.ts` | 2 | It is the single writer and the reversal spec passed 5/5. The large service mixes CoA admin, reports and posting | Extract a `PostingService` behind a narrow interface; keep a single writer |
| Reversal convention | `0047`, `0125` | 1 | Reversal spec passed | Reuse |
| Callers posting outside the caller's tx | e.g. `hrm.service.ts` `postAdjustmentEntry` → `postJournal` (own tx) | 4 (pattern) | Business write and journal are not atomic | Do not copy. New code must use `postJournalInTx` |
| Chart of accounts, fiscal periods, locks | `accounting` | 2 | `accounting-*` specs exist (not run) | Reuse the data. Rebuild the UI in the new accounting app |
| Statements / reporting | `modules/reporting`, `accounting` | 3 | Not run | Reference. Re-verify against the ledger before reuse |
| Desktop CoA seed | `packages/database/src/desktop-coa.ts` | 3 | Legacy-shaped | Reference. A new industry CoA template is needed (cat. 5) |

## Inventory and costing

| Component | Path | Cat. | Evidence | Action |
|---|---|---|---|---|
| Append-only ledger `inventory_transactions` | `0006_inventory.sql`, `inventory.service.ts:310` | 1 | Trigger read; `inventory.spec` 8/8 | Reuse as the only stock ledger |
| `stock_balances` projection + WAC | `inventory.service.ts` | 2 | Passes tests. No rebuild-from-ledger check found [A] | Add a projection-vs-ledger reconciliation job and test |
| Manufacturing / BOM | `boms`, `manufacturing_*`, `0127_production_batch_cost_basis.sql` | 2 | `inventory-bom.spec` exists (not run) | Food-factory costing (batch, yield, scrap, expiry) needs extension |
| Lots / serials / expiry | `inventory-batch-line`, `-serials` specs | 2 | Not run | Verify FEFO before food use |

## Sales, tax, van sales

| Component | Path | Cat. | Evidence | Action |
|---|---|---|---|---|
| Sales invoice engine `createInTx` / `postInTx` | `modules/sales/sales.service.ts` | 2 | Used by van-sales; void reversal passed | Make it the single invoice service for both new apps |
| ZATCA e-invoicing (UBL, QR, CSR, gateway) | `modules/einvoicing/zatca` | 1 | `zatca.spec` passed (within 123/123) | Reuse. Check the offline-invoice reporting window for rep devices |
| Van-sales module | `modules/van-sales/*` (6,925 lines) | 2 → partially 3 | Correct direction (idempotency, `FOR UPDATE`, delegates to the sales engine). It is a monolithic raw-SQL service with no offline sync API and a separate van movement table | Split into `custody`, `route/visit`, `settlement` services. Keep the data model. Prove van movements reconcile to `inventory_transactions` before reuse |
| `offline_queue` pattern | POS | 2 | RLS-protected | Generalise into a device sync ledger |
| Existing `apps/staff` UI | `apps/staff` | 3 | General ERP UI | Reference only for the new accounting app |

## Verticals not relevant to this product

| Component | Cat. | Note |
|---|---|---|
| `tailoring_*`, `optics`, `marina`, `salla`, vehicle fitment | 4 | Not needed. `tailoring_*` has no detected RLS; it must be fixed or isolated before the database is shared with a new product |
| `compat`, `migration` (legacy desktop import) | 3 | Reference for data migration only |

## Missing (category 5)

- Field-sales app: offline-first client, local encrypted store, device registration, sync protocol (pull deltas plus push of idempotent commands), and conflict rules.
- Server sync API: `/field-sales/sync/pull` and `/push`, a command ledger, and per-device sequence numbers.
- Product entitlements (`accounting_erp`, `field_sales`) in licensing, guards and the admin console.
- DB-level journal balance constraint, plus stock-projection reconciliation.
- Catalog-driven RLS coverage test in CI.
- Industry CoA and posting profiles for manufacturer, wholesaler, food factory and distributor.
- Rep custody statement: opening, loads, sales, returns, collections, settlement, and variance posting.
