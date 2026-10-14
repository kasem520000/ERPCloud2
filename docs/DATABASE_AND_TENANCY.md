# Database and Tenancy

Legend: **[V]** verified, **[A]** assumption, **[U]** unverified.

## 1. Isolation model (verified)

- One PostgreSQL database. Shared tables use a `tenant_id uuid NOT NULL` column (pooled multi-tenancy).
- Policy form: `USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (same)`. When the GUC is unset, the comparison is NULL and no rows are visible. The model fails closed.
- `withTenantTx` binds the GUC transaction-locally (`set_config(..., true)`), so a pooled connection cannot leak the binding past COMMIT or ROLLBACK.
- `erp_api` is `NOBYPASSRLS`. The control plane uses `withPlatformAdminTx` (`app.is_platform_admin='on'`, with policies from migration `0020`) and never sets a tenant.
- Tests executed in this assessment:
  - `packages/database/src/rls.spec.ts`: 7/7 passed.
  - `apps/api/test/isolation.spec.ts`: 9/9 passed.

## 2. Coverage findings (static analysis of migration SQL)

I scanned every `CREATE TABLE`, `ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE POLICY` and `ARRAY[...]` loop in `packages/database/migrations/*.sql`:

| Metric | Value |
|---|---|
| Tables created | 214 |
| Tables with `tenant_id` | 182 |
| Tenant tables with **no RLS detected** | **16** |
| Tenant tables with RLS enabled but **FORCE not detected** | 18 |

**No RLS detected (16):**
- `backup_jobs`, `employee_branches`, `optics_field_labels`, `refresh_tokens`, `salary_adjustment_types`, `salary_payments`
- The `tailoring_*` family: `tailoring_garment_types`, `tailoring_invoice_payments`, `tailoring_invoices`, `tailoring_measurement_attributes`, `tailoring_option_categories`, `tailoring_option_values`, `tailoring_order_options`, `tailoring_order_statuses`, `tailoring_orders`, `tailoring_types`

**FORCE not detected (18):**
- `activation_requests`, `audit_log`, `branch_posting_profiles`, `branches`, `cash_location_balances`, `cash_locations`, `company_profiles`, `currencies`, `data_requests`, `document_sequences`, `fx_rates`, `idempotency_keys`, `notifications`, `outbox_jobs`, `price_list_items`, `price_lists`, `tenant_subscriptions`, `warehouses`

Caveats:
- [A] This is a regex scan. Some of these may be handled by dynamic SQL the scan missed, or may be control-plane tables on purpose (`refresh_tokens`, `backup_jobs`, `tenant_subscriptions`, `activation_requests`).
- [V] One counter-example: `0002_organization.sql` lines 339–348 **do** FORCE `company_profiles`, `branches`, `warehouses`, `cash_locations` and `cash_location_balances`. The scan missed these because of column-aligned whitespace. The FORCE list is therefore over-reported.
- **Required action:** before implementation, confirm against a migrated database with `pg_class.relrowsecurity / relforcerowsecurity` (see the roadmap, task P0-1).
- Why FORCE matters: without FORCE, the **table owner** bypasses RLS. `erp_api` does not own the tables [A: owner is `erp_migrator`; verify], so the practical risk is limited to owner-role code paths.
- [V] The hard-coded `rlsProtectedTables` list in `packages/database/src/rls.ts` is stale (for example, it omits the accounting tables). Do not use it as the source of truth.

## 3. Cross-tenant foreign keys

[V] Foreign keys such as `journal_entry_lines.account_id → accounts(id)` reference a bare `id`, not `(tenant_id, id)`. PostgreSQL checks FK constraints without applying RLS, so a row could reference another tenant's account if the service does not validate the id first.
- [A] The services load referenced rows inside `withTenantTx`, which would reject foreign ids. This is not proven for every caller.
- Action: either use composite FKs on new tables or add tests (risk R-03).

## 4. Can the existing database host the new modules?

**Yes, with conditions.** The model is sound, tested, and fails closed. Conditions:

1. Resolve the coverage gaps in §2 with a **new forward migration**. Historical migrations stay untouched.
2. Every new table must have `tenant_id NOT NULL`, ENABLE + FORCE RLS, the canonical policy, and composite `(tenant_id, id)` FKs where it references tenant data.
3. Add a catalog-driven CI test that fails when any table with `tenant_id` is missing RLS or FORCE.
4. The new product shares tenants with the existing ERP. Licensing decides which product a tenant can use; tenants are never split into a second database.

## 5. Shared entities: one source of truth

| Entity | Authoritative table(s) | Rule for the new apps |
|---|---|---|
| Tenant, subscription, plan | `tenants`, `tenant_subscriptions`, billing tables | Reuse. Add a product entitlement (e.g. `accounting_erp`, `field_sales`) and do not create a new tenant table |
| User / identity | platform identity + `memberships`, `roles`, `role_permissions`, `membership_role_scopes` | Reuse. Representatives are memberships with a role, not a separate user table |
| Employee | `hrm` employees | Reuse. A representative profile links to `employee_id` and `salesmen` |
| Customer / supplier | `parties` (+ `party_contacts`) | Reuse. Route visit data references `party_id` |
| Product | `items`, `item_barcodes`, `units_of_measure`, `tax_groups`, `price_lists` | Reuse. No product copy on the device beyond a read-only sync cache |
| Warehouse / van | `warehouses` (a van is a warehouse of type van) [A: verify that van-sales already models it this way] | Reuse. Custody equals the stock of the van warehouse |
| Accounts, cost centers, branches | `accounts`, `cost_centers`, `branches`, `branch_posting_profiles` | Reuse. These are the only accounting dimensions |
| Journals | `journal_entries` / `_lines` through `accounting.service.ts` | **Only writer.** No second engine |
| Stock ledger | `inventory_transactions` + `stock_balances` through `inventory.service.ts` | **Only writer.** Van movements must reconcile to it |
| Tax documents | `einvoice_*` through `einvoicing/zatca` | Reuse |
| Idempotency | `idempotency_keys`, `offline_queue` | Reuse for offline device sync |

## 6. Migration policy

- Never edit `0000`–`0127`. New work starts at `0128` and has a matching `down/` file, following the existing `migration-012x-reversibility.spec.ts` pattern.
- No migration is run against production during this assessment. None were run at all, except inside the disposable test harness.
