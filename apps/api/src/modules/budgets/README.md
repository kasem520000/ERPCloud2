# Budgets — الموازنات والمقارنة بالفعلي (M6.4)

A budget is a fiscal-year plan: per postable account, an amount per fiscal period.
`POST /budgets` takes the **annual** figure per account and distributes it across the
year's periods — even instalment, HALF-UP 4 decimals, the last period carries the exact
remainder (the same telescoping rule the fixed-asset schedule uses). A `PATCH` can
replace the monthly lines explicitly for seasonality **while the budget is a draft**.

## The two rules the module is built on

1. **لا يُخزَّن رصيدٌ ثانٍ** — "actual" is the posted journal movement of each account
   (the trial balance's own reading, signed by the account's normal balance:
   debit-normal `مدين − دائن`, credit-normal `دائن − مدين`). The budget side is
   `SUM(budget_lines.amount)`. Nothing in this module can drift from the ledger because
   nothing in it stores a balance.
2. **الاعتماد يجمّد** — `PATCH {status: 'approved'}` freezes the lines (409
   `BUDGET_APPROVED_FROZEN` on any later line change) and approved budgets cannot be
   deleted. A plan people are measured against does not silently move.

## Routes

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /budgets` | `accounting.budget.view` | With FY name + `totalAmount` (SUM of lines). |
| `POST /budgets` | `accounting.budget.manage` | `{name, fiscalYearId, notes?, lines: [{accountId, annualAmount}]}` → distributed draft. |
| `GET /budgets/:id` | `accounting.budget.view` | Card with the monthly lines (account + period info). |
| `PATCH /budgets/:id` | `accounting.budget.manage` | `{name?, notes?, status?, lines?}` — `lines` replaces monthly rows `(accountId, fiscalPeriodId, amount)`; draft only. |
| `DELETE /budgets/:id` | `accounting.budget.manage` | Draft only (soft delete). |
| `GET /budgets/:id/variance?to=YYYY-MM-DD` | `accounting.budget.view` | The computed report. |

## Variance report semantics

- `to` defaults to the fiscal-year end and is clamped to it.
- Budget side = sum of lines in periods **fully elapsed** (`period.end_date <= to`) — a
  partial period's budget is not counted against partial actuals.
- Actual side = posted-entry movement over `[FY start, to]`, natural-balance signed.
- Row variance = budget − actual; `variancePct` only when budget > 0.
- Accounts with actual movement but no budget line appear with `inBudget: false`
  (budget 0) — unbudgeted spending is visible, not hidden.
- `totals` = **نتيجة الموازنة** over revenue + expense accounts only
  (`budgetedResult = Σ revenue − Σ expense`, same for actual); mixing assets and
  liabilities into one sum has no accounting meaning.

## Tables (migration 0131)

- `budgets` — name (unique per tenant + fiscal year), FY, `draft | approved`, audit +
  soft delete + legacy columns.
- `budget_lines` — `(budget, account, fiscal_period)` unique; `amount >= 0`; the annual
  total is always derived by SUM, never stored.

## Out of scope (deferred)

- Budget approval *workflow* (the approvals module) — approval here is a single manage
  action that freezes; routing it through approvers is a product decision, not a gap.
- Budget revisions (v2 of an approved budget) — an approved budget that must change is
  a new budget next to it; explicit history beats silent edits.
- Branch/cost-centre dimension on budget lines — the FY/account/period grain first.
