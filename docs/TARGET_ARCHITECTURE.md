# TARGET_ARCHITECTURE.md — Recommended structure for the new specialized accounting ERP + field-sales app

> **Status:** Assessment deliverable (2026-10-14). Documentation only — nothing below is implemented yet.
> This document answers the required architecture questions: same monorepo or not, same API or not, same
> database or not, and how the two new applications share the authoritative services.

## 1. The architectural question and the answer

**Question:** Should the new accounting app and the field-sales rep app be added as separate frontend
applications inside the existing monorepo while sharing the current API — or is a different structure
justified?

**Answer: same monorepo, same API, new frontend applications — with two structural additions.** **[V]**
(the existing state this is based on) + decision (see `DECISIONS.md` D-001).

Rationale, from verified properties of the current system:

1. The requirement that both new apps use the *same authoritative invoice, inventory, costing, tax and
   accounting services* is already how the platform works: POS, van-sales, e-commerce and purchases all
   post through the same engines in one NestJS API. A second API would immediately create a second place
   where posting rules live — the platform's most valuable invariant, bought with several re-engineering
   rounds (see `VAN_SALES_REENGINEERING_DELIVERY_REPORT.md`), would be put at risk for no gain.
2. Tenant isolation, RBAC, idempotency, sequences, ZATCA, audit and billing are cross-cutting concerns of
   the *platform*, not of a product. Duplicating them in a new service would double the security surface
   and the compliance work.
3. The monorepo already demonstrates multi-frontend sharing: `apps/staff`, `apps/platform-admin`,
   `apps/marketing`, `apps/customer-portal` share `@erp/contracts`, `@erp/ui`, `@erp/config` and the API.
   Adding two more apps is an incremental change, not a new pattern.
4. The new product's users (manufacturers, wholesalers, food factories, van-sales distributors) overlap the
   existing user base; the same tenant may license both the classic ERP and the new specialized packs
   (marketplace/plan gating already supports this).

The two structural additions:

- **A. `packages/web-core`** (new shared package): the non-UI web plumbing currently duplicated or
  app-local in `apps/staff` — API client with session refresh, offline IndexedDB adapter + sync engine
  (generalized from the POS implementation), surface routing, i18n primitives. The rep app and the new
  accounting app (and progressively `apps/staff`) import it. **This is not a new idea for this repo**: the
  existing delivery report (`docs/PRODUCTION_POSTING_AND_MATERIAL_SOURCE_REPORT.md` §1/§8) already planned
  "المرحلة 0: استخراج `packages/web-core`" followed by scaffolding a dedicated vertical app (`apps/bakery`)
  for the factory/bakery product — the present proposal generalizes that plan to the two new applications. **[R]**
- **B. A `field-sync` API module** (new NestJS module in `apps/api`): the generalized offline
  synchronization service (master-data snapshots + document replay) described in §4, built on
  `IdempotencyStore`, `SequencesService` and the existing engines — *not* a new business engine.

## 2. Target monorepo layout (additions in **bold**)

```
apps/
  api/                  # THE API (NestJS). New modules added, no second API.
    src/modules/
      accounting/       # unchanged (the authoritative GL engine)
      inventory/        # unchanged (the authoritative stock ledger)
      sales/            # unchanged (the authoritative invoice engine)
      treasury/         # unchanged
      van-sales/        # refactored into a folder of cohesive services (see REUSE_ASSESSMENT §2.2)
      field-sync/       # NEW: offline master-data snapshots + replay for the rep app
      rep-workspace/    # NEW: rep-scoped endpoints (day plan, van stock, custody summary) — thin,
                        #      every write goes through sales/inventory/treasury/van-sales engines
      fixed-assets/     # NEW (roadmap phase; verified missing today)
      budgets/          # NEW (roadmap phase; verified missing today)
  staff/                # existing ERP back-office (unchanged product)
  platform-admin/       # existing platform-owner console (reused; new product = plans/marketplace entries)
  marketing/            # existing public site (new product pages when product naming is decided)
  customer-portal/      # existing customer portal
  migrator/             # existing legacy-migration engine (reused for onboarding)
  accounting-app/       # NEW: the specialized accounting ERP frontend (Next.js 15 + @erp/ui + web-core)
  rep-app/              # NEW: the offline-first field-sales frontend (see §5 for shell choice)
packages/
  web-core/             # NEW: shared web plumbing (API client, session, offline db, sync engine)
  ui/ contracts/ config/ database/ testing/   # unchanged
```

Rules that keep this safe (all enforced today for existing apps and extended to the new ones):

- Frontends never talk to the database and never talk to each other's private APIs; they call `/api/v1/*`
  through their own same-origin proxy (`API_PROXY_TARGET`) — the browser/mobile webview never needs the API
  host. **[V]** (existing mechanism)
- Every new API route declares `@RequiresPermission(...)` with codes registered in
  `packages/contracts/src/permissions.ts`; guard order stays frozen. **[V]**
- Every new tenant table ships with the canonical RLS policy and joins `rlsProtectedTables`. **[V]**
- ESLint `boundaries` config already restricts cross-package imports; extend it to `web-core`. **[V]**

## 3. API structure rules for the new modules

1. **No second engine.** `rep-workspace` and `field-sync` orchestrate; they do not implement posting,
   costing, tax or ledger writes. The litmus test: a table scan of the new modules must find **no**
   `journal_entries`/`journal_entry_lines`/`inventory_transactions`/`stock_balances` inserts — only
   engine calls (`postJournalInTx`, `recordInTx`, `sales.postInTx`, `treasury.*VoucherInTx`), exactly like
   `van-sales.service.ts` does today. **[V]** (pattern in current code)
2. **Writes are transactional and idempotent.** Every mutating rep endpoint accepts an `Idempotency-Key`
   (interceptor already exists); saga-style flows (load→transfer→pending_receipt) use idempotency keys per
   step and `ifAlreadyReversed: 'reuse'` semantics for retries — the proven van-sales pattern. **[V]**
3. **Master-data snapshot endpoints** return versioned, expiring payloads (the POS `offline-data` contract:
   `schemaVersion`, `generatedAt`, `expiresInSeconds`) so clients can detect staleness. **[V]** (pattern)
4. **Replay is the canonical path.** `offline-sync` replay of a rep invoice creates a *draft then posts*
   through `sales.postInTx` — the same code path as the online UI, never a "sync-only" insert. Conflicts
   (price changed, stock insufficient, period closed) return structured error codes the app can surface. **[V]** (pattern)
5. **Scope enforcement** (rep ↔ van warehouse / route / cash location) uses `ScopePolicy.assertScope()` on
   every rep endpoint if the product promises scoped access (AUD-03 resolution — decision D-004). **[V]**

## 4. The offline-first rep app (target design)

Server contract (new `field-sync` module, generalizing `pos.service.ts`):

- `GET /field-sync/snapshot` — per-rep master data: customers (with per-customer prices from
  `van_sales_customer_prices`), items/prices/tax groups, the rep's van warehouse stock (from `stock_balances`
  — official, not derived), price lists, payment methods, rep profile + permissions, sync watermarks.
- `GET /field-sync/changes?since=<watermark>` — delta fetch (design goal; POS snapshot is full-fetch today —
  see risk R-09 in `LEGACY_RISK_REGISTER.md`).
- `POST /field-sync/replay` — batched, ordered (`device_id` + `sequence_no` + `offlineId`) replay of rep
  documents: invoices (with bonus lines), collections, returns, stock counts; each replayed through the
  canonical engines; per-item results `synced | conflict` with error codes; persisted in a new
  `field_sync_queue` table modeled on `offline_queue` (queue + conflict ledger — **not** a second document
  store). **[V]** (design modeled on verified 0102 pattern)

Client: IndexedDB (web/PWA) — see D-006 for the shell choice — holding snapshot + queue + outbox, with the
same rules the POS client follows: the device owns the working copy, the API is the authority after replay,
conflicts are actionable in the UI, and every queued document gets a UUID + monotonic sequence before it
leaves the device. **[V]** (pattern)

Custody model for reps (reused, verified in van-sales): van warehouse = custody in `stock_balances`; cash
custody = `cash_location_custodians` + treasury vouchers; closing = counted vs expected with policy
approval states; shortages never auto-post (explicit `shortage_policy_status` decisions). **[V]**

## 5. The new accounting application (target design)

- A Next.js 15 app (`apps/accounting-app`) on `@erp/ui` + `web-core`, aimed at accountants of
  manufacturers/wholesalers/food factories: journal workspace, period close checklist, reconciliation
  (stock-vs-GL, bank), fixed assets (new), budgets (new), costing views (average today; standard costing is
  decision D-007), ZATCA filing desk, reports.
- All data via the existing API (`accounting`, `inventory`, `treasury`, `reporting` modules). New backend
  work is additive (fixed assets, budgets, WIP, reconciliation views) — see the roadmap.
- Multi-entity of the same tenant: branches + cost centers already cover most cases; no new tenancy concept
  is introduced. **[V]**

## 6. What deliberately does NOT change

- One PostgreSQL database, one schema, RLS tenancy (see `DATABASE_AND_TENANCY.md`).
- One NestJS API deployment + one worker deployment (k8s `api.yaml`/`web.yaml` + `WORKER=1`); the new apps
  are additional Next.js deployments in `deploy/k8s/web.yaml`-style manifests. **[V]** (existing topology)
- One CI gate: `pnpm verify` covers the new apps automatically once they are workspace members with
  `typecheck`/`lint`/`test`/`build` scripts. **[V]**
- The platform-owner console, billing and marketplace remain the monetization and lifecycle plane for the
  new product (new plan codes / app codes). **[V]**
