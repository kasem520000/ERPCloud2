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
  engineering reports, phase docs); `sql.txt` legacy dump.
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
