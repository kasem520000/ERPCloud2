# IMPLEMENTATION_ROADMAP.md — Dependency-aware roadmap for the new specialized accounting ERP + field-sales app

> **Status:** live. M0 (safety net) **implemented and verified 2026-10-15** — see `PROGRESS.md` §7.
> Ordering rule: nothing that the rep app or accounting app *calls* may be built after the thing calling it;
> every milestone keeps `pnpm verify` (typecheck + lint + build + smoke + tests) as its exit gate.

## Milestone graph (arrows = "must finish before")

```
M0 Safety-net & decisions ──► M1 Van-sales decomposition ──► M4 Rep backend (field-sync + rep-workspace)
        │                              │                              │
        │                              │                              ▼
        ├─► M2 web-core extraction ────┼────────────────────► M5 Rep app (offline-first frontend)
        │                              │                              │
        └─► M3 Accounting-app scaffold ┴─► M6 Accounting feature gaps ─┴─► M7 Product packaging & pilot
```

## M0 — Safety net and binding decisions (before any product code) — ✅ IMPLEMENTED 2026-10-15

Implemented and verified (details and evidence in `PROGRESS.md` §7):

1. ✅ **R-19 fixed at the root**: `packages/testing/src/test-database.ts` removes the `async-exit-hook`
   `exit`/`beforeExit` listeners that `embedded-postgres` installs (the `beforeExit` one force-exited the
   process with a literal 0, masking vitest's failure exit code; the `exit` one crashed with
   `TypeError: done is not a function` once unmasked). Signal handlers (SIGINT/SIGTERM/SIGHUP/SIGBREAK) are
   preserved. Verified: red run exits 1, green run exits 0; permanent regression spec
   `apps/api/test/exit-code-gate.spec.ts` (spawns a real child that boots + stops the embedded server and
   exits with its own code). **Still open:** the CI-level canary on GitHub Actions (D-009) — prove it on the
   next real CI run once this branch is pushed.
2. ✅ **R-20 fixed** (`employee-movements.spec.ts` 8 tests): `hrm.service.ts` now reads the posting date in
   the tenant's business timezone (`(posted_at AT TIME ZONE <tz>)::date`), so the AUD-17 default window and
   the rows it compares live in one calendar; the spec's `today()`/`yesterday` compute the Riyadh business
   day the same way. Verified at 23:49 UTC — inside the 21:00–24:00 UTC window where all 8 failed before.
3. ✅ **R-01 fixed** (`printing-and-cards.spec.ts`): removed the locally-fabricated fallback ZATCA QR
   (`buildFallbackZatcaQr`, with its placeholder VAT number) from the sales-invoice print template; the QR
   slot now draws only the payload the e-invoicing module wrote (`zatca_qr`) and otherwise shows the honest
   «لم تُصدر بعد» note.
4. ✅ **R-04 fixed**: boot-time `verifySecretBoxRoundTrip()` canary called from both bootstrap paths in
   `apps/api/src/main.ts` — a missing/unusable `DATA_ENC_KEY` now fails the process at startup.
5. ✅ **R-17** (audit acceptance checklist re-run): partially covered — the full suite (isolation, rbac,
   auth, billing specs) is green; a dedicated pass over the audit's proposed negative-test matrix remains
   open (tracked below under M6 hardening).
6. ⬜ **Decisions D-002…D-007**: still PROPOSED — none blocks M1/M2; D-004/D-006/D-007 must close before
   M4/M5 scope is final. **D-009 CLOSED** 2026-10-15: the first post-fix CI run failed honestly on
   R-24 (an unhandled teardown error the old gate had been masking) — red pipelines now produce red
   conclusions on the runner (PROGRESS.md §8).

**Exit status:** zero red specs (199/199 files, 1671/1671 tests), zero unhandled errors, trustworthy
local gate **and** CI gate (D-009 canary evidence). M0 closed 2026-10-15; R-17's dedicated pass moves
to the hardening milestone.

## M1 — Van-sales service decomposition (prerequisite for the rep backend) — ✅ IMPLEMENTED 2026-10-15

Split `van-sales.service.ts` (6,479 lines) into cohesive services behind the same controller routes
(`load-orders`, `rep-documents`, `custody-settlement`, `production`, `pricing`, `reporting`):
- Pure code movement + constructor injection changes; **no table changes, no engine-call changes, no route
  changes**; all five van-sales spec files stay green without edits to their assertions.
- Add module-level README documenting the saga patterns (idempotency keys, `ifAlreadyReversed:'reuse'`).
**Why first:** the rep backend builds directly on these services; refactoring after would churn the new code.
**Exit:** specs green, review confirms no behavior drift (diff review of engine call sites).

## M2 — `packages/web-core` extraction (prerequisite for both new frontends) — ✅ IMPLEMENTED 2026-10-15

Implemented and verified (PROGRESS.md §9): API client + session, offline-db, sync-engine
moved verbatim into `@erp/web-core` behind re-export shims; `matchesPrefix` (AUD-13) and a
`createI18n` factory added as shared primitives; **14 new behavioral specs** (the module had
none — the old staff spec asserted source text only); staff builds/tests green on the new
package. DevDeps `happy-dom` + `fake-indexeddb` added (lockfile updated).

Original plan (kept for the record):

Move out of `apps/staff` (leave re-exports so staff keeps building unchanged):
- API client + session refresh (`lib/api.ts`, `lib/session.tsx` primitives),
- offline IndexedDB adapter (`lib/offline-db.ts`), sync engine (`lib/sync-engine.ts`),
- surface routing / i18n primitives as needed by both apps.
**Exit (met):** staff builds green importing from `@erp/web-core`; new package has its own specs (offline-db +
sync-engine behavior).

## M3 — Accounting app scaffold (frontend shell, no new backend)

- `apps/accounting-app` Next.js 15 app on `@erp/ui` + `web-core`, same-origin `/api/v1/*` proxy,
  session/permission shell, navigation for existing accounting surfaces (accounts, journals, periods, trial
  balance, statements, cost centers, ZATCA desk).
- Wire into root scripts (`typecheck`/`lint`/`test`/`build`) so `pnpm verify` covers it.
- Marketplace/plan gating entry (`tenant_apps` code) so the app is entitlement-controlled.
**Exit:** read-only screens render real tenant data through existing endpoints; verify green.

## M4 — Rep backend: `field-sync` + `rep-workspace` modules (API side of offline-first)

- `field-sync`: snapshot + delta endpoints (rep-scoped master data: customers + per-customer prices, items,
  tax groups, van warehouse `stock_balances`, price lists, payment methods, watermarks); replay endpoint with
  per-device sequence + `offlineId`; new `field_sync_queue` table (modeled on `offline_queue` — queue and
  conflict ledger only); every replay goes through `sales.postInTx` / treasury voucher engines.
- `rep-workspace`: day/visit summary, custody summary, closing submission — thin orchestration only.
- Scope enforcement on every rep route (per D-004 decision) with the AUD-03 negative-test matrix.
- Migration 0128+ (additive, reversible, RLS policies, `rlsProtectedTables` updated, reversibility spec).
**Exit:** integration specs: offline replay of invoice+collection+return against the engines; conflict codes;
isolation matrix; idempotent re-replay; concurrency on the same van stock.

## M5 — Rep app (offline-first frontend)

- `apps/rep-app`: PWA per D-006 (installable, service worker, background sync where available).
- Screens: login + snapshot sync, customer list with prices, van stock, invoice with bonus lines, receipt,
  return, day closing, conflict inbox, offline queue status.
- Custody UX: counted vs expected, explicit shortage policy submission (never silent).
**Exit:** acceptance tests replaying the exact API payloads the app sends (the repo's established pattern when
browser tests are unavailable); E2E in a browser when available.

## M6 — Accounting feature gaps (backend + accounting-app screens, ordered by dependency)

1. **Fixed assets** (register, categories, depreciation schedule + posting run) — isolated module, posts
   through `postJournalInTx` only.
2. **WIP stage for multi-step production** (per D-007 outcome: extend production engines or defer).
3. **Standard costing / variance** (only if D-007 selects it; engine-level change — highest risk, needs its
   own reversibility + migration specs).
4. **Budgets & budget-vs-actual** (depends on GL + reporting only).
5. **Bank reconciliation desk** (extend import+match+report toward reviewable match → post flow).
Each item: migration + service + specs + accounting-app screens, shipped independently.
**Exit:** per-feature acceptance specs; GL integrity suite (trial balance, reversal consistency) stays green.

## M7 — Product packaging & pilot

- Marketplace app codes + plans for the new packs (wholesale/manufacturing/food-factory/van-sales).
- Marketing site pages; platform-admin activation flow reuse; pilot tenants on staging with production-like
  data volumes; performance baseline for snapshot/replay (R-13).
**Exit:** pilot tenants run the full rep day (load → sell offline → sync → close → settle) and the accounting
close (period lock, statements, ZATCA filing) with zero manual ledger repairs.

## Explicitly out of scope until re-decided

Multi-region, second database, second API, native mobile shells beyond the D-006 choice, intercompany,
parallel multi-book accounting, automatic bank-reconciliation posting.
