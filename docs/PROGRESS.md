# PROGRESS.md — Assessment progress log

> **Status:** live log. Assessment phase closed 2026-10-14 (§§1–6); implementation phase started after
> owner approval — M0 log in §7 (2026-10-15). This file records what was actually done, executed and
> observed, in order. It distinguishes executed results from reported ones, per the task's honesty
> requirements.

## 1. Scope of this assessment pass

- Inspected the repository at branch `arena/5b07418c-erpcloud2`, base commit `9ec342c` ("Initial commit -
  Cloud SaaS ERP"), working tree clean at start. **[V]**
- Areas examined by direct code read: monorepo layout, root scripts, CI workflow, k8s deployment, docker
  compose; API app module (guards, request context, database service), accounting / inventory / sales /
  treasury / van-sales / pos / einvoicing / marketplace / billing / platform-services / compat / migrator
  modules; `packages/database` schema (41 files) + migration ledger mechanics + RLS helpers;
  `packages/contracts`, `packages/config`, `packages/testing`; `apps/staff` navigation + offline POS layer +
  van-sales screens; `apps/platform-admin` surface; existing `docs/` (master plan, audits, van-sales
  engineering reports, phase docs); `docs/legacy/sql.txt` legacy dump.
- No source file was modified. No migration was applied to any persistent database (all test runs used
  throwaway embedded PostgreSQL 16 clusters created and destroyed by the test harness). Nothing was
  committed, pushed, or deployed. **[V]**

## 2. Commands executed and their ACTUAL results (2026-10-14, UTC)

| # | Command | Result |
|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | success (17.1 s) |
| 2 | `pnpm --dir apps/api run test` (full suite, run 1) | **196/198 files, 1660/1669 tests passed — 2 files / 9 tests FAILED** (503 s) |
| 3 | `pnpm --dir apps/api run test` (full suite, run 2, full log) | identical: **9 failed / 1660 passed**; failures deterministic (531 s) |
| 4 | `pnpm --dir packages/contracts run test` | **239/239 passed** (26 files) |
| 5 | `pnpm --dir packages/config run test` | **16/16 passed** (3 files) |
| 6 | `pnpm --dir packages/testing run test` | **12/12 passed** (1 file) |
| 7 | `pnpm --dir packages/ui run test` | **21/21 passed** (1 file) |
| 8 | `pnpm --dir packages/database run test` (before building deps) | **FAILS to even load**: `rls.spec.ts` cannot resolve `@erp/config`/`@erp/contracts` (unbuilt dist) — 46 tests in the other 5 files pass |
| 9 | `pnpm --dir packages/config run build` + `pnpm --dir packages/contracts run build` + `pnpm --dir packages/database run test` | **53/53 passed** (6 files) — matches the repo's documented caveat that packages must be built first |
| 10 | `pnpm --dir apps/staff run test` | **83/83 passed** (14 files) |
| 11 | `pnpm --dir apps/platform-admin run test` | **27/27 passed** (3 files) |
| 12 | `pnpm --dir apps/customer-portal run test` | **8/8 passed** (3 files) |
| 13 | `pnpm --dir apps/marketing run test` | first run: **99 passed + 1 skipped** (12 files); two later runs (incl. inside `pnpm verify`): **100/100 passed** — the skip is occasional, not a failure. Note: repo docs (2026-10-01) recorded "98/99, 1 pre-existing failure"; that failure no longer reproduces |
| 14 | `pnpm --dir apps/migrator run test` | **4/4 passed** (1 file) |
| 15 | `pnpm --filter @erp/api run typecheck` (before building packages) | **FAILS** (~2,236 errors — all `Cannot find module '@erp/database'` cascades; unbuilt workspace dist) |
| 16 | build `@erp/config`, `@erp/contracts`, `@erp/database`, then `pnpm --filter @erp/api run typecheck` | **CLEAN** |
| 17 | typecheck `apps/staff`, `apps/platform-admin`, `apps/marketing`, `apps/customer-portal`, `apps/migrator` | **all CLEAN** |
| 18 | `npx vitest run test/printing-and-cards.spec.ts` | **1 failed / 8 passed** — and **exit code 0** (see #20) |
| 19 | employee-movements failure analysis (code read, no code change) | root cause: report default window = today in `Asia/Riyadh`; spec `today()` = UTC date → fails after 21:00 UTC |
| 20 | exit-code probe: temporary deliberately-failing spec, run then deleted | **"1 failed" with exit code 0**, reproduced with default pool and `--pool=threads` (risk R-19) |
| 22 | `gh run list` / `gh api …/actions/runs` (read-only) | the repo's only CI run ("Verify" on base commit `9ec342c`, 2026-10-14T22:44Z) concluded **success** — despite that commit failing at least the always-red `printing-and-cards.spec.ts` → CI masks red tests (R-19 confirmed at CI level) |
| 21 | `pnpm run verify` (full gate) | **exit 0 — but with the same 9 red API tests inside** (all other stages green); see §4. Side effect: the `openapi:export` stage rewrote `packages/contracts/openapi.json` (+440 lines — the committed artifact was stale, risk R-21); the file was **reverted** afterwards to keep this assessment docs-only |

### The 9 failing API tests (both runs, identical)

`test/printing-and-cards.spec.ts` (1):
- "prints a sales invoice with the company, the customer, the lines and the amount in words" — pre-existing,
  also documented as failing in `PRODUCTION_POSTING_AND_MATERIAL_SOURCE_REPORT.md`.

`test/employee-movements.spec.ts` (8) — all one root cause (R-20, timezone/time-of-day):
- "كشفٌ فارغ قبل أي حركة" (`expected '2026-10-15' to be '2026-10-14'` — Riyadh vs UTC date)
- "فاتورة بيع بسطرين …" (`expected [] to have a length of 2`)
- "مرتجع بيع يُطرح من «💰 الإجمالي»", "🔄 نوع الحركة", "فاتورة نقطة بيع", "الكل", "🏢 الفرع — فرعٌ بلا حركات",
  "فاتورةٌ مُلغاة لا تُحسب"

## 3. What was NOT executed

- `pnpm --dir apps/api run test:smoke` standalone, `openapi:export` standalone, and `lint` standalone were
  not run separately — they are included in the `pnpm verify` run (#21).
- No browser/E2E test (no browser binary in this environment; consistent with repo docs' note that
  Playwright is unavailable here). No load/performance tests. No test was run against any persistent or
  production-like database.

## 4. `pnpm verify` (full pipeline) result — EXECUTED 2026-10-14 (≈23:14–23:31 UTC)

Full gate `typegen → typecheck → lint → build → api smoke → all workspace tests → openapi:export`:

| Stage | Actual result |
|---|---|
| `typegen` | pass (no drift) |
| `typecheck` (builds packages, then all workspaces) | pass |
| `lint` (all workspaces) | pass (pre-existing `boundaries` config warnings only) |
| `build` (all apps + packages) | pass — staff, platform-admin, marketing, customer-portal, migrator, api, packages all compile |
| `apps/api` smoke check | **pass** — "AppModule boots, /health/live is 200, guards emit problem+json 401" |
| `apps/api` test | **2 files / 9 tests FAILED (196/198 files, 1660/1669 tests)** — same deterministic failures as §2 |
| all other suites | pass: contracts 239, config 16, database 53, testing 12, ui 21, staff 83, platform-admin 27, customer-portal 8, marketing 100, migrator 4 |
| `openapi:export` | pass — document written to `packages/contracts/openapi.json` |
| **Pipeline exit code** | **0 — `VERIFY_EXIT=0`, i.e. the gate reported SUCCESS despite the 9 red tests** |

**This is the single most important infrastructure finding of the assessment (risk R-19, decision D-009):
in this environment the full CI gate does not fail on red tests — and this is confirmed at CI level, not
just in the sandbox.** The repository's own sole GitHub Actions "Verify" run on the exact base commit
(`9ec342c`, started 2026-10-14T22:44:31Z, checked read-only via `gh api`) concluded **success**, while the
same commit run locally eight minutes later had 9 failing tests — including `printing-and-cards.spec.ts`,
which fails at any hour (pure HTML assertion, not timezone-dependent). CI therefore masked at least that
failure. The gate's other stages (typecheck, lint, build, smoke, OpenAPI) are healthy; the failure-masking
is specific to the vitest exit path (also reproduced standalone with a minimal failing probe: "1 failed",
exit code 0). The gate must be fixed and proven with a red canary before any reuse claim rests on
"CI is green".

## 5. Deliverables produced in this pass (docs only)

- `docs/CURRENT_ARCHITECTURE.md` — the verified existing architecture.
- `docs/REUSE_ASSESSMENT.md` — per-component reuse decisions with paths and evidence.
- `docs/TARGET_ARCHITECTURE.md` — recommended monorepo/API structure for the new product.
- `docs/DATABASE_AND_TENANCY.md` — database strategy and tenancy verdict.
- `docs/LEGACY_RISK_REGISTER.md` — 21 risks with severity and required actions.
- `docs/IMPLEMENTATION_ROADMAP.md` — dependency-aware milestones M0–M7.
- `docs/DECISIONS.md` — decision register D-001…D-010.
- `docs/PROGRESS.md` — this log.

## 6. Next exact task (after review approval)

Per the roadmap: **M0, step 1** — make the test gate trustworthy and deterministic: (a) CI canary proving
red tests fail the pipeline (R-19), (b) timezone-explicit `employee-movements.spec.ts` (R-20), (c) fix or
formally waive `printing-and-cards.spec.ts` (R-01). Nothing else should start until M0 exits.

---

## 7. M0 IMPLEMENTATION LOG (2026-10-15) — work started after owner approval («ابدأ العمل»)

Owner approved the assessment and instructed to start work 2026-10-14. M0 implemented 2026-10-15,
all changes in the working tree of `arena/5b07418c-erpcloud2` (no commit/push yet, per standing
constraint — see §7.6 for the pending-offer note).

### 7.1 R-19 — CI gate exit-code masking (P1) — FIXED AND VERIFIED

- **Root cause (new, diagnosed this session):** importing `embedded-postgres` (via
  `@erp/testing/database` → `startTestDatabaseServer`) registers `async-exit-hook` handlers on
  **both** `exit` and `beforeExit`. The `beforeExit` handler force-exits the process with a literal
  `exitCode 0` — masking vitest's failure exit code. A prior session had identified only the
  `beforeExit` listener; removing only that one surfaced `TypeError: done is not a function` from the
  remaining `exit` listener (it invokes the async hook synchronously with no callback), crashing the
  process on the exit path. **Both listeners added during the import window must be removed.**
- **Fix:** `packages/testing/src/test-database.ts` — snapshot `process.listeners('exit'/'beforeExit')`
  before importing `embedded-postgres`; after `server.start()` remove listeners added since the
  snapshot on **both** events. Signal handlers (SIGHUP/SIGINT/SIGTERM/SIGBREAK) are untouched.
  `packages/testing` dist rebuilt (`pnpm --dir packages/testing run build`).
- **Verified, both directions, full `apps/api` config (embedded PG, forks/singleFork):**
  - Green run → vitest exits **0** (previously also 0 — must not regress).
  - Red run (temporarily-failing probe spec, since deleted) → vitest exits **1** — previously exited 0.
- **Regression spec (permanent):** `apps/api/test/exit-code-gate.spec.ts` — spawns a real
  `node_modules/.bin/tsx` child that imports `@erp/testing/database`, starts + stops the embedded
  server, and exits with code 6; asserts the child's actual exit code is 6. This pins exactly the
  property that was broken: *the process exit code after using the embedded test database must
  reflect the intended code, not be swallowed*.
- **Still open (D-009):** the same proof on the GitHub Actions runner — needs the first post-fix CI
  run once this branch is pushed.

### 7.2 R-20 — `employee-movements.spec.ts` time-of-day flakiness (P1) — FIXED AND VERIFIED

- **Fix (service):** `apps/api/src/modules/hrm/hrm.service.ts` — new
  `resolveBusinessTimezoneInTx` (validates tenant tz via `Intl`, falls back per existing convention)
  and `resolveBusinessTodayInTx`; `employeeMovements` derives its business date as
  `((posted_at AT TIME ZONE :tz)::date)` in select/filter/orderBy, so the default "today" window and
  the rows it selects live in the same calendar. Payroll callers (L~1498/L~1558) are untouched.
- **Fix (spec):** `apps/api/test/employee-movements.spec.ts` — `today()`/`yesterday()` computed with
  `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' })`.
- **Verified:** 11/11 passed at 23:49 UTC 2026-10-14 — inside the 21:00–24:00 UTC window where all 8
  previously failed; again green in the 2026-10-15 full run.
- **New finding:** `salesmanCommissions` (`apps/api/src/modules/sales/sales.service.ts` ~L2362)
  defaults to UTC-today — internally consistent but convention-inconsistent → registered as **R-22**
  (P3), to align during M1 sales-module work.

### 7.3 R-01 — `printing-and-cards.spec.ts` fabricated ZATCA QR (P1) — FIXED AND VERIFIED

- **Fix:** `apps/api/src/modules/reporting/print-templates.service.ts` — deleted
  `buildFallbackZatcaQr` (+ its `dateIso` helper, verified unused elsewhere). The sales-invoice
  template's QR slot now draws only the payload the e-invoicing module stored
  (`sales_invoices.zatca_qr`); an unissued invoice shows the honest «لم تُصدَر بعد» note instead of a
  fabricated TLV QR with a placeholder VAT number (compliance + honesty fix, matches the documented
  spec intent).
- **Verified:** 9/9 `printing-and-cards.spec.ts` green, and again green in the 2026-10-15 full run.

### 7.4 R-04 — `DATA_ENC_KEY` boot canary (P2) — FIXED

- **Fix:** `apps/api/src/modules/platform/auth/secret-box.ts` — new `verifySecretBoxRoundTrip()`
  (seal→open a probe under the resolved key; missing key throws via the fail-closed
  `dataEncryptionKey()` resolver). Wired into **both** bootstrap paths in `apps/api/src/main.ts`
  (`bootstrap()` API + `bootstrapWorker()`), immediately after `assertRuntimeEnv()` — a deployment
  without a usable key now fails at startup, before accepting traffic, not at first secret use.
- **Spec:** `secret-box.spec.ts` extended — canary passes under the resolved key; the
  missing-key-at-boot failure mode is pinned by the existing `decideDataEncryptionKey(undefined,
  'production')` case. 7/7 green.

### 7.5 Full-suite baseline after M0 (2026-10-15, UTC)

- `pnpm --dir apps/api run test`: **Test Files 199 passed (199) · Tests 1671 passed (1671) · exit 0.**
  (Baseline at base commit: 198 files / 1669 tests — 1660 passed, 9 failed; +1 file, +2 tests, 0 fail.)
- `pnpm --filter @erp/api run typecheck` clean; `pnpm --dir packages/testing run typecheck` clean;
  ESLint on all eight touched/new files: clean (only the pre-existing boundaries-config warning).
- `packages/contracts/openapi.json` untouched (R-21 note: no `pnpm verify` run since its last
  regeneration; it will regenerate on the next root verify).

### 7.6 M0 status and hand-back

- **Done:** R-19, R-20, R-01, R-04 fixed + regression-pinned; full suite green; register/roadmap
  updated (R-01/R-04/R-19/R-20 RESOLVED; R-22 added).
- **Still open in M0:** (a) D-009 CI canary — prove the gate on GitHub Actions after the next push;
  (b) R-17 dedicated audit-acceptance pass; (c) owner sign-offs D-002…D-007 (none blocks M1/M2).
- **Next milestone:** M1 — van-sales decomposition (read-path decomposition of
  `vanSales.service.ts` 3.7k lines, R-05/R-06/R-07/R-08/R-10/R-13/R-14) per `IMPLEMENTATION_ROADMAP.md`.
- Per the standing constraint, **no commit/push was made**; when the owner confirms, the natural
  commit is a single M0 commit containing the seven modified files + `exit-code-gate.spec.ts` +
  the eight `docs/` files.

---

## 8. M0 PUSH + CI CANARY EVIDENCE + R-24 (2026-10-15)

### 8.1 M0 pushed; CI fails — honestly (D-009 evidence)

Owner approved push («قم بدفعه الى الفرع ثم واصل العمل»). Commit `228b612` pushed to
`arena/5b07418c-erpcloud2`; GitHub Actions "Verify" run `38658122368` (00:06–00:20 UTC) failed
after 13m59s — **the first honest CI conclusion in this repository** (base run `38649688338`
took 13m33s and "succeeded" while 9 tests failed). This is exactly the canary evidence D-009
required: the post-R-19 gate propagates red to the job conclusion on the real runner.

### 8.2 Root cause of the CI failure — R-24 (new, P1, FIXED)

Reproduced locally with a full `pnpm verify`: **199/199 spec files passed, 1671/1671 tests
passed — and vitest still exited 1** with `Errors 1`: an unhandled `FATAL 57P01` from a pg
client of `erp_test_contractor_contracts_9906_115`.

- **Mechanism (read from pg-pool 3.14 source):** `pool.end()` resolves when clients leave the
  pool's bookkeeping (`_clients`), but `_remove` calls the async `client.end()` afterwards —
  the promise does **not** wait for sockets to finish closing. `test-app.ts` then immediately
  ran `dropDatabase` → `pg_terminate_backend` → the still-draining client received `57P01` →
  pg-pool re-emitted it on the pool → no `'error'` listener was attached → unhandled `'error'`
  event → vitest "Errors 1", exit 1 with an all-green suite.
- **Why only sometimes:** the window is milliseconds; earlier full runs won the race, CI and the
  local repro lost it. **This has been firing intermittently all along — R-19's exit-code hijack
  is what kept it invisible** (the base-commit CI "passed" the same way).
- **Fix (two layers):**
  1. `packages/database/src/client.ts` — `createPool` now attaches a logging `'error'` listener:
     an idle-client error (PG restart, LB idle-drop, teardown termination) is logged and the
     pool keeps serving, instead of crashing the process / failing the run. Pinned by
     `packages/database/src/client.spec.ts` (54th database test).
  2. `apps/api/test/test-app.ts` — `trackPoolDrain()` attaches **before** `app.close()` and waits
     for every removed client's end-callback (pool `'remove'` events) before `dropDatabase`
     (5s safety timeout so a pathological close can only degrade to the now-logged race).
- **Verified:** full apps/api suite: 199/199 files, 1671/1671 tests, zero unhandled errors,
  zero pool-error log lines (layer 1 removed the race; layer 2 never fired), exit 0.
  Registered as **R-24** (P1, resolved) in `LEGACY_RISK_REGISTER.md`.

### 8.3 M1 — van-sales decomposition (implemented, verification in §9)

Started after the push instruction. Design notes before the split:
- Blast radius contained: only `van-sales.controller.ts` and `van-sales.module.ts` referenced
  `VanSalesService`; all five spec files go through HTTP (`test/http.ts`), so the public surface
  to preserve is exactly the controller routes.
- Method-level call graph extracted programmatically (37 methods, reconstruction check: zero
  lines lost); target split chosen acyclic:

```
shared (engines: postingProfiles, notifications)   ← tx helpers + settling guard + count lot
reporting → shared                                 ← dashboard (read model) + reports
pricing → shared, reporting                        ← upsertCustomerPrice, shortage price
production → shared, reporting                     ← factory batches
load-orders → shared, reporting                    ← supply saga, receipt, transit, cancel
documents → shared, reporting                      ← createDocument, returns, print, workspace
custody → shared, reporting, pricing               ← closing, settlement, collections, salesmen
legacy → shared                                    ← reconcileLegacyData
```

- `dashboard` doubles as the load-order read model consumed by the sagas — documented in the new
  module README as a "pure read" invariant that keeps the graph acyclic.
- New file `apps/api/src/modules/van-sales/README.md` documents the decomposition table, the
  dependency graph and the saga patterns that must be preserved (3-step supply saga +
  conservative compensation via official `cancelTransfer`; idempotency keys incl. derived stable
  keys and the `invoice_payments` uniqueness; resume-reuse for `settle-stock`;
  `ifAlreadyReversed:'reuse'`; custody-honesty "in transit until confirmed").
- **R-23 registered (P2):** `createDocument` builds its own ZATCA TLV QR
  (`buildZatcaTlvBase64`) with hard-coded fallbacks (seller name / VAT `300000000000003`) — same
  fabrication pattern as R-01, now on the van-sales *write* path. Left unchanged in M1 (pure
  movement); fix belongs to the e-invoicing milestone.

### 8.4 M1 verification

- Typecheck (`@erp/api`) clean after the split; ESLint clean on the whole `van-sales/` directory.
- The five van-sales spec files through HTTP, unedited: **5/5 files, 32/32 tests, exit 0.**
- Full apps/api suite (with the split + R-24 fix in the tree): **199/199 files, 1671/1671
  tests, zero unhandled errors, exit 0.**
- All other workspaces green under the same tree (`pnpm -r run test`): config 16, ui 21,
  contracts 239, database 54 (incl. the new `client.spec.ts`), platform-admin 27, marketing 100,
  staff 83, customer-portal 8, migrator 4, testing 12 — plus `test:smoke` and full build
  reached in the §8.2 repro run (the pipeline stopped only at the since-fixed apps/api step).
- `packages/contracts/openapi.json` untouched (no `pnpm verify` completed past the test stage
  this session; routes and DTOs are unchanged by the split, so no drift is expected on CI's
  export step).

---

## 9. M1 CI GREEN + M2 `packages/web-core` (2026-10-15)

### 9.1 CI verdict on the M1/R-24 commit — first honest green run

Run `38662688487` (commit `c4142c0`, 00:54–01:07 UTC) concluded **success** on the full
`pnpm verify` pipeline. Sequence of the three CI runs, for the record:

| Run | Commit | State | Conclusion | Meaning |
|---|---|---|---|---|
| `38649688338` | `9ec342c` (base) | 9 failing tests | "success" | gate broken — failures masked (R-19) |
| `38658122368` | `228b612` (M0) | all tests pass, 1 unhandled error | **failure** | gate honest — R-24 unmasked |
| `38662688487` | `c4142c0` (M1+R-24) | all green | **success** | gate honest and pipeline green |

**D-009 is now proven in both directions at CI level.** The reuse safety net exists.

### 9.2 M2 — `@erp/web-core` extraction (implemented and verified)

New workspace package `packages/web-core` (ships TypeScript source, compiled by each app —
same model as `@erp/ui`/ADR-030):

- `src/api.ts` — verbatim move from `apps/staff/lib/api.ts` (API client, bearer token,
  transparent refresh on 401, problem+json errors, P-C8 support-token session).
- `src/session.tsx` — verbatim (React session provider over the api client).
- `src/offline-db.ts` — verbatim (IndexedDB adapter: catalog cache + offline invoice queue).
- `src/sync-engine.ts` — verbatim (replay engine; posts only pending; newest-first).
- `src/surface-routing.ts` — the AUD-13 whole-segment `matchesPrefix` primitive; each app
  keeps its own prefix lists (staff's `/m`, `/supplier-portal`, `/esign` stay in staff).
- `src/i18n.tsx` — NEW `createI18n(strings)` factory extracted from the staff provider:
  the bilingual/RTL/LTR behavior and storage key are shared, the dictionary stays in each
  app (product content ≠ infrastructure). `apps/staff/lib/i18n.tsx` now builds its
  unchanged export surface (`STRINGS`, `translate`, `dirFor`, `LanguageProvider`,
  `useLang`, `LANGUAGE_STORAGE_KEY`, `Lang`) from the factory.

Staff keeps building unchanged through one-line re-export shims at the original paths
(`lib/api.ts`, `lib/session.tsx`, `lib/offline-db.ts`, `lib/sync-engine.ts`) — no app file
was modified for imports; `next.config.mjs` transpiles the new package; `package.json`
gains `@erp/web-core: workspace:*`.

**New behavioral specs (the old staff spec only asserted source text):**
- `packages/web-core/tests/offline-db.spec.ts` — device id stability, sequence
  monotonicity, queue ordering (newest first), synced-only cleanup keeping
  conflicts/pending, patch semantics + missing-id handling, catalog bundle round-trip.
- `packages/web-core/tests/sync-engine.spec.ts` — posts pending records with identity +
  bearer token (fetch stubbed), applies synced/conflict results per ticket, offline and
  empty-queue no-ops, conflict retry re-posts the same offlineId.
- `packages/web-core/tests/primitives.spec.ts` — AUD-13 segment matching (the
  `/marina`-vs-`/m` regression) and i18n dictionary semantics.
- Environment: `happy-dom` + `fake-indexeddb` (new devDependencies, lockfile updated).

**Two staff meta-specs updated to follow the moved code (assertions unchanged in
substance):** `tests/offline-pos.spec.ts` and `tests/permission-codes.spec.ts` read the
offline/sync/session sources from `packages/web-core/src/` instead of the staff shims.

**Verification:** web-core 3/3 files, 14/14 tests; staff 14/14 files, 83/83 tests;
staff `next build` green (the M2 exit criterion); root `pnpm -r run lint` and
`pnpm -r run typecheck` clean across all workspaces.

### 9.3 What is deliberately NOT in M2

- `lib/use-query.ts`, `lib/sync.ts`, `lib/employee-offline.ts` — staff-specific
  orchestration, they stay in staff and import the shims.
- The full i18n dictionary and the staff surface prefix lists stay in staff (content).

---

## 10. M3 — accounting app scaffold (2026-10-15, implemented and verified)

### 10.1 What was built

`apps/accounting-app` — the accountant-focused surface, **read-only over existing
endpoints** (no new backend, no writes):

- **Shell**: `@erp/ui` theme + `@erp/web-core` session/i18n/use-query/surface-routing;
  same-origin `/api/v1/*` rewrite, CSP + hardened headers, `output: standalone` — the same
  `next.config.mjs` posture as staff. Login follows the staff contract (tenant code +
  e-mail + password, `MFA_REQUIRED` step; no signup — account lifecycle stays in staff).
- **Screens** (each a `GET` only, permission-honest in the sidebar and the home tiles):
  `/accounts` (directory with posted balances), `/journals`, `/periods` (+ fiscal years),
  `/trial-balance` (with the report's totals), `/income-statement`, `/cost-centers`
  (with balances), `/zatca` (seller card + filings register).
- **Entitlement (D-002)**: registered the `accounting` code in the marketplace catalog
  (`packages/database/src/marketplace.ts` — core bundle, price 0, no staff screens) and
  gated the app on `GET /marketplace/apps`: an enabled install or a pristine core bundle
  passes; an operator's explicit `tenant_apps.is_enabled = false` locks the tenant out.
  Rule isolated in `accountingAppEntitled()` and pinned in `tests/app.spec.ts`.
- **Wiring**: `pnpm verify` covers the new workspace like every other (typecheck/lint/
  test/build all green); `scripts/next-run.mjs` gained `accounting-app` (port 3005,
  `ACCOUNTING_APP_PORT`); eslint treats it as a browser app like the other surfaces.
- **web-core**: `use-query` moved from staff (both apps need it; staff keeps a re-export
  shim) and exported as `@erp/web-core/use-query`.

### 10.2 Verification

- accounting-app: typecheck ✓, lint ✓, 5/5 tests ✓ (registry ↔ permissions, entitlement
  rule incl. operator-disable, read-only source invariant), `next build` ✓ (8 routes).
- packages/database: build ✓, 54/54 tests ✓ (marketplace catalog spec updated with the
  new code — the core-apps-have-no-screens invariant still holds).
- apps/staff: 83/83 ✓ (use-query shim), packages/web-core: 14/14 ✓.
- Root `pnpm -r run lint` and `pnpm -r run typecheck`: clean across all workspaces.
- Full apps/api suite after the catalog change: see §10.3.

### 10.3 Deferred to later milestones (recorded, not forgotten)

- E2E boot of app+API with a provisioned tenant (the endpoints themselves are covered by
  the API suite; the app's client is the same one staff uses) — folded into the M6
  hardening pass.
- Accounting write flows (journal entry creation, period close) — next accounting
  milestone, after the rep backend (M4) per the roadmap's dependency order.

## 11. M4 — rep backend: `field-sync` + `rep-workspace` (2026-10-15, implemented and verified)

The API side of the offline-first rep app — the largest backend milestone in the roadmap.
First milestone that adds new tables; every rule from the migration conventions held
(additive, reversible, idempotent, RLS, `rlsProtectedTables`, fingerprints of 0123–0128
pinned in the reversibility spec).

### 11.1 What was built

- **Migration `0128_field_sync_queue`** (+ down): the replay ledger and conflict inbox for
  offline rep documents, modeled on `offline_queue` (0102) — never a second document store.
  Adds `salesman_id` (always derived from the replaying membership), `operation`
  (invoice/collection/return/receipt — the batch is mixed), `result` (engine outcome
  snapshot) and `document_id` on top of the 0102 shape. Unique `(tenant, offline_id)` +
  `(tenant, device, sequence)`, canonical tenant-isolation RLS policy, `erp_api` grants.
  Drizzle schema in `packages/database/src/schema/field-sync.ts`; `field_sync_queue`
  registered in `rlsProtectedTables` (rls.spec + isolation.spec expectations updated).
- **`apps/api/src/modules/field-sync/`** (see its README):
  - `field-sync-rep-guard.service.ts` — the D-004 boundary in one place: membership →
    salesman card (403 `FIELD_SYNC_NOT_A_REP` when absent, `FIELD_SYNC_REP_INACTIVE`,
    `FIELD_SYNC_NO_VAN_WAREHOUSE` for setup gaps) → `assertScope('warehouse', <his van>)`
    over `membership_role_scopes` (AUD-03 semantics: unconfigured role ⇒ no access).
  - `field-sync-snapshot.service.ts` — `GET snapshot` (rep-scoped master data: customers,
    per-customer prices with effective windows, items, units, taxes, item units, barcodes,
    price lists + items, payment methods, his van warehouse `stock_balances` only, his
    open load orders, his open credit documents) and `GET delta?since=` (`changed` per
    collection via `GREATEST(created_at, updated_at) > since`, `deleted` ids via
    `deleted_at > since`, `full` re-read for collections without change tracking or with
    live state). The watermark is the database clock read in the same transaction — no
    device clocks anywhere.
  - `field-sync-replay.service.ts` — `POST replay` (batch ≤ 100, row-level conflicts like
    offline POS) and `GET queue` (the rep's own conflict inbox). Idempotency layers:
    synced-`offline_id` replays its recorded outcome; per-device monotonic sequence; every
    engine call passes `idempotencyKey = "field-sync:{offlineId}"` into the van-sales
    sagas, which already key documents/movements/payments on it. `collection`/`return`
    accept `sourceOfflineId` — a collection can target a credit invoice made by the same
    device earlier in the same batch, before the server had ever assigned it a number.
    The receipt crash-window (`VAN_LOAD_ORDER_NOT_AWAITING_RECEIPT` with
    `received_qty > 0`) is recognised and recorded as synced, not a false conflict.
- **`apps/api/src/modules/rep-workspace/`** (see its README): `GET day?date=` (documents +
  collections + per-customer visit aggregation, net revenue of returns), `GET custody`
  (official van balances + open orders with expected-vs-actual), `POST closing` (the
  rep's own submission — 403 for any load order that is not his; the back-office route
  remains for accountants). Thin orchestration only: no tables, no engine calls.
- **No new permission codes** — the module reuses `van_sales.view` /
  `van_sales.invoice.create` / `van_sales.collection.create` / `van_sales.closing.submit`,
  exactly the codes migration 0126 and `linkSalesmanAccount` already grant to the rep
  role. Replay re-checks the operation-specific code per row.

### 11.2 Verification (all local, real HTTP against an isolated embedded database)

- `apps/api/test/field-sync.spec.ts` — 11 tests: rep-scoped snapshot; other van/other
  card/no-card/no-scope kept out; honest delta (changed + deleted + full, invalid
  `since` 422); a full offline day replayed through the engines (invoice + return +
  collection in one batch — posted `sales_invoices` with journal entries, treasury
  voucher, official stock movement, `paid_amount` updated); idempotent whole-batch retry
  (same documents, no double movements); stock exhaustion as a row conflict; the sequence
  matrix (old / in-batch duplicate / offlineId-sequence mismatch / unknown operation /
  empty batch 422); the D-004 negative matrix (foreign load order `FIELD_SYNC_SCOPE_VIOLATION`,
  `FIELD_SYNC_DEVICE_BOUND`, `FIELD_SYNC_PERMISSION_MISSING`,
  `FIELD_SYNC_SOURCE_NOT_SYNCED`, no-card 403, no-scope 403); conflict inbox scoping;
  offline receipt confirmation + crash-window recovery; concurrent replays on the same
  van stock (two parallel requests selling the remaining custody − 1 kg: exactly one
  winner, load order left at 1 kg, no over-selling, no batch failure).
- `apps/api/test/rep-workspace.spec.ts` — 4 tests: day summary math from engine documents
  (net revenue 120.00 = 138.00 sale − 18.00 return, collections with voucher numbers,
  one visit per customer), invalid date 422 + empty day honest, custody summary
  (official balance 83 kg, expected remaining 77), closing by the owner + 403 for a
  foreign rep + 422 without a load order.
- `apps/api/test/migration-0128-reversibility.spec.ts` — 4 tests: applied by the harness +
  idempotent re-apply + constraint matrix (operation/status/sequence checks, both unique
  keys), canonical RLS policy + FORCE + registry membership, down/up cycle (queue route
  fails loudly 500 while the table is gone; only ledger rows are lost — official
  documents untouched; cross-tenant session sees zero rows), fingerprints of
  0123–0128 unchanged.
- Neighbour suites stay green: isolation 9/9, offline-pos 3/3, permission-codes 5/5,
  app.module 2/2, van-sales 1/1, permission-scope 7/7, stock-settlement 10/10,
  stock-acceptance 5/5, production-policy 9/9, 0127-reversibility 4/4.
- packages/database: build ✓, 54/54 ✓ (rls.spec updated with `field_sync_queue`).
- Full apps/api suite + root lint/typecheck: see the push/CI note below.

### 11.3 Notes and deferrals

- **D-004 is closed as DECIDED** (see `DECISIONS.md`): scope enforcement is implemented in
  the API on every field-sync/rep-workspace route, with the negative matrix as the exit
  evidence. The UI may still *filter* for usability, but it is never the boundary.
- **D-006 (rep app shell: PWA first) still needs the owner's confirmation before M5**
  starts — it decides the frontend stack only; the sync contract built here is
  shell-agnostic by design.
- Offline *push* of price/customer creation from the device (rep adds a new customer in
  the field) is deliberately out of M4 scope — the snapshot's customers and prices are
  back-office facts; deferring keeps the replay to the four document operations.

## 12. M5 — Rep app (offline-first frontend) — implemented 2026-10-16

### 12.1 What shipped

- **`apps/rep-app`** — the van-sales rep's offline-first PWA (D-006 DECIDED & IMPLEMENTED):
  - **PWA**: `public/manifest.webmanifest` (standalone, RTL, `/` start), `public/sw.js`
    (app-shell precache, network-first navigations with cached fallback, `/api/*` never
    intercepted — the offline queue is the honest write path), registered from the root
    layout. `sw.js` served `no-cache` + `Service-Worker-Allowed: /`.
  - **Offline store** (`lib/offline/rep-db.ts`): native IndexedDB `erpcloud-rep-offline`
    (no Dexie — the M2 web-core arrangement, rep-shaped). Snapshot saved verbatim +
    watermark/rep card in `meta`; delta applies `changed` (upsert) / `deleted` (remove) /
    `full` (clear+put) exactly as the M4 contract frames them; `customerPrices` keyed by a
    composite string (array keyPaths reject `itemId: null` = "any item" rows).
  - **Operation builders** (`lib/offline/ops.ts`): the four ops with the EXACT M4 replay
    payloads; the server's remaining formula evaluated on the phone
    (`COALESCE(NULLIF(received,0),loaded) − sold − bonus − returned − damaged`);
    `projectedRemaining`/`projectedStock` move with THIS phone's pending ops (a conflicted
    op moves nothing — it did not happen); `estimateInvoiceTotal` (VAT only for
    `zatca_tax`) labelled تقديري everywhere.
  - **Sync engine** (`lib/offline/rep-sync.ts`): pull (delta, falling back to snapshot on a
    rejected `since`), push (`replay` batches ≤100 in sequence order), results merged back
    (synced keeps server ids/numbers; conflict keeps errorCode/message/resolution), retry
    only by explicit action, auto-sync on mount/`online`/10s, server queue inbox read.
  - **Screens** (9 routes, phone-first five-tab shell, permission-gated per the M4 route
    codes): home, sync, customers with their prices, van stock + receipt confirmation,
    invoice (locked prices, bonus caps, estimate), collection (`documentId` or
    `sourceOfflineId` + `cashLocationId` from the snapshot's default cash method), return,
    **online-only closing** (counted-vs-expected, explicit shortage acknowledgment — D-008),
    queue + conflict inbox.
  - **Rep gate**: `GET /field-sync/queue` probe — definitive 403 (D-004 guard) explains and
    blocks; network errors fail OPEN (an offline rep must reach his cached data).
  - **Sign-out wipes the device store** — the next rep on a shared phone starts clean.

### 12.2 Verification

- `apps/rep-app`: 18/18 specs ✓ (payload builders vs the M4 wire shapes; snapshot/delta
  round-trips; projections; sequence monotonicity; replay merge; navigation/permission/
  i18n/AUD-13 invariants), typecheck ✓, lint ✓, production build ✓ (all routes static),
  `next start` serves every route + PWA assets (200s, headers verified).
- **Acceptance gate** `apps/api/test/rep-app-day.spec.ts` (7/7 ✓): the app's exact payloads
  through the real HTTP server — snapshot pull → one sequence-ordered batch (receipt →
  invoice with bonus → collection with voucher → return) → idempotent whole-batch retry →
  delta shows the effect → closing with the app's exact body (clean: shortage 0; short:
  shortage 2.0000 + `pending_policy_approval`) → day aggregation.
- **The gate caught a real app bug**: collections without `cashLocationId` recorded the
  movement but no receipt voucher — the app now resolves the cash location from the
  snapshot's default cash payment method (both collection and cash-sale payloads).
- Neighbours: field-sync 11/11 ✓, rep-workspace 4/4 ✓, exit-code gate ✓ (after building
  `@erp/testing`'s dist — this fresh environment had none; the dist chain
  contracts→config→database→testing is pre-existing, unrelated to M5).
- **Full apps/api suite: 203 files / 1697 tests, exit 0** (was 202/1690; +`rep-app-day`
  7). Root `pnpm -r run lint` exit 0 and `pnpm -r run typecheck` exit 0 — 14 workspaces
  (rep-app the new fourteenth).
- D-006 → DECIDED & IMPLEMENTED; D-008 → DECIDED for the UX scope (the app surfaces, the
  accountant decides; nothing settles silently). Browser E2E deferred (no browser here) —
  the payload-replay gate is the repo's established proxy, per the roadmap's exit note.

### 12.3 Notes and deferrals

- Offline *push* of new customers/prices from the device stays out of scope (M4 note
  unchanged): the snapshot's catalog rows are back-office facts.
- Background Sync API (true background replay when the app is closed) is not used — the
  service worker caches the shell and the app syncs when open/online; adding a
  `sync` event listener is a small, contract-compatible follow-up if the pilot needs it.
- Browser E2E (Playwright) remains open for an environment with a browser; the acceptance
  specs pin the contract meanwhile.

## 13. M6.1 — Fixed assets (register, categories, depreciation run) — implemented 2026-10-16

### 13.1 What shipped

- **Migration `0129_fixed_assets`** (+ `down/`): three additive, idempotent tables —
  `asset_categories` (code + default life + the three posting accounts handed to its
  assets), `fixed_assets` (the register; acquisition month = first depreciation month,
  no separate in-service date; `method` column for forward-compatibility,
  `status` active/fully_depreciated/disposed), `asset_depreciation_entries` (the run
  ledger: one row per asset per month EVER — `UNIQUE (tenant_id, asset_id, period)` IS
  the run's idempotency — each pointing at the journal entry that posted it). RLS
  canonical policy on all three, `NOBYPASSRLS` re-asserted, `accounting.assets.*`
  permission codes inserted ON CONFLICT. Accounts FK `ON DELETE RESTRICT` — a posting
  account can never be orphaned. `down` drops the three tables only; posted journal
  entries are the accountant's ledger and are never touched by a rollback.
- **`AssetsModule`** (`apps/api/src/modules/assets/`): `FixedAssetsService` +
  controller. Routes: GET/POST `/asset-categories` + PATCH `:id`; GET/POST
  `/fixed-assets`, GET `:id`, GET `:id/schedule`; POST+GET
  `/fixed-assets/depreciation-runs` (declared BEFORE the `:id` routes — Nest matches in
  order). **Every depreciation posting goes through `AccountingService.postJournalInTx`
  only** — balanced-entry, open-period and module-lock guards live in one place.
  - Math: monthly = (cost − salvage)/life ROUND_HALF_UP 4dp; the LAST life month
    absorbs the exact remainder so the total telescopes to cost − salvage precisely;
    month 1 = acquisition month.
  - `runDepreciation`: `resolvePostingContext` (default posting date = period end,
    default branch), candidates locked `.for('update')`, declared skips (قبل تاريخ
    الاقتناء / استوفى عمره الإهلاكي / مرحَّل مسبقًا / لا قسط مستحق), ONE journal
    entry per run (sourceType `asset_depreciation`; no idempotencyKey — the
    unique(asset, period) + row lock is the gate), 2 lines per asset (Dr expense,
    Cr accumulated), `fully_depreciated` flip when posted months ≥ life.
    `ASSET_ACCOUNTS_MISSING` 422 names the gap; account = asset override ?? category
    default. Register/list computed fields (accumulated, NBV, depreciatedMonths) are
    `SUM` over the ledger rows — never a second balance.
- **accounting-app** (`apps/accounting-app`, first writing surface of the M3 scaffold):
  `lib/assets.ts` (typed wrappers; the three writes live ONLY here — pages never touch
  the API client; money stays decimal text end-to-end), `/assets` (register table +
  run form with its declared-skip result + register & category forms, write forms
  rendered only behind `can('accounting.assets.manage')` / `can('accounting.assets.depreciate')`
  — the API enforces the same guard regardless), `/assets/[id]` (asset card + the
  planned-vs-posted schedule with each month's journal number), navigation/i18n/badge
  copy updated (`معظمه قراءة` — the topbar caption names the exact writes). The
  instalment preview in the form mirrors the service math (HALF-UP 4dp) and is labelled
  تقديري; the schedule endpoint remains the authoritative number.

### 13.2 Verification

- `apps/api`: `fixed-assets.spec.ts` 8/8 ✓ (validation & duplicates & foreign accounts;
  tenant isolation; exact telescoping schedule; a run posts ONE balanced entry and moves
  GL balances (pool SQL on `journal_entry_lines`); rerun no-op + next month; subset
  `assetIds` + pre-acquisition skip (inside an opened prior FY) + malformed period 422;
  `FISCAL_PERIOD_NOT_FOUND` for uncovered years + viewer read/run 403 split;
  `fully_depreciated` flip after 24 months with post-life skip reason).
  `migration-0129-reversibility.spec.ts` 4/4 ✓ (applied+idempotent+CHECK/unique
  rejections incl. the (asset, period) gate; canonical RLS policy on all three tables;
  down → `GET /fixed-assets` 500 → up → empty + other-tenant invisibility; 0124–0129
  checksums match sha256(disk)).
- accounting-app: 12/12 ✓ (6 scaffold — SCREENS now include `/assets`, M3 surfaces stay
  read-only, the M6.1 writes concentrated in `lib/assets.ts` behind permission guards;
  6 new — instalment preview math incl. HALF-UP and nonsense refusals, YYYY-MM
  validation, status labels). Lint + typecheck clean.
- Root lint/typecheck and the full suite run recorded in the session log (§13.4).

### 13.3 Notes and deferrals

- **Disposal is out of scope** (not in the roadmap's fixed-assets item): `status`
  carries `disposed` for forward-compatibility, but no disposal route/posting exists —
  a disposal entry is an accountant's manual JE until re-decided.
- No idempotencyKey on the run's JE: the run is gated by the unique(asset, period)
  constraint + candidate row locks inside one transaction; two concurrent runs for the
  same month serialize and the second declares مرحَّل مسبقًا.
- The register form inherits posting accounts from the category (asset-level override
  exists in the API for migration/legacy cases but is deliberately not exposed in the
  UI — one place to configure accounts).

### 13.4 Full-suite gate

- **Full apps/api suite: 205 files / 1709 tests, exit 0** (was 203/1697; +`fixed-assets`
  8, +`migration-0129-reversibility` 4). Root `pnpm -r run lint` exit 0 and
  `pnpm -r run typecheck` exit 0 — 14 workspaces. accounting-app suite 12/12 ✓.

## 14. M6.2 — WIP stage for multi-step production — implemented 2026-10-16

### 14.1 What shipped

Built on the D-007-recommended basis (perpetual weighted average, output valued at actual
consumption — the engine's existing invariant, untouched). The gap was temporal, not
mathematical: until 0130, `complete` consumed the components and received the output in
one transaction, so there was no moment at which materials had left the shelf without a
finished item — which is exactly why `wipAccountId` was deliberately absent from the
posting-profile vocabulary. That moment now exists:

- **Migration `0130_production_wip`** (+ `down/`): two additive columns on
  `production_orders` — `issued_at` (the moment components went to the floor) and
  `wip_posted` (did the issue post through the WIP account? decides which pair the
  completion clears). No new table, no RLS changes; `down` drops the columns and leaves
  the posted journal entries untouched.
- **`ProductionOrdersService.issue()`** — `draft → in_progress`: components leave at the
  moving average (the shared `consumeComponents` helper — same movement, same unique
  (doc, line) index that guarantees no double consumption between the steps),
  `componentCost` = what actually left. **`complete()`** now takes both paths: an issued
  order only receives the output at the accumulated cost; the legacy draft path is
  byte-for-byte the old behaviour. **`cancel()`** refuses an issued order — its components
  are on the floor and it must run to completion.
- **`production-posting.ts` — stage-aware pairs** (`stage: 'issue' | 'complete'`):
  - issue with `wipAccountId` mapped: «تحت التشغيل ← مواد خام» for what actually left;
  - issue without it: **neutral** — completion then posts the full «منتج تام ← مواد
    خام» pair as it always did, so a tenant that mapped the two accounts before WIP
    existed is not broken by adopting the two-stage flow (a regression my own spec
    caught before it shipped);
  - `wipAccountId` mapped but materials missing ⇒ 422 `PRODUCTION_ACCOUNTS_INCOMPLETE`;
  - completion after a WIP-posted issue: «منتج تام ← تحت التشغيل»; if the account was
    unmapped between the steps ⇒ 422 `PRODUCTION_WIP_MAPPING_CHANGED` (crediting
    materials twice is not an outcome the engine will produce). The idempotency-key
    format is unchanged — the stepKey (`issue`/`complete`) was already the distinguisher.
- **`wipAccountId` in the posting-profile vocabulary** (contracts + staff settings
  screen label «إنتاج تحت التشغيل (مواد صُرفت ولم تُنتج)»), and the **staff production
  screen**: صرف button (draft, behind `inventory.production.complete` — issuing moves
  stock, it is the financial act, not recipe-writing), تنفيذ for both draft and issued,
  cancel draft-only, three-step track مسودة ← تحت التشغيل ← منفَّذ, issue date on the
  card, and an info line for the pending value on the floor.
- **No new accounting-app screen**: the WIP account is an ordinary ledger account — it is
  already visible in the chart/trial-balance screens, and its mapping lives in the staff
  posting-profiles screen where every other production key already does.

### 14.2 Verification

- `apps/api`: `production-wip.spec.ts` 9/9 ✓ (neutral issue + rerun 409; complete at
  exactly the issued cost with no double consumption; the WIP pass-through clears to
  zero with two distinct idempotency keys; half-map refusal with stock rolled back;
  mapping-changed refusal then recovery; legacy draft path byte-identical incl. the
  pinned key; legacy-mapping two-stage flow; cancel draft-yes/issued-no; viewer 403).
  `migration-0130-reversibility.spec.ts` 3/3 ✓ (applied + idempotent + defaults; down →
  `GET /inventory/production-orders` 500 → up → rows preserved with `wip_posted` back to
  false; 0125–0130 checksums).
- Regression on the reworked engine: `production-posting-profile` 7/7, `production-and-
  returns` 3/3, `van-sales-production-policy` 9/9 — the legacy paths are untouched.
- staff: 87/87 ✓ (83 existing + 4 new source-contract tests for the screen).
- Full-suite gate recorded in §14.4.

### 14.3 Notes and deferrals

- True multi-stage production (semi-finished → finishing) is composed, not modeled:
  chained orders — the first order's output is a component of the second — which the
  engines already support. A first-class stage graph is an engine project of its own and
  stays out until a pilot needs it.
- The WMS/BOM engine (`manufacturing_order`, `MF-`) keeps its partial-produce model; a
  WIP issue stage for it is deferred — its bin-based repeated production has a different
  shape, and the posting helper is already stage-aware if it ever needs one.
- Cancelling an issued order is refused rather than reversed: returning lot-tracked
  components to their original lots is a stock-adjustment decision, not a status flip.

### 14.4 Full-suite gate

- **Full apps/api suite: 207 files / 1721 tests, exit 0** (was 205/1709; +`production-wip`
  9, +`migration-0130-reversibility` 3). Root `pnpm -r run lint` exit 0 and
  `pnpm -r run typecheck` exit 0 — 14 workspaces. staff suite 87/87 ✓.

## 15. M6.4 — Budgets & budget-vs-actual — implemented 2026-10-16

### 15.1 What shipped

M6.3 (standard costing) stays gated on the owner's D-007 decision; M6.4 depends on GL +
reporting only and shipped next per the roadmap's dependency order.

- **Migration `0131_budgets`** (+ `down/`): two additive tables — `budgets` (name unique
  per tenant + fiscal year, `draft | approved`, audit + soft delete + legacy) and
  `budget_lines` (`(budget, account, fiscal_period)` unique, `amount >= 0`). Canonical
  RLS on both, `NOBYPASSRLS` re-asserted, `accounting.budget.view/manage` inserted
  idempotently. Down drops the tables; the ledger is untouched (budgets never post).
- **`BudgetsModule`** (standalone — imports nothing from AccountingModule because it
  only *reads* the chart, the fiscal calendar and the posted ledger):
  - `POST /budgets` takes the **annual** amount per postable account and distributes it
    across the year's periods: even instalment, HALF-UP 4dp, the last period carries the
    exact remainder — the same telescoping rule as the fixed-asset schedule (M6.1).
  - `PATCH /budgets/:id` — rename/notes; `status: 'approved'` freezes (409
    `BUDGET_APPROVED_FROZEN` on any later line change); `lines` replaces the monthly rows
    completely (same full-replacement contract as the posting-profile map) for
    seasonality, draft only, periods of the budget's own year only.
  - `DELETE /budgets/:id` — draft only, soft delete; an approved budget is a measured
    plan and stays.
  - `GET /budgets/:id/variance?to=` — **computed, never stored**: budget side = SUM of
    lines in fully-elapsed periods (`period.end_date <= to`); actual side = posted-entry
    movement over `[FY start, to]` signed by the account's normal balance (the trial
    balance's own reading). Rows include unbudgeted accounts with actual movement
    (`inBudget: false`); `totals` = نتيجة الموازنة over revenue + expense only
    (budgeted result vs actual result vs variance). `to` defaults to the FY end and is
    clamped to it.
- **accounting-app**: `/budgets` (list + create form with per-account annual amounts and
  a distribution preview labelled تقديري + approve/delete-draft behind
  `accounting.budget.manage`) and `/budgets/[id]` (the variance table with the accountant's
  tone reading — under-budget spending good for expenses, over-budget revenue good for
  income — plus the نتيجة الموازنة totals row and the monthly lines in a collapsible).
  Writes live only in `lib/budgets.ts` (same contract as assets).

### 15.2 Verification

- `apps/api`: `budgets.spec.ts` 6/6 ✓ (distribution with exact telescoping incl.
  100÷12 → 8.3333×11 + 8.3337; duplicate-name 409 + tenant isolation; monthly replace +
  wrong-year period 422 + approval freeze incl. delete refusal; variance with a January
  `to` cutoff vs full-year, unbudgeted actuals visible, clamped `to`, نتيجة الموازنة
  totals; soft delete of a draft; viewer read/write split).
  `migration-0131-reversibility.spec.ts` 4/4 ✓ (applied + idempotent + CHECK/unique
  rejections; canonical RLS on both tables; down → `GET /budgets` 500 → up → empty +
  other-tenant invisibility; 0126–0131 checksums).
- accounting-app: 17/17 ✓ (scaffold — SCREENS with `/budgets`, M3 surfaces still
  read-only, M6.1+M6.4 writes concentrated in their libs behind permission guards; 5 new
  — distribution preview mirroring the server math, variance tone, status labels).
  Lint + typecheck clean.
- Full-suite gate recorded in §15.4.

### 15.3 Notes and deferrals

- Budget **approval workflow** (the approvals module) is deferred: approval here is a
  single manage action that freezes; routing it through approvers is a product decision.
- **Budget revisions** (a v2 next to an approved budget) are deferred: an approved budget
  that must change gets a sibling budget — explicit history beats silent edits.
- **Branch/cost-centre dimension** on budget lines is deferred: the FY/account/period
  grain first; dimensions are additive columns later if a pilot needs them.

### 15.4 Full-suite gate

- **Full apps/api suite: 209 files / 1731 tests, exit 0** (was 207/1721; +`budgets` 6,
  +`migration-0131-reversibility` 4). Root `pnpm -r run lint` exit 0 and
  `pnpm -r run typecheck` exit 0 — 14 workspaces. accounting-app suite 17/17 ✓.

## 16. M6.5 — Bank reconciliation desk: reviewable match → post — implemented 2026-10-17

### 16.1 What shipped

The bank-feed plane (§0096, future enhancement 01) could import a statement, match its
lines to posted invoices/vouchers and report the bank-versus-ledger difference — but a
line the books never knew (bank charges, interest, wire fees) could only be matched,
ignored or left pending forever. M6.5 closes that loop without breaking the slice's
invariant: **suggestions are never silently posted.**

- **Migration `0132_bank_line_posting`** (+ `down/`): `bank_statement_lines` gains
  `posted_journal_entry_id` (FK → `journal_entries`, `ON DELETE SET NULL`) + tenant
  index, and the 0096 status CHECK is widened (drop + re-add, house pattern from
  0029/0036) to admit `'posted'` beside pending/matched/ignored. Down drops the column
  and index; the ledger is untouched.
- **`BankFeedsModule` now imports `AccountingModule`** — posting goes through the same
  `AccountingService.postJournalInTx` every other posting module uses (open period,
  module lock, JE- sequence, balanced-entry checks, line auto-naming all inherited).
- **`POST /treasury/bank-statements/:id/lines/:lineId/post`**
  (`treasury.bank.manage`): only a `pending` line; the counter **account is required**
  (`BANK_POST_ACCOUNT_REQUIRED`), the bank account must be linked to a ledger account
  (`BANK_ACCOUNT_UNLINKED`), and the counter cannot be the bank's own account
  (`BANK_POST_ACCOUNT_SAME`). A positive amount (deposit) debits the bank ledger
  account and credits the counter; a negative one (withdrawal — charges) debits the
  counter. Cost center: explicit input, else the line's suggestion. The entry carries
  `source_type = 'bank_statement_line'`, `source_id = <line id>`, idempotency key
  `bank_statement_line:<lineId>` (re-posts after a reversal get an ordinal suffix so
  the unique key never collides). Date = the bank's own transaction date via
  `resolvePostingContext` — a closed/missing period stops the posting exactly as it
  stops a manual entry.
- **Lifecycle**: the line becomes `status = 'posted'` with its entry id
  (`postedJournalNumber` joins into the lines payload); `unmatch` on a posted line is
  refused (`BANK_LINE_POSTED`) while the entry stands, and succeeds once a reversal
  exists (0125) — returning the line to `pending` for re-post or re-match. Failed
  posts roll back completely (line stays pending, no entry).
- **Reconciliation report**: `postedLines` + `postedMovement` added; the books-only
  fallback (`ledgerSource = 'settled bank lines'`) counts posted lines as settled.
  `listLines` accepts `status=posted`.
- **Staff desk** (`app/treasury/bank-reconciliation/page.tsx`): a review card
  (الحساب المقابل · مركز التكلفة · بيان القيد) pre-filled from the rule suggestion
  with the explicit «تأكيد وترحيل القيد»; posted lines move to the settled side and
  link straight to their journal entry screen.

### 16.2 Verification

- `apps/api`: `treasury-bank-posting.spec.ts` 6/6 ✓ (positive posting with entry line
  assertions incl. `sourceType`/`sourceId`; negative posting with cost center +
  `postedJournalNumber` in the lines payload; re-post/ignored guards 409 +
  same-account/unknown-account 422 with the line still pending after rollback;
  unlinked-account 422 + viewer 403/view 200; posted-unmatch refused → reversal →
  unmatch → re-post under a fresh key; report counts `postedLines`/`postedMovement` +
  statement `reconciled`). Staff screen contract
  `bank-reconciliation-posting.spec.ts` 4/4 ✓ (posted label + settled-side filter;
  pending-only post button behind manage + required explicit account + no-silent-
  suggestion guard; endpoint + payload wiring; journal-entry link).

### 16.3 Notes and deferrals

- Automatic posting remains explicitly out of scope (master plan); the desk flow is
  reviewable by construction — the account always comes from the reviewer.
- Bank-charge lines post against the bank's linked ledger account; accounts with no
  link are refused rather than guessing a contra account.
- MT940/CAMT and Saudi Open Banking ingestion remain future work (0096 scope note).

### 16.4 Full-suite gate

- **Full apps/api suite: 210 files / 1737 tests, exit 0** (was 209/1731;
  +`treasury-bank-posting` 6). Root `-r run lint` exit 0 and `-r run typecheck`
  exit 0. Smoke check (AppModule boot from dist) passed. accounting-app 17/17 ✓,
  staff 16 files / 91 tests ✓ (+4), `openapi.json` regenerated (+31 lines, new
  route `/treasury/bank-statements/{id}/lines/{lineId}/post`).

## 17. M7.1 — Vertical pack codes, plans, and opening what was bought — implemented 2026-10-17

### 17.1 What shipped

M6 is done except item 3 (standard costing, still gated on the owner's D-007 decision),
so the roadmap's next unit is M7's first bullet: "Marketplace app codes + plans for the
new packs (wholesale/manufacturing/food-factory/van-sales)". The machinery existed
(`billing_plans` + `billing_plan_entitlements` from 0019/0068, `feature.*` flags,
console flags tab, pricing page reading `GET /public/plans`) — but no pack was sellable
end to end: two marketplace codes were missing, no plans were seeded, and nothing opened
a pack when a licence went live (the operator flipped flags by hand after every
activation).

- **Four `feature.*` pack flags** (`wholesale` · `manufacturing` · `food_factory` ·
  `van_sales`) in `packages/config` tenant-settings + Arabic/English labels in
  `packages/contracts` `tenantFlagLabels` — they flow automatically into the console
  flags tab, the plan-entitlement catalogue (`buildPlatformEntitlementKeys`) and the
  public pricing page rows.
- **Migration `0133_vertical_pack_plans`** (+ `down/`): seeds the four pack plans
  (149/149/199/129 SAR monthly, prices grounded in the marketplace catalog) each with
  its pack flag + `limits.max_users`. `ON CONFLICT DO NOTHING` everywhere: the seed
  converges an empty database and never overrides what the operator edited. Down
  removes the rows and **fails loudly** (FK) when a pack plan already has a licence.
- **Two marketplace sector codes**: `wholesale` (license entry, screens `[]` — its
  surfaces are the classic base) and `food_factory` (production + distribution in one
  install, screens = the already-gated manufacturing/van-sales hrefs — overlap is
  union-safe, nothing existing gets hidden).
- **The missing link — `applyPlanFeaturePacks`** (`platform/admin/pack-entitlements.ts`):
  called from every path where a licence becomes live — manual grant (incl. trials),
  activation-request approval (both the `/platform` and `/billing` review routes), plan
  change, and the Stripe webhook. Writes only `feature.* = true` rows
  (additive — a cheaper plan never closes a pack the operator or a previous licence
  opened; downgrades stay manual), skips writes that change nothing (keeps
  `isDefault`/`updated_at` honest), and records one `tenant.flag` audit row per opened
  pack (`meta.planCode`, `via: subscription`).

### 17.2 Verification

- `apps/api`: `vertical-packs.spec.ts` 6/6 ✓ (marketplace codes + no-new-gates proof;
  seeded plans read through `GET /public/plans` with entitlement labels from the
  registry; grant opens the pack incl. tenant-visible `/settings` + one audit row;
  trial opens too and never closes; activation approval opens; plan change opens
  additively). `migration-0133-reversibility.spec.ts` 4/4 ✓ (applied + idempotent +
  operator edit survives re-apply; down → empty → up again; FK refuses down under a
  live licence; 0132–0133 checksums).
- Updated: `platform-tenants.spec.ts` flags list 4 → 8 (title re-worded);
  `packages/config` tenant-settings spec covers the four keys.
- Unchanged-but-green around the change: `platform-billing` 23, `public-plans` 9,
  `settings` 7, `pos-checkout` 12, marketing 100, platform-admin 27.

### 17.3 Notes and deferrals

- Marketing pages for the verticals and the staging pilot are the remaining M7 items;
  the pricing page now shows the four packs with zero marketing-code changes (it is
  data-driven by design).
- `feature.wholesale`/`feature.food_factory` gate nothing at the service level yet —
  the flags are the licensing surface; service-level enforcement lands with the
  vertical screens that need it (the `feature.pos` gate in `pos.service` is the
  pattern).
- A full-run `treasury-dayclose` ECONNRESET was a flake (embedded postgres): the spec
  passes standalone and the full suite re-run is clean.

### 17.4 Full-suite gate

- **Full apps/api suite: 212 files / 1747 tests, exit 0** (was 210/1737;
  +`vertical-packs` 6, +`migration-0133-reversibility` 4). Root `-r run lint` exit 0
  and `-r run typecheck` exit 0 — 14 workspaces; smoke check passed. All other
  workspaces green (contracts 239, database 54, config 16, marketing 100,
  platform-admin 27, staff 91, accounting-app 17, rep-app 18…). `openapi.json`
  regenerated — no diff (no route changes).

## 18. M7.2 — Marketing industry pages for the four packs — implemented 2026-10-17

### 18.1 What shipped

- **Four sector entries in `apps/marketing/lib/industries.ts`** (after the existing
  five): `wholesale` (الجملة والتوزيع — 5 screens from the sales module), 
  `manufacturing` (التصنيع — 3 screens incl. BOMs and production orders),
  `food-factory` (مصنع الأغذية — 4 screens: production, expiry, lots, distribution
  invoicing), `van-sales` (البيع المتجول — 5 screens: customer tiers/price locks,
  daily production, rep loads, distribution invoicing, bonus radar + owner
  dashboard). Each follows the P-M8 content rules: literal Arabic labels copied from
  the staff screen tree, ≥3 pain-point picture lines, ≥3 loop lines ending in the
  e-invoice/owner-profit close, no numbers/promises/testimonials.
- **Sources name the file that actually defines the screen.** Sales and
  manufacturing screens cite `apps/staff/lib/navigation.ts#<key>`; van-sales module
  screens cite `apps/staff/components/app-shell.tsx#<key>` because that module is
  injected by the app shell at runtime (it is not in `navigation.ts` — food-factory
  and van-sales share those screens; the entries deliberately reference the same
  keys).
- **Zero plumbing edits**: sitemap, `/industries` index page and
  `/industries/[slug]/page.tsx` are all data-driven off `industrySlugs` — the four
  new pages flow through automatically. Only a stale "القطاعات الخمسة" comment was
  updated on the index page.
- **`verify.spec.ts` extended, contract intact**: the slug list is pinned to the nine
  sectors in order; the anchor test now accepts either source file
  (`lib/navigation.ts` or `components/app-shell.tsx`), opens the named file, and —
  because `van-sales` also appears in the app-shell's `ADDON_MODULE_CODE_BY_NAV_KEY`
  map before the real module definition — checks that the label (+ href for screens)
  appears at *some* occurrence of the key, not the first one. The no-numbers/
  no-promises test covers all nine sectors.

### 18.2 Verification

- Marketing suite: 12 files / **100 tests green** (verify.spec 14/14 incl. the
  extended anchor test). Full gate: typegen → `typecheck` → `lint` → `build` →
  smoke → `pnpm -r run test` → `openapi:export` all exit 0; **apps/api 212 files /
  1747 tests** unchanged and green; `openapi.json` no diff (no route changes).

### 18.3 Notes and deferrals

- Remaining M7: platform-admin activation-flow reuse check, pilot tenants on staging
  (needs a real deployment — the sandbox can only document the runbook), and the
  R-13 performance baseline for snapshot/replay (a scoped load/benchmark test is
  feasible locally).
- Gate footguns re-confirmed: `pnpm typecheck -r` passes a stray `-r` to tsc (run
  `pnpm typecheck`); root scripts shelling out to bare `pnpm` need `corepack enable`
  first.

## 19. M7.3 — Field-sync performance baseline (R-13) — implemented 2026-10-17

### 19.1 What shipped

- **`apps/api/test/field-sync-perf.spec.ts`** — the load test the risk register asked
  for. It seeds the register's exact scenario in one tenant — **2,000 customers and
  5,000 items** (bulk `generate_series` inserts through the owner pool), a rep with a
  salesman card and van warehouse, and custody loaded through the **official engines**
  (production batch → load order → confirmed receipt) — then measures:
  1. **Snapshot** at production volume: row counts (2001 customers / 5000 items in the
     payload), JSON byte size, and wall-clock latency;
  2. **Delta** after touching 100 items: all 100 arrive in `changed.items`, latency
     measured (the `full` re-reads of item units/barcodes/stock are part of the cost);
  3. **Daily replay bursts**: 40 invoices then 20 more (one per customer, monotonic
     sequences on one device), every row through the van-sales saga — the spec asserts
     `synced === 40/20` and `conflicts === 0`, so a slow-but-failing burst can't pass.
- **Budgets are generous ceilings, not SLAs** (snapshot < 25 MB / 15 s, delta < 15 s,
  bursts < 90 s / 60 s): they catch order-of-magnitude regressions (N+1 query,
  payload bloat) without making CI flaky on runner variance. The measured numbers
  `console.log` on every run with a `field-sync perf baseline —` prefix, so the
  baseline travels with the suite instead of living in a document.
- **Local baseline (this sandbox, embedded postgres):** snapshot 2.18 MB / 111–123 ms;
  delta 100 items / 48–72 ms; burst1 40 ops / 2.36 s (59 ms/op); burst2 20 ops /
  1.04 s (52 ms/op).

### 19.2 Verification

- `field-sync-perf.spec.ts` 3/3 ✓ standalone. Full gate re-run: typecheck, lint,
  build, smoke, `pnpm -r run test` — apps/api now **213 files / 1750 tests** exit 0;
  `openapi.json` no diff (no route changes).

### 19.3 Notes and deferrals

- The spec is a measurement, not a functional contract — scope/ownership/idempotency
  stay proven by `field-sync.spec.ts`; here only volume and time are asserted.
- Seeding footguns recorded: `items`/`parties` have **no `id` default** (bulk inserts
  must pass `gen_random_uuid()`), and the fiscal-year route needs
  `accounting.period.close` on the creating actor.
- Remaining M7: platform-admin activation-flow reuse check and pilot tenants on
  staging (needs a real deployment — the sandbox can only document the runbook).

## 20. M7.4 — Activation-flow reuse closed + pilot runbook — implemented 2026-10-17

### 20.1 What shipped

- **`docs/PILOT_RUNBOOK.md`** — the executable handoff for the last M7 item. It walks
  the staging pilot exactly as the milestone's exit criteria define it: bring-up on
  the repo's real `deploy/docker-compose.yml` / `deploy/k8s` (incl. the `DATA_ENC_KEY`
  boot canary — staging must fail loudly on a missing key, R-04), a pilot tenant
  buying a pack through the marketing → activation-request → platform-console path,
  production-like volume seeding (2,000 customers / 5,000 items — the bulk-insert
  pattern proven by `field-sync-perf.spec.ts`), then the full rep day (production →
  load → offline selling → replay → explicit-shortage closing → settlement → day
  close) and the accounting close (fiscal-period lock, party statement, ZATCA
  filing). Every step names the spec that already proves it on throwaway databases —
  the runbook's job is the part specs cannot prove: real network, real devices, real
  secrets, production volume.
- **Pass/fail is explicit:** success = the whole pilot with *zero manual ledger
  repairs*, no silent shortage settlement, no duplicate documents on resend, and the
  `field-sync perf baseline —` numbers within the spec's budgets; any direct-SQL
  ledger intervention during the pilot is recorded as a failed pilot and a product
  note, not a workaround.

### 20.2 Roadmap closure

- **"Platform-admin activation flow reuse"** marked ✅ with M7.1 evidence:
  `vertical-packs.spec.ts` proves pack licences open through the *existing*
  activation paths (grant, trial, activation-request approval, plan change, Stripe
  webhook) — no new monetization route was added, per `REUSE_ASSESSMENT.md` §4.
- **"Pilot tenants on staging"** marked ✅ as runbook-shipped; execution needs real
  staging infrastructure and is explicitly handed off. With this, every M7 line item
  is either shipped or handed off with an executable script — the milestone is code-
  complete; what remains is operating it.

### 20.3 Verification

- Docs-only change (new runbook + roadmap/PROGRESS lines); every literal reference in
  the runbook was checked against the repo (`scripts/prepare-docker-env.mjs`,
  `apps/rep-app/tests/offline.spec.ts`, the `party-statement` screen at
  `/reports/party-statement`, `fiscal-periods/:id/modules/:module/lock|unlock`,
  `submit-closing`/`approve-closing` routes, and the specs named per step). Full gate
  rides on CI (no code touched since the M7.3 green run).

## 21. M7.5 — Register housekeeping: openapi drift guard + legacy DDL move — implemented 2026-10-17

### 21.1 What shipped

- **`pnpm openapi:check` (R-21)** — `scripts/check-openapi-drift.mjs`: exports the
  OpenAPI document to a temp file through the same compiled CLI and byte-compares it
  with the committed `packages/contracts/openapi.json`, failing with the first
  differing line (and line counts) plus the exact fix command. Wired into
  `pnpm verify` **before** `openapi:export` — the check guards the *committed*
  artifact, the export then refreshes the working tree so a local `verify` run ends
  with the correct file in place. Verified both directions: green on the current
  artifact; exits 1 on an injected one-byte drift (then restored).
- **`sql.txt` → `docs/legacy/sql.txt` (R-12)** — `git mv` (history preserved), no
  behavior change; nothing in code referenced the root path (grep), and the four doc
  references (`CURRENT_ARCHITECTURE`, `REUSE_ASSESSMENT` ×2, `PROGRESS`) now point at
  the new location.

### 21.2 Verification

- `pnpm openapi:check` standalone: pass (fresh artifact) and fail (injected drift)
  both confirmed. `verify` chain now: typegen → typecheck → lint → build → smoke →
  test → **openapi:check** → openapi:export; the full chain is what CI runs on this
  commit.

### 21.3 Notes

- The risk register's P3 hygiene items are now all resolved or owned by a milestone
  decision (R-14 awaits D-007, R-16/R-18 are production-time actions).

## 22. Register hygiene — closing rows shipped by M1/M4 — implemented 2026-10-17

The register rows below were *done* by earlier milestones but never closed; each was
re-verified against the tree this session before closing:

- **R-02 (scope enforcement)** — D-004 enforced on the rep surface (rep guard on every
  `field-sync` route, ownership re-checked before engine calls, snapshot rep-scoped by
  construction) with the AUD-03 negative matrix (`field-sync.spec.ts` §5 +
  `van-sales-permission-scope.spec.ts`).
- **R-05 (van-sales monolith)** — the 6,479-line class is eight services (custody,
  documents, load-orders, reporting, pricing, production, shared, legacy shim) behind
  a 430-line controller.
- **R-06 (full-snapshot offline sync)** — `field-sync` ships snapshot + honest delta
  (`since` watermark from the database clock), measured at volume by the M7.3 spec.
- **R-09 (conflict codes)** — 12 `FIELD_SYNC_*` per-row conflict codes with resolution
  actions; bad rows never fail the batch; the one crash-window auto-case is detected
  from state, not assumed.

Open register items after this pass: R-03 (van-sales policy decisions — product
owner), R-14 (standard costing — gated on D-007), R-16/R-18 (production-time),
R-07 (compat freeze is a standing review rule), R-17 (audit checklist items already
covered by the isolation/rbac specs; left open for an explicit audit-plan run).
Docs-only change; CI carries the gate.
