# DECISIONS.md — Decision register for the assessment and the new product

> **Status:** Assessment deliverable (2026-10-14). Documentation only.
> Decision states: **PROPOSED** (recommended by this assessment, awaiting owner sign-off) ·
> **ACCEPTED** (owner approved — none yet, since this task stops at assessment) · **REJECTED**.
> Each decision cites the evidence it rests on (`[V]` verified this session, `[R]` reported by repo docs).

## D-001 — One platform, one API, one database; new products are new frontend apps + additive API modules

- **State:** PROPOSED (strong recommendation).
- **Context:** task requires the rep app and accounting app to share the authoritative invoice, inventory,
  costing, tax and accounting services, and forbids a second accounting engine or inventory ledger.
- **Evidence:** the platform already works this way — POS, van-sales, e-commerce and purchases all post
  through the single engines **[V]**; isolation/billing/platform services are cross-cutting **[V]**; the
  monorepo already hosts four frontends on shared packages **[V]**.
- **Alternatives rejected:** separate service/microservice per product (duplicates posting rules, RLS,
  billing; no team-scale justification); separate database (cross-DB consistency hazard; the van-sales
  incident history shows derived-vs-official drift is the highest-risk failure mode **[R]**).
- **Consequences:** new apps are workspace members behind the same `pnpm verify`; new backend work is
  additive modules (`field-sync`, `rep-workspace`, `fixed-assets`, `budgets`); product monetization reuses
  plans/marketplace.

## D-002 — Product packaging: marketplace app codes + plans, not new tenancy

- **State:** PROPOSED. The new specialized product is licensed as app codes/packs (`tenant_apps`) and plans
  on the existing platform; a tenant may hold the classic ERP and the new packs simultaneously.
- **Evidence:** gating machinery exists and is tested (`marketplace_apps`, `tenant_apps`, `visibleModules`
  appGate, activation-request workflow) **[V]**; plans/subscriptions/usage metering are live **[V]**.
- **Open question for owner:** are the new packs sold as separate plans (price) or feature flags of
  existing plans (entitlement)? Affects only billing rows, not architecture.

## D-003 — Reuse the accounting, inventory, sales, treasury, ZATCA engines unchanged; extend only additively

- **State:** PROPOSED (near-certain; backed by tests).
- **Evidence:** engine suites green in this session's full run (journal reversal consistency, trial balance,
  sales/purchase posting, inventory closure, treasury custody, money precision) **[V]**; single reversal
  mechanism and posting conventions documented in code **[V]**.
- **Consequence:** the new accounting app is UI + workflows + missing features (M6), never a fork of
  posting logic.

## D-004 — Scope enforcement for reps: enforce in the API, not just filter in the UI

- **State:** DECIDED & IMPLEMENTED 2026-10-15 (M4). The owner's standing «واصل العمل»
  directive ran against a roadmap that already prescribed the enforcement branch, and the
  recommendation's precondition ("if the product promise includes 'rep sees only his
  van/route'") is the promise the rep app ships with — so it was implemented, not
  described. Every `field-sync` / `rep-workspace` route resolves the rep from the
  caller's membership, asserts his warehouse scope through `membership_role_scopes`
  (AUD-03 semantics), and re-checks resource ownership per replayed row; the negative
  matrix is the exit evidence (`apps/api/test/field-sync.spec.ts`). Reversal path: drop
  the guard calls — the UI filtering still exists independently.
- **Context:** `membership_role_scopes` (warehouse/cash-location/POS-terminal) exists but `assertScope()` is
  consumed only by platform backups today (audit item AUD-03) **[V]**.
- **Recommendation:** if the rep app's product promise includes "rep sees only his van/route", implement
  scope checks on every `rep-workspace`/`field-sync` route with the full negative-test matrix; if not,
  rename/describe the scope UI as a view filter. Do not ship an implied security boundary.

## D-005 — Van-sales refactor before rep backend (decomposition, not rewrite)

- **State:** PROPOSED.
- **Evidence:** 6,479-line service with proven, tested domain logic **[V]**; rep backend depends on its
  flows; rewriting after building on it would churn new code.
- **Constraint:** code movement only; tables, routes and spec assertions unchanged.

## D-006 — Rep app shell: PWA (web) first

- **State:** PROPOSED, needs owner confirmation against distribution requirements.
- **Rationale:** the proven offline stack is browser-based (IndexedDB queue + sync engine, service-worker
  installable) **[V]**; app-store distribution or heavy native device use (printers, scanners) would justify
  React Native/Expo — the sync *contract* (snapshot/delta/replay through canonical engines) stays identical
  either way, so this decision is reversible without backend changes.
- **Assumption to validate [A]:** target devices are modern Android/iOS browsers; thermal printing in the
  field is via Bluetooth from a web print bridge or not required at pilot.

## D-007 — Costing model: keep perpetual weighted average; add standard costing only as an explicit engine project

- **State:** PROPOSED, needs owner decision (product scope question for manufacturers).
- **Evidence:** today only weighted average **[V]**; production posting derives unit cost from actual
  consumption **[V]**; standard costing adds variance accounts, cost rolls and a different inventory
  valuation path — an engine-level change, not a report.
- **Recommendation:** ship the accounting app on weighted average; make standard costing a separately
  scheduled engine project (M6.3) with its own migration/reversibility plan, only if target customers
  require it.

## D-008 — Open van-sales accounting policy decisions must be closed before settlement screens ship

- **State:** PROPOSED (blocking for M5's closing UX).
- **Evidence:** six policy decisions (shortage responsibility, damage thresholds, carry-over, …) are open in
  `VAN_SALES_IMPLEMENTATION_AUDIT.md` §9 **[R]**; the engine already refuses silent settlement
  (`pending_policy_approval`) **[V]**.

## D-009 — Test gating must be proven to fail on red (R-19) before reuse claims rest on it

- **State:** CLOSED (2026-10-15, M0 + §8). Proven at CI level on the real runner.
- **Evidence:** (a) vitest exit code 0 on a failing probe reproduced in this environment **[V]**; (b) the
  repository's own sole CI run ("Verify", base commit `9ec342c`) concluded **success** despite that commit
  having at least one always-failing test (`printing-and-cards.spec.ts`), verified via `gh api` against the
  run record and via local runs of the same commit **[V]**.
- **Resolution:** root cause was `async-exit-hook`'s `exit`/`beforeExit` handlers registered by
  `embedded-postgres` (the `beforeExit` one force-exits with 0, masking vitest's failure code).
  `packages/testing/src/test-database.ts` now removes both listeners after the embedded server starts
  (signal handlers preserved). Verified locally in both directions: red run → exit 1, green run →
  exit 0 **[V]**. Permanent regression spec: `apps/api/test/exit-code-gate.spec.ts`.
- **CI-level canary (the closure evidence):** the first post-fix CI run (`38658122368`, 2026-10-15
  00:06 UTC, commit `228b612`) **failed** after 13m59s on a genuinely broken state — an unhandled
  `57P01` teardown race (R-24) that the old masked gate had been hiding all along. A red pipeline
  now produces a red conclusion on GitHub Actions; after the R-24 fix the same pipeline runs green.
  `pnpm verify`/CI may be treated as the reuse safety net.

## D-010 — No implementation in this task

- **State:** SUPERSEDED (2026-10-14): the assessment closed with owner approval and the instruction to
  begin work; implementation now proceeds per `IMPLEMENTATION_ROADMAP.md` (M0 log in `PROGRESS.md` §7).
  The original scope statement is retained below for the record.
- **Original scope (assessment phase):** the deliverables are the `docs/` set; no feature code,
  migrations, or app scaffolds were created; nothing was committed or pushed; no database outside throwaway
  test clusters was touched. **[V]**
