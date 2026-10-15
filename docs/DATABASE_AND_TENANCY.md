# DATABASE_AND_TENANCY.md — Can the existing PostgreSQL safely host the new product?

> **Status:** Assessment deliverable (2026-10-14). Documentation only.
> Evidence markers: **[V]** verified in code/this session, **[R]** reported by repo docs, **[A]** assumption
> requiring validation. No migration was run against any pre-existing database; all executed tests ran on
> throwaway embedded PostgreSQL 16 clusters created and destroyed by the test harness.

## 1. Verdict

**The existing PostgreSQL (single database, shared schema, `tenant_id` + `FORCE ROW LEVEL SECURITY`,
transaction-local GUC) can safely host the new specialized accounting ERP and the field-sales product,
without a second database and without weakening isolation — provided the rules below are kept.** **[V]**
The isolation model is not a convention layered on top of application code; it is enforced by the database
against a `NOBYPASSRLS` runtime role, and it is regression-tested (`isolation.spec.ts`,
`surface-isolation.spec.ts`, `isolation-platform-services.spec.ts`, `isolation-organization.spec.ts`,
`rbac.spec.ts`, `packages/database/src/rls.spec.ts` — all executed green in this session except as noted in
`PROGRESS.md`).

Conditions (each is an existing, tested mechanism — the new product must not bypass any of them):

1. Every new table carries `tenant_id NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` and gets the
   canonical policy from `packages/database/src/rls.ts` (`createTenantIsolationPolicySql` /
   parent-derived for junction tables), plus `ENABLE` + `FORCE ROW LEVEL SECURITY`. Add the table to
   `rlsProtectedTables` and extend the RLS probe spec.
2. Runtime access only through `withTenantTx` (tenant GUC) or `withPlatformAdminTx` (control plane);
   the app role stays `NOBYPASSRLS`. No service may run raw SQL on `this.database.db` for tenant tables
   (the one historical offender, legacy billing, was already repaired — same pattern must not return).
3. Migrations: new numbered files only; the checksummed `erp_migrations` ledger refuses modified applied
   files; every migration ships a `down/` counterpart when it can be safely reversed; reversibility specs
   for schema-changing migrations (pattern: `migration-01xx-reversibility.spec.ts`).
4. Money stays `numeric(20,4)` + `decimal.js`; no floats ever.

## 2. How isolation works today (verified mechanics)

| Layer | Mechanism | Source |
|---|---|---|
| DB role | `erp_api` `NOBYPASSRLS`; `erp_migrator` for DDL | `packages/database/src/cli/roles.ts`, `.env.example` **[V]** |
| Policy | `tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid` on USING + WITH CHECK, FORCE RLS | `packages/database/src/rls.ts` **[V]** |
| Binding | `set_config('app.tenant_id', $tenant, true)` — local to the transaction, dies at COMMIT | `rls.ts` `setTenantContext` **[V]** |
| Access path | `withTenantTx(db, tenantId, work)` — 1,165 call sites; the only sanctioned path | `client.ts` **[V]** |
| Control plane | `withPlatformAdminTx` sets `app.is_platform_admin='on'`; matches only migration-0020 admin-plane policies | `client.ts`, `0020_platform_admin_plane.sql` **[V]** |
| Token | JWT `tid`/`mid` claims re-verified against active tenant + active membership; membership lookup itself runs RLS-scoped | `tenant.guard.ts` **[V]** |
| Public webhooks | No tenant context; tenant derived from verified signature/secret; audit attribution via `auditTenantId` | `request-context.ts`, AUD-14 fix **[V]** |
| Tests | Isolation harness + forged-token/suspended-tenant probes, run as `erp_api` | `apps/api/test/isolation*.spec.ts`, `@erp/testing` **[V]** |

Known limitation (not a defect by itself, but a decision point): `membership_role_scopes`
(warehouse/cash-location/POS-terminal restriction) is stored and published on the context, but enforcement
is opt-in per endpoint via `ScopePolicy.assertScope()` and currently consumed only by platform backups.
If the new rep app promises "this rep can only see his van warehouse", that promise must be enforced with
`assertScope` (or equivalent in-query filters) on every new endpoint — otherwise it is a UI filter, not a
security boundary. **[V]** (Open audit item AUD-03.)

## 3. Shared entities — single source of truth, no duplicates

The new product must **reuse these tables as-is**; creating parallel "rep customers" or "accounting items"
is forbidden by design (it would create a second source of truth and break ledger joins):

| Entity | Authoritative table(s) | Notes for the new product |
|---|---|---|
| Tenant | `tenants` (+`tenant_settings`, `tenant_apps`) | New product = new `marketplace_apps` code(s) / plan feature flags, not new tenancy |
| User / login | `users` | One identity per human across products |
| Tenant membership & RBAC | `memberships`, `roles`, `role_permissions`, `membership_roles`, `membership_role_scopes` | Rep = a membership with `van_sales.*` permissions (0126); `kind='staff'` |
| Employee (HRM dimension) | `employees` (+ HRM pack) | Salesman cards reference employees (`salesmen` — see below) |
| Salesman / rep | `salesmen` (van-sales) | Existing rep registry with `warehouse_id` fallback for the van warehouse; new app consumes, does not duplicate |
| Customer / supplier / any party | `parties` (+`party_accounts` via parties.receivable/payable) | Rep customers are `parties`; portal accounts link to parties |
| Product | `items` (+`item_units`, `item_barcodes`, `item_components`, lots, serials) | One catalog for accounting, van-sales, POS, e-commerce |
| Warehouse (incl. van warehouses) | `warehouses` | Van stock = `stock_balances` rows of a van warehouse — custody without a new ledger |
| Cash location | `cash_locations` (+ custodians, balances) | Rep cash custody via custodian rows/vouchers |
| Accounting dimensions | `accounts`, `cost_centers`, `journal_entries(+lines)`, `fiscal_periods`, `branch_posting_profiles`, `document_sequences` | The GL is the only GL |
| Branch | `branches` | Posting + numbering scope |
| Currency | `currencies`, `fx_rates` | Journal lines carry `currency_code`/`currency_amount`/`fx_rate` |

**Rule for new tables:** new product-specific tables (e.g. rep route plans, visit schedules, offline sync
state) live in the same schema with `tenant_id` + RLS, and reference the shared entities above by FK —
they never copy their fields.

## 4. Database strategy for the new product

1. **Same database, additive migrations (0128+).** No schema fork, no per-tenant databases, no separate
   "accounting product" schema namespace. Rationale: the product requirement is that both apps hit the same
   authoritative services; a second database would force cross-DB consistency — the exact class of bug the
   van-sales re-engineering fixed (derived vs official balances). **[V]** (mechanics) + architectural decision.
2. **New migrations must be additive and reversible**: new tables/columns with defaults; no edits to
   historical files (the runner hard-fails on checksum drift). Down-migrations for every forward migration
   where reversal is safe; reversibility spec per structural migration (existing pattern). **[V]**
3. **Volume/performance considerations (verified facts, sizes unknown — no production data in scope):**
   - `inventory_transactions` and `journal_entry_lines` are append-only ledgers with tenant-scoped indexes;
     van-sales adds movements per document line. For food-factory + van-sales volumes this is the hot path.
     Partitioning is explicitly a later decision (`PROJECT_AUDIT_IMPROVEMENTS_REVIEWED.md` phase 7 — measure
     before partitioning). **[R]**
   - The offline rep sync will add a queue table patterned on `offline_queue` (queue + conflict ledger, not
     a second invoice store). **[V]** (pattern) 
4. **Roles and secrets stay as-is**: runtime never sees the migrator URL; `DATA_ENC_KEY` required in
   production (AUD-16 — dev fallback exists; keep the startup validation strict for the new deployments). **[V]**
5. **Backups**: platform backups (0074, S3-encrypted artifacts) cover the shared database; a new product on
   the same DB inherits backup/restore semantics for free — another argument for one database. **[V]**

## 5. What would NOT be safe (explicitly rejected)

- **A second accounting engine or inventory ledger** (requirement from the task; also the repo's hardest-won
  invariant — the van-sales incident history in `VAN_SALES_REENGINEERING_DELIVERY_REPORT.md` is the case
  study of what happens when a module keeps derived state). **[R]**
- **Cross-tenant reporting by disabling RLS** (e.g. "platform analytics" reading tenant tables with the
  migrator role). The control plane has a dedicated, minimal admin-plane table set for exactly this. **[V]**
- **Storing tenant GUC on the pool/session level** (`set_config(..., false)`) — the transaction-local flag is
  the leak-proof design. **[V]**
- **Editing historical migrations** to "clean up" for the new product — runner hard-fails; and the
  immutability is what makes the `erp_migrations` ledger trustworthy. **[V]**
- **Reusing the `portal` membership kind for reps.** Portal members are denied every
  `@RequiresPermission` route by design; reps are staff members with scoped roles. **[V]**
