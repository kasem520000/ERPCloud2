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
