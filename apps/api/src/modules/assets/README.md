# assets — الأصول الثابتة (M6.1)

Register, categories, the monthly depreciation schedule, and the posting run that turns
the schedule into journal entries.

## The one rule

The module **never writes the ledger directly**. `runDepreciation` builds the lines
(Dr depreciation expense / Cr accumulated depreciation, per asset, from the asset's
override accounts or its category's defaults) and hands them to
`AccountingService.postJournalInTx` — so balance checking, the open-period guard,
period module locks and the `JE-` sequence all live in exactly one place. The GL
integrity suite (trial balance, reversal consistency) therefore covers depreciation like
any other posting.

## Tables (migration 0129)

| Table | Role |
| --- | --- |
| `asset_categories` | code + default useful life + the three posting accounts (asset / accumulated / expense) |
| `fixed_assets` | the register; the acquisition date's month is the FIRST depreciation month; `straight_line` only |
| `asset_depreciation_entries` | the run ledger: one row per asset per month EVER — `UNIQUE (tenant_id, asset_id, period)` **is** the run's idempotency, each row pointing at its journal entry |

Accumulated depreciation is never a stored balance: it is always `SUM(amount)` over the
run ledger, so it can never drift from the GL.

## The math (straight line)

* monthly = `(cost − salvage) ÷ life`, rounded to 4 decimals (HALF_UP);
* the LAST month carries the exact remainder, so the schedule telescopes to
  `cost − salvage` exactly — never a rounding hole in the ledger;
* an asset whose every life-month is posted flips to `fully_depreciated` (a stated
  status, not a per-read derivation).

## Routes

| Route | Permission | What it does |
| --- | --- | --- |
| `GET /asset-categories` | `accounting.assets.view` | list categories |
| `POST /asset-categories` · `PATCH /asset-categories/:id` | `accounting.assets.manage` | maintain categories |
| `GET /fixed-assets` | `accounting.assets.view` | the register with accumulated + net book value |
| `POST /fixed-assets` | `accounting.assets.manage` | register an asset |
| `GET /fixed-assets/:id` | `accounting.assets.view` | the card + schedule summary |
| `GET /fixed-assets/:id/schedule` | `accounting.assets.view` | planned vs posted month by month |
| `POST /fixed-assets/depreciation-runs` | `accounting.assets.depreciate` | run a month (one balanced JE; re-run is a declared no-op) |
| `GET /fixed-assets/depreciation-runs` | `accounting.assets.view` | the posted depreciation ledger |

The run body: `{ period: 'YYYY-MM', date?, branchId?, fiscalPeriodId?, assetIds?, description? }`.
Branch and fiscal period resolve from the date exactly like `POST /journal-entries`;
a closed period is refused with `FISCAL_PERIOD_CLOSED` (409), never silently re-routed.

## Deliberately out of scope (follow-ups)

* **Disposal** (sale / write-off with gain-loss posting) — the register marks
  `disposed` but no disposal route ships yet; it needs the same
  `postJournalInTx`-only treatment plus a reversal story.
* Other methods (declining balance, units of production) — the `method` column exists so
  adding one is a migration-free change, but only `straight_line` is implemented.
