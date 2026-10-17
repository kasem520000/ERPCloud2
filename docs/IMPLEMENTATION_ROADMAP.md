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

## M3 — Accounting app scaffold (frontend shell, no new backend) — ✅ IMPLEMENTED 2026-10-15

Implemented and verified (PROGRESS.md §10): read-only screens over existing GET endpoints,
session/permission shell, marketplace entitlement gating (`accounting` code, operator-
disable respected), wired into `pnpm verify` and `next-run.mjs` (port 3005).

Original plan (kept for the record):

- `apps/accounting-app` Next.js 15 app on `@erp/ui` + `web-core`, same-origin `/api/v1/*` proxy,
  session/permission shell, navigation for existing accounting surfaces (accounts, journals, periods, trial
  balance, statements, cost centers, ZATCA desk).
- Wire into root scripts (`typecheck`/`lint`/`test`/`build`) so `pnpm verify` covers it.
- Marketplace/plan gating entry (`tenant_apps` code) so the app is entitlement-controlled.
**Exit (met):** read-only screens render real tenant data through existing endpoints; verify green.

## M4 — Rep backend: `field-sync` + `rep-workspace` modules (API side of offline-first) — ✅ IMPLEMENTED 2026-10-15

Implemented and verified (PROGRESS.md §11): migration `0128_field_sync_queue` (RLS,
reversible, fingerprints pinned); `field-sync` module — rep guard (D-004: identity +
warehouse scope via `assertScope`), snapshot + delta on a database-clock watermark, and
batch replay (invoice/collection/return/receipt) that goes only through the van-sales
sagas into `sales.postInTx` / the treasury voucher engine, with layered idempotency
(offlineId outcome replay, per-device monotonic sequence, `field-sync:{offlineId}` saga
keys) and `sourceOfflineId` for collecting a credit sale made offline; `rep-workspace`
module — day/visit summary, custody summary, rep-owned closing submission. Exit specs:
`field-sync.spec.ts` (11 tests incl. the D-004 negative matrix and concurrent replays on
the same van stock), `rep-workspace.spec.ts` (4), `migration-0128-reversibility.spec.ts`
(4); D-004 closed as DECIDED. Original plan kept for the record:


- `field-sync`: snapshot + delta endpoints (rep-scoped master data: customers + per-customer prices, items,
  tax groups, van warehouse `stock_balances`, price lists, payment methods, watermarks); replay endpoint with
  per-device sequence + `offlineId`; new `field_sync_queue` table (modeled on `offline_queue` — queue and
  conflict ledger only); every replay goes through `sales.postInTx` / treasury voucher engines.
- `rep-workspace`: day/visit summary, custody summary, closing submission — thin orchestration only.
- Scope enforcement on every rep route (per D-004 decision) with the AUD-03 negative-test matrix.
- Migration 0128+ (additive, reversible, RLS policies, `rlsProtectedTables` updated, reversibility spec).
**Exit:** integration specs: offline replay of invoice+collection+return against the engines; conflict codes;
isolation matrix; idempotent re-replay; concurrency on the same van stock.

## M5 — Rep app (offline-first frontend) — ✅ IMPLEMENTED 2026-10-16

Implemented per plan (details and evidence in `PROGRESS.md` §12):

1. ✅ `apps/rep-app` — PWA per D-006 (DECIDED): installable manifest, service-worker app shell
   (network-first navigations, cached shell offline, `/api/*` never intercepted), auto-sync on mount /
   `online` / 10s tick, phone-first five-tab shell with permission-filtered navigation.
2. ✅ Offline store (native IndexedDB, no Dexie — the web-core arrangement, rep-shaped): snapshot saved
   verbatim + watermark; delta applies `changed`/`deleted`/`full` exactly as the M4 contract frames them;
   queue records carry the four operations; device-level monotonic sequence.
3. ✅ Screens: login + rep-card gate (fail-open offline), sync (delta pull + full snapshot re-pull),
   customers with THEIR prices (locked price, bonus caps, credit), van stock with honest projections
   (pending ops move the numbers; conflicted ops move nothing), invoice with bonus lines + locked prices,
   collection on server documents or this device's own invoices (`sourceOfflineId`), return, online-only
   closing (counted vs expected + explicit shortage acknowledgment, D-008), conflict inbox with the
   server's resolution hints and explicit retry, queue status.
4. ✅ Custody UX: counted-vs-expected side by side; the difference is the shortage; submit stays disabled
   until the rep acknowledges it goes to the accountant (`pending_policy_approval`) — never silent.
**Exit met:** `apps/rep-app/tests/offline.spec.ts` (18) pins the payload builders against the M4 wire
shapes + the store/delta/projection math; `apps/api/test/rep-app-day.spec.ts` (7) replays the app's exact
payloads end-to-end through the real HTTP server (snapshot → one sequence-ordered batch: receipt → invoice
with bonus → self-collection with voucher → return → idempotent retry → delta shows the effect → closing
clean and short → day aggregation). Production build boots and serves every route + PWA assets. Browser
E2E deferred (no browser in this environment) — the payload-replay gate is the repo's established proxy.

## M6 — Accounting feature gaps (backend + accounting-app screens, ordered by dependency)

1. ✅ **Fixed assets** (register, categories, depreciation schedule + posting run) — shipped 2026-10-16
   (migration 0129 + `AssetsModule` + accounting-app screens; disposal deferred as out of roadmap scope).
   Isolated module, posts through `postJournalInTx` only.
2. ✅ **WIP stage for multi-step production** — shipped 2026-10-16 on the D-007-recommended
   basis (weighted average, actual consumption): `issue`/`complete` are two steps on the
   production-orders engine, `wipAccountId` posting key, migration 0130.
3. **Standard costing / variance** (only if D-007 selects it; engine-level change — highest risk, needs its
   own reversibility + migration specs).
4. ✅ **Budgets & budget-vs-actual** — shipped 2026-10-16: migration 0131 + `BudgetsModule`
   (draft/approved lifecycle, monthly distribution, computed variance report) +
   accounting-app screens. No stored second balance; approval freezes.
5. ✅ **Bank reconciliation desk** — shipped 2026-10-17: migration 0132 + reviewable
   match → post flow (`POST /treasury/bank-statements/:id/lines/:lineId/post` posts a
   pending line — bank charges, interest — as a balanced entry through `postJournalInTx`
   with a reviewer-confirmed counter account; posted lines carry their JE, refuse unmatch
   until the entry is reversed, and count into the reconciliation report; staff desk screen
   with the review card). Suggestions still only pre-fill the form — never posted silently.
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
