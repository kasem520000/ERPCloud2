# Inventory ledger

`InventoryService.record()` is the append-only inventory boundary used by sales and purchasing documents. Every movement is recorded in `inventory_transactions` and the same transaction updates `stock_balances`.

## Costing hints

- `inWithCost`: incoming quantity increases the pool at the supplied unit cost.
- `outAtAvg`: outgoing quantity leaves the pool at the current moving average cost.
- `returnAtOriginalCost`: callers may provide the original cost for a return; the ledger records the hint and supplied cost for auditability.

For example, 10 units at 100 followed by 5 at 110 produces `(1000 + 550) / 15 = 103.3333`. Issuing 3 units leaves 12 units and the same average. Invoice discounts are allocated by line value: values 800 and 200 with a discount of 50 receive 40 and 10 respectively.

The ledger is immutable at the database trigger level. `valuationAsOf()` replays transactions up to a timestamp, while `recomputeBalances()` repairs the cache from the ledger.

Adjustment approval, transfer receive workflows, and the lot/serial lifecycle are implemented
and covered by `inventory-documents.spec.ts`, `inventory-serials.spec.ts`,
`inventory-document-serials.spec.ts` and `inventory-batch-line.spec.ts` — see the phase 05
section of `docs/desktop-parity/PHASE_05_INVENTORY.md` for the sources and the rules.

## Production orders (`/inventory/production-orders`, migration 0027)

أمر الإنتاج: components out, one finished item in, in a single transaction. Components
leave at the warehouse's moving average; the output is valued at exactly the total that
left divided by the produced quantity, so inventory value is conserved and the document
raises **no journal entry**. Guards: the output cannot be its own component, a component
cannot repeat, and completion fails with `STOCK_INSUFFICIENT` instead of driving stock
negative. Only a draft order can be completed or cancelled — a completed order is reversed
with a stock adjustment, not by rewriting it.

Permissions: `inventory.view`, `inventory.production.manage` (create/cancel),
`inventory.production.complete` (move the stock). Report key: `production-orders`.

## The batch on the document line (R5, migration 0088)

`Class/InvoiceOper.cs:1635` writes the batch onto the line it belongs to —
`INSERT INTO InvoiceItemDetail(…, ItemSerialNo, BatchNo, ItemProductionDate, ItemExpireDate …)`
— and reads it back when the document is reopened (L3886–L3888). The cloud keeps the same
three columns on `stock_voucher_lines`, `stock_adjustment_lines` and `stock_transfer_lines`,
beside the `lot_id` that was already there: the line carries what the pack says, and the
movement reads the id.

`resolveUploadedLots()` runs when a document is **created**, before `assertStockable()`:

* a line that names a batch looks it up by (tenant · item · lot number) and **creates** it with
  the line's own dates if it does not exist — so a batch never has to be registered in one
  screen before it can be written in another;
* empty dates are filled from the recorded lot, never erased from it;
* a date that contradicts the recorded one is refused `409 LOT_EXPIRY_MISMATCH`, naming the
  batch and both dates (`recorded` / `given` in `errors[0]`) — one batch, one expiry date, or
  the expiry report lies;
* a batch on an item whose `trackLot` is false is refused `422 LOT_NOT_TRACKED`;
* an explicit `lotId` is still accepted, but only for that item and that tenant
  (`404 LOT_NOT_FOUND` otherwise).

`item_lots.production_date` is a separate column from `received_at` (0088 backfills it once
from the receiving date): production and receipt are different days, and the lot screen used to
write one into a box labelled with the other.

