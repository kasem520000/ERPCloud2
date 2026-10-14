# Implementation Roadmap (dependency-ordered)

Each phase lists its dependencies and exit criteria. A phase is not "done" until its tests run and pass in CI.

## P0 — Baseline and verification (no product features)
Depends on: nothing.
- **P0-1** Catalog-driven RLS coverage test: migrate a fresh test DB, then assert that every table with a `tenant_id` column has `relrowsecurity AND relforcerowsecurity` and at least one policy. An explicit allow-list covers documented control-plane tables. Expected result: it fails and lists the real gaps (R-01, R-02, R-11).
- **P0-2** Fix the test bootstrap so packages build before tests (R-10).
- **P0-3** Run and record the full `pnpm test`, `typecheck` and `lint` (R-12).

Exit: the gap list is confirmed from the catalog and the full suite results are recorded.

## P1 — Tenancy hardening
Depends on: P0-1.
- Forward migration `0128_rls_hardening.sql` (+ down) that enables and forces RLS on the confirmed tables. Historical migrations stay unchanged.
- The P0-1 test turns green and becomes a required CI check.

## P2 — Ledger invariants
Depends on: P1.
- Migration: deferred constraint trigger for journal balance (R-04).
- Extract `PostingService` (single writer) and add a lint ban on `postJournal` outside the accounting module (R-07).
- Stock projection reconciliation test and job (R-08).
- Cross-tenant negative tests for posting and inventory inputs (R-03).

## P3 — Field-sales domain refactor
Depends on: P2.
- Split van-sales into `Custody`, `Route`/`Visit` and `Settlement` services with `*InTx` APIs, keeping its tests green.
- Prove van movements reconcile to `inventory_transactions` (R-05), then make one of them a projection.

## P4 — Sync API and entitlements
Depends on: P3.
- `ProductEntitlementGuard` + licensing SKUs + admin console UI.
- Device registration, command ledger, `/field-sales/sync/pull|push`, per-device document ranges, and the ZATCA offline reporting design (R-09, R-14).

## P5 — New frontends
Depends on: P2 (accounting app), P4 (field-sales app).
- `apps/accounting`: CoA, periods, journals, AR/AP, inventory valuation, tax, statements.
- `apps/field-sales`: offline-first PWA using `packages/sync-client`.
- Industry CoA templates and posting profiles.
