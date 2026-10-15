# field-sync module

M4 — the API side of the offline-first rep app. Master-data snapshot + delta for the device's
IndexedDB, replay of the device's offline queue, and the conflict inbox. The module **never**
writes a document itself: every replayed row goes through the van-sales sagas
(`VanSalesDocumentsService`, `VanSalesCustodyService`, `VanSalesLoadOrdersService`) and through
them into `sales.postInTx` / the treasury voucher engine — exactly the rule the van-sales module
already follows.

## Files

| File | Responsibility | Controller routes |
|---|---|---|
| `field-sync-rep-guard.service.ts` | The D-004 boundary: membership → salesman card → van warehouse scope (`assertScope`). Every route passes through it before touching data. | — (internal, exported for `rep-workspace`) |
| `field-sync-snapshot.service.ts` | Rep-scoped master data: full snapshot and delta since a watermark | `GET snapshot`, `GET delta` |
| `field-sync-replay.service.ts` | Batch replay of the device's offline queue + the rep's conflict inbox | `POST replay`, `GET queue` |

## Routes × permission × engine

| Route | Permission | Engine calls |
|---|---|---|
| `GET /field-sync/snapshot` | `van_sales.view` | — (reads only) |
| `GET /field-sync/delta?since=` | `van_sales.view` | — (reads only) |
| `POST /field-sync/replay` | `van_sales.view` + per-row: `van_sales.invoice.create` (invoice/return), `van_sales.collection.create` (collection) | `documents.createDocument`, `documents.createReturnDocument`, `custody.collectCustomerDebt`, `loadOrders.confirmReceipt` |
| `GET /field-sync/queue?status=&limit=` | `van_sales.view` | — (reads only) |

## Scope enforcement (D-004, closed 2026-10-15)

"The rep sees and moves only his own van" is enforced in the API on every route:

1. **Identity** — the rep is derived from the caller's membership
   (`memberships → employees → salesmen`); no route accepts a salesman/warehouse id. A caller
   without a salesman card gets `403 FIELD_SYNC_NOT_A_REP`.
2. **Card state** — inactive card → `403 FIELD_SYNC_REP_INACTIVE`; card without a van warehouse →
   `403 FIELD_SYNC_NO_VAN_WAREHOUSE`.
3. **Warehouse scope (AUD-03)** — `assertScope('warehouse', <his van warehouse>)` over
   `membership_role_scopes`: the role grants must explicitly cover the van warehouse.
   `POST /van-sales/salesmen/:id/account` (`restrictToVanWarehouse`) is what writes that row.
4. **Resource ownership** — every replayed row's `loadOrderId` / `documentId` must belong to the
   rep's own salesman card (`FIELD_SYNC_SCOPE_VIOLATION` otherwise); the `salesman_id` stored on
   the queue row is always derived from the replaying membership, never from the payload.
5. **Device binding** — a device whose latest queue row belongs to another rep is refused
   (`FIELD_SYNC_DEVICE_BOUND`), so one device cannot mix two custodies.

The negative matrix proving all of the above lives in `apps/api/test/field-sync.spec.ts`.

## Snapshot & delta

`GET snapshot` returns the rep-scoped master data plus a `watermark` (the database clock read in
the same transaction). Collections: `customers`, `customerPrices` (per-customer prices with their
effective window — the app filters locally, a closed window needs no server signal), `items`,
`units`, `taxes`, `itemUnits`, `barcodes`, `priceLists`, `priceListItems`, `paymentMethods`, plus
live operational state: `stock` (his van warehouse only), `openLoadOrders`, `openCreditDocuments`.

`GET delta?since=<watermark>` returns:

- `changed` — rows where `GREATEST(created_at, updated_at) > since` (per collection);
- `deleted` — soft-deleted ids per collection (`deleted_at > since`);
- `full` — collections with no change tracking (`itemUnits`, `barcodes`) and live operational
  state (`stock`, `openLoadOrders`, `openCreditDocuments`), re-read in full because current value
  is what the app needs;
- `watermark` — the new high-water mark to store and send next time.

The client merges `changed`, prunes `deleted`, replaces `full`, and never depends on a device
clock. When a delta is too old the client simply re-pulls the snapshot.

## Replay contract

`POST /field-sync/replay` with `{ deviceId, operations: [{ offlineId, sequenceNo, operation,
payload, createdAt? }] }`, `operation ∈ { invoice, collection, return, receipt }`. Batches are
capped at 100; a bad row is a **row-level conflict**, never a batch failure — the response
reports per row `{ status: 'synced' | 'conflict', errorCode, message, resolution }` exactly like
offline POS.

Idempotency layers (outermost first):

1. `offline_id` unique per tenant — a synced row replays its **recorded outcome**
   (`result` jsonb) without calling any engine;
2. `(device, sequence_no)` monotonic — old/duplicate sequences never re-enter;
3. engine saga keys — every engine call passes `idempotencyKey = "field-sync:{offlineId}"`, and
   the van-sales sagas already key their documents/movements/payments on it, so a crash between
   the engine commit and the queue update cannot post anything twice. For `receipt`, the
   `VAN_LOAD_ORDER_NOT_AWAITING_RECEIPT` error after a confirmed receipt is recognised as the
   crash window and recorded as synced.

A `collection`/`return` payload may reference `documentId` (a server id from the snapshot's
`openCreditDocuments`) **or** `sourceOfflineId` (an earlier invoice from the same device's queue,
e.g. earlier in the same batch) — the rep can collect a credit sale he just made offline.

## The `field_sync_queue` table (migration 0128)

Modeled on `offline_queue` (0102): replay identity + conflict ledger only — never a second
document store. Extra columns the field flow needs: `salesman_id` (derived, auditable), `operation`
(the replay is a mixed batch), `result` (engine outcome snapshot), `document_id` (the van document
a synced row became). Reversibility spec: `apps/api/test/migration-0128-reversibility.spec.ts`.
