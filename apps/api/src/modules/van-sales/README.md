# van-sales module

Van-sales (توزيع السيارات) on top of the official engines — inventory transfers, sales invoices,
treasury, accounting. The module **never** writes its own stock or journal movements: every state
change goes through `InventoryService` / `SalesService` / `TreasuryService` / `AccountingService`
and is only linked back (`stock_transfer_id`, `sales_invoice_id`, …).

## M1 decomposition (2026-10-15)

The former 6,479-line `van-sales.service.ts` was split into cohesive services behind the **same
controller routes** — pure code movement, no behavior change (no table changes, no engine-call
changes, no route changes). Diff review of engine call sites is the exit gate for this milestone.

| File | Responsibility | Controller routes |
|---|---|---|
| `van-sales-shared.service.ts` | Cross-cutting in-transaction helpers (tenant policy, branch/warehouse/posting-profile/salesman resolution, official van stock balances, settling-warehouse guard, count-lot resolution, accountant notifications) + module helpers + `VanSalesTenantPolicy` | — (internal) |
| `van-sales-reporting.service.ts` | Read models: `dashboard` (also the load-order state snapshot consumed by the sagas) and `getReports` | `GET dashboard`, `GET reports` |
| `van-sales-pricing.service.ts` | Customer price writes; `resolveShortageUnitPriceInTx` for closing/settlement | `POST customer-prices` |
| `van-sales-production.service.ts` | Factory production batches (official production/WMS engines) | `POST production-batches` |
| `van-sales-load-orders.service.ts` | Load-order saga: creation + supply, rep receipt confirm/refuse, transit-difference decision, cancellation | `POST load-orders`, `…/confirm-receipt`, `…/reject-receipt`, `…/close-transit-difference`, `…/cancel` |
| `van-sales-documents.service.ts` | Rep documents: sales documents (+returns, print view) and the rep workspace | `POST documents`, `POST documents/:id/returns`, `GET documents/:id/print-view`, `GET me` |
| `van-sales-custody.service.ts` | Custody settlement: shift closing/approval, the stock-settlement engine, customer collections, salesmen/custody view + account linking | `POST load-orders/:id/submit-closing`, `…/approve-closing`, `…/settle-stock`, `…/settle`, `POST collections`, `GET salesmen`, `POST salesmen/:id/account` |
| `van-sales-legacy.service.ts` | One-off reconciliation of legacy pre-platform rows into official engine links | `POST legacy-reconciliation` |

Service dependency graph (acyclic — do not add a cycle back):

```
shared ──► (PostingProfiles, Notifications engines only)
reporting ──► shared
pricing ──► shared, reporting
production ──► shared, reporting
load-orders ──► shared, reporting
documents ──► shared, reporting
custody ──► shared, reporting, pricing
legacy ──► shared
```

`dashboard` doubles as the **load-order read model**: the saga services call it to validate state
and build responses, so it must stay a pure read (no writes) — that is what keeps the graph acyclic.

## Saga patterns (must be preserved when extending)

1. **Multi-step sagas compensate through official engines.** The supply saga
   (`createLoadOrder`) spans three steps that cannot share one transaction, because the official
   transfer API opens its own: (1) insert the `draft` load order, (2) `InventoryService.createTransfer`
   + `sendTransfer`, (3) `markSupplyAwaitingReceipt`. A failure after step 2 calls
   `compensateFailedSupply`, which is deliberately conservative:
   - the official `cancelTransfer` puts the quantity back and reverses the send journal —
     never a hand-written mirror movement;
   - the load order is **marked** `canceled` with the outcome written to `stock_settlement_note` —
     never deleted, the audit trail keeps the attempt;
   - if the cancellation itself fails, that is recorded for the warehouse keeper and the
     **original** error is still what the caller sees.

2. **Idempotency keys make replays safe.**
   - Write paths accept `idempotencyKey` and store it on the row; a unique partial index
     (`ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`) rejects the replay.
   - Derived internal keys are stable per business object, e.g.
     `van-damage-writeoff:${loadOrderId}` and
     `van-collection-voucher:${documentId}:${idempotencyKey ?? amount}` — resuming must never
     move a kilogram or a riyal twice.
   - Collections additionally ride on `invoice_payments.idempotency_key` (unique per tenant), so a
     replayed collection cannot allocate twice.

3. **Resume paths reuse, they never redo.** `settleLoadOrderStock` (the safe resume after an
   approved closing whose settlement did not complete) reuses the already-created official count
   document — never a second count. Engine reversals use `ifAlreadyReversed: 'reuse'`
   (the accounting engine option) wherever a document may already have been reversed.

4. **Custody honesty: goods sit in transit until the rep confirms.** Nothing enters the van
   balance at supply time; `confirmReceipt` is the moment the quantity becomes the rep's official
   balance, and `rejectReceipt` closes the official transfer with `mode: 'return'`.

5. **State guards are shared queries.** `assertVanWarehouseNotSettlingInTx` (shared service) blocks
   new supplies/documents while a closing is in progress on that van warehouse; it is used by
   load-orders, documents and custody alike.

## Known follow-ups (registered, not changed in M1)

- **R-23:** `createDocument` builds its own ZATCA TLV QR payload (`buildZatcaTlvBase64`) with
  hard-coded fallbacks (seller name / VAT number) instead of reading the e-invoicing module —
  same pattern as R-01. Fix belongs to the e-invoicing integration milestone, not this refactor.
