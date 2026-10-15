# @erp/accounting-app

The accountant-focused surface of the Cloud ERP (M3 scaffold, 2026-10-15): **read-only**
screens over the existing API — the chart of accounts with posted balances, the journal
register, fiscal periods, the trial balance, the income statement, cost centres and the
ZATCA e-invoicing desk (seller card + filings).

## What it is (and deliberately is not)

- **No new backend.** Every screen calls an existing `GET` endpoint
  (`/accounts`, `/journal-entries`, `/fiscal-periods`, `/statements/trial-balance`,
  `/statements/income-statement`, `/cost-centers`, `/einvoice/settings`,
  `/einvoice/filings`). Writes stay in the staff panel until the accounting write-flows
  milestone.
- **Same session contract as staff** — `@erp/web-core` session + api client, transparent
  token refresh, `MFA_REQUIRED` step. No signup here; account lifecycle lives in staff.
- **Entitlement-controlled, not tenancy-controlled (D-002)** — the gate checks
  `GET /marketplace/apps` for the `accounting` app code (`tenant_apps`): an enabled
  install or a pristine core bundle lets the tenant in; an operator's explicit disable
  locks it out. The rule lives in `lib/accounting.ts` (`accountingAppEntitled`) and is
  pinned in `tests/app.spec.ts`.
- **Navigation is permission-honest** — the shell and the home page only offer screens
  whose `RequiresPermission` code the session actually holds (`lib/navigation.ts`).

## Wiring

- Next.js 15, `output: 'standalone'`, same-origin `/api/v1/*` rewrite (works from any
  host without CORS), CSP + hardened headers — same `next.config.mjs` posture as staff.
- Design System v3 via `@erp/ui` (tokens, theme, toasts); shared web runtime via
  `@erp/web-core` (api, session, i18n factory, use-query, AUD-13 surface routing).
- `pnpm --dir apps/accounting-app run dev` (port 3005; `ACCOUNTING_APP_PORT` overrides),
  or `node scripts/next-run.mjs accounting-app dev` from the root.
- Covered by the root `pnpm verify` pipeline like every workspace (`typecheck`, `lint`,
  `test`, `build`).

## Screens

| Route | Screen | Endpoint | Permission |
|---|---|---|---|
| `/` | Home (permission-filtered map) | — | `tenant.view` |
| `/accounts` | دليل الحسابات (with posted balances) | `GET /accounts?with_balances=1` | `accounting.account.view` |
| `/journals` | القيود اليومية | `GET /journal-entries` | `accounting.reports.view` |
| `/periods` | الفترات المالية (+ fiscal years) | `GET /fiscal-periods`, `GET /fiscal-years` | `accounting.period.view` |
| `/trial-balance` | ميزان المراجعة | `GET /statements/trial-balance` | `accounting.reports.view` |
| `/income-statement` | قائمة الدخل | `GET /statements/income-statement` | `accounting.reports.view` |
| `/cost-centers` | مراكز التكلفة (with balances) | `GET /cost-centers?with_balances=1` | `accounting.account.view` |
| `/zatca` | مكتب الزكاة والضريبة | `GET /einvoice/settings`, `GET /einvoice/filings` | `einvoice.view` |
