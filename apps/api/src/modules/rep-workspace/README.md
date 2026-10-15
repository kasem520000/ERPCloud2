# rep-workspace module

M4 — thin orchestration for the rep app's working screens. No tables of its own, no engine calls
of its own: it reads the same tables the van-screens read and delegates closing to the custody
saga. Rep identity + warehouse scope come from the field-sync guard (D-004), imported once and
reused — the two modules must never disagree about who a rep is.

| Route | Permission | What it does |
|---|---|---|
| `GET /rep-workspace/day?date=YYYY-MM-DD` | `van_sales.view` | One business day of the rep's documents + collections with per-customer visit aggregation (revenue net of returns, collected, outstanding). Default date = today. |
| `GET /rep-workspace/custody` | `van_sales.view` | Official van warehouse balances + open load orders with expected vs. actual remaining, expected vs. collected cash. |
| `POST /rep-workspace/closing` | `van_sales.closing.submit` | The rep's own shift-closing submission — wraps `VanSalesCustodyService.submitClosing` after an explicit ownership check. |

## Why the closing route exists twice

`POST /van-sales/load-orders/:id/submit-closing` is the back-office route: an accountant (or the
owner) may close any rep's shift on his behalf. `POST /rep-workspace/closing` is the rep path and
refuses any load order that is not the caller's own with `403` — "hiding the button" is never the
only thing standing between two custodies. Same saga, one ownership check apart.
