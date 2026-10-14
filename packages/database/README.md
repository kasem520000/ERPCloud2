# @erp/database

Drizzle schema, client factory, transaction/RLS helpers, migration runner and the
idempotent seeds. Canonical shapes live in `docs/DATABASE_DESIGN.md`; tenancy
rules in `docs/MULTI_TENANCY.md`.

## Public API

| Export                                                                                         | Purpose                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `createDatabase(url?, max?)`                                                                   | `{ db, pool, close() }` — one pool per process                                           |
| `getDb()` / `getDatabase()` / `closeDb()`                                                      | process-wide singleton handle                                                            |
| `withTx(db, work)`                                                                             | single transaction, **platform scope only** (no tenant GUC)                              |
| `withTenantTx(db, tenantId, work)`                                                             | transaction with `app.tenant_id` bound — **required for every tenant-scoped read/write** |
| `setTenantContext(tx, tenantId)`                                                               | raw GUC setter (`is_local = true`)                                                       |
| `readTenantContext(tx)`                                                                        | reads the GUC — used by the isolation harness                                            |
| `newId()`                                                                                      | UUID **v7**, application-side (`PROJECT_CONTRACT §2`)                                    |
| `baseAuditColumns()`, `baseSoftDeleteColumns()`, `baseTenantIdColumn()`, `baseLegacyColumns()` | shared column groups                                                                     |
| `citext`, `bytea`, `inet`                                                                      | custom column types                                                                      |
| `runMigrations(url?, opts?)`                                                                   | applies `migrations/*.sql` once each, checksum-guarded                                   |
| `runMigrationsDown(url?, opts?)`                                                               | applies `migrations/down/*.down.sql`                                                     |
| `configureDatabaseRoles(url?, opts?)`                                                          | grants LOGIN + password from env                                                         |
| `seedPlatform(url?, opts?)`                                                                    | idempotent permissions / demo tenant / roles / settings seed                             |
| `seedDemoData(url, opts?)`                                                                     | idempotent working dataset for a tenant: licence, org defaults, chart of accounts, cost centres, fiscal calendar, opening entry, extra users |
| `DEMO_CHART_OF_ACCOUNTS`, `DEMO_PLANS`                                                         | the seeded Arabic chart of accounts and the billing catalogue                            |
| `rlsProtectedTables`, `createTenantIsolationPolicySql()`, `createParentIsolationPolicySql()`   | RLS helpers                                                                              |
| `createAuditLogPolicySql()`, `revokeMutationsSql(table, role)`                                 | PHASE_04: nullable-tenant audit policy + append-only hardening                            |
| `SEQUENCE_SCOPE_NIL_UUID`                                                                      | sentinel used by the `document_sequences` unique index (NULL branch / fiscal year)        |
| `schema` (`tenants`, `users`, `memberships`, `roles`, …)                                       | Drizzle table objects                                                                    |

## Why `withTenantTx` and not `withTx`

`app.tenant_id` is set with `is_local = true`, so it only lives for the enclosing
transaction. Every tenant-scoped table also has `FORCE ROW LEVEL SECURITY`, which means a
query executed **outside** such a transaction returns zero rows even for the table owner.
That is the intended failure mode: forgetting the helper produces empty results, never
another tenant's data.

`refresh_tokens` and the other `DATABASE_DESIGN §1` platform tables have no RLS policy;
they are reachable through `withTx`.

The PHASE_04 tables (`audit_log`, `files`, `notifications`, `outbox_jobs`,
`idempotency_keys`, `document_sequences`) are all tenant-scoped and therefore all require
`withTenantTx` — including from background jobs. That is why `OutboxPublisher` and the
idempotency sweeper iterate tenants and open one transaction per tenant instead of
running a single global query: no component of the running system uses BYPASSRLS
(`PROJECT_CONTRACT §13.4`).

`audit_log` is the one exception to the canonical policy: `tenant_id` is nullable so that
platform-plane events (a login that never reached a tenant) can be recorded, so its
`WITH CHECK` uses `IS NOT DISTINCT FROM`. Those rows are write-only for `erp_api` — no
tenant session can read them back. `UPDATE`, `DELETE` and `TRUNCATE` are revoked from
`erp_api` entirely.

## Allocating document numbers

`document_sequences` is written **only** through `SequencesService` in
`apps/api/src/modules/platform-services` — never with a hand-rolled `SELECT max()+1`,
which cannot survive two concurrent callers. Pass the business transaction so the number
and the document commit or roll back together:

```ts
await withTenantTx(db, tenantId, async (tx) => {
  const number = await sequences.next({ tenantId, docType: 'sales_invoice', branchId }, tx);
  await tx.insert(salesInvoices).values({ /* … */ number: number.display });
});
```

The scope is `(tenant_id, branch_id, doc_type, fiscal_year_id)`; NULL branch/fiscal year
means "tenant-wide"/"does not restart yearly", and the unique index coalesces those NULLs
to `SEQUENCE_SCOPE_NIL_UUID` so one scope really is one row.

## Migrations

```bash
pnpm db:generate     # drizzle-kit draft → migrations/generated/ (review before folding in)
pnpm db:migrate      # applies migrations/*.sql in filename order, records checksums
pnpm db:migrate:down # reverts the most recent migration
pnpm db:roles        # grants LOGIN to erp_api / erp_migrator using env passwords
pnpm db:seed         # (run from apps/api) idempotent platform seed
```

Migrations are hand-written, idempotent SQL — not generated artefacts — because
`PROJECT_CONTRACT §13.4` and `MULTI_TENANCY §3` require the RLS/role statements to be
reviewed on every change. Editing an already-applied file is a hard error; add a new one.

## Roles

| Role           | RLS                                                 | Used by                         |
| -------------- | --------------------------------------------------- | ------------------------------- |
| `erp_api`      | enforced (`NOBYPASSRLS`, pinned on every migration) | the API at runtime              |
| `erp_migrator` | bypassed (`BYPASSRLS`)                              | `pnpm db:migrate`, offline only |
