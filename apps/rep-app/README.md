# apps/rep-app — تطبيق المندوب (the rep app)

M5 — the van-sales rep's **offline-first PWA** (D-006): selling, collecting, returning
and closing the route from the phone, with the M4 `field-sync` engines as the ONLY
write path. The app installs on the rep's phone (service worker + manifest), works with
no connectivity, and replays every queued document through the same validation the
back office runs.

## The offline model

* **Snapshot → IndexedDB.** `GET /field-sync/snapshot` (M4) is stored verbatim in
  `erpcloud-rep-offline` (native IndexedDB, no Dexie — the web-core arrangement,
  rep-shaped). The watermark + rep card live in the `meta` store.
* **Delta refresh.** `GET /field-sync/delta?since=<watermark>` upserts `changed` rows,
  removes `deleted` keys and re-reads the `full` collections — exactly the contract's
  framing. A rejected `since` falls back to a full snapshot.
* **Writes are queued rows.** Every screen writes a `RepQueueRecord` with the EXACT
  replay payload (`offlineId`, `deviceId`, `sequenceNo`, `operation`, `payload` —
  `tests/offline.spec.ts` pins them against the M4 wire shapes). Nothing posts
  directly except closing (below).
* **Auto-sync.** On mount, on `online`, and every 10s: pull, then `POST
  /field-sync/replay` (batches ≤ 100). Results merge back: `synced` records keep their
  server ids/numbers; `conflict` records keep `errorCode`/`message`/`resolution` and
  return to `pending` only by the rep's explicit retry.
* **Honest projections.** The stock/load-order screens show the snapshot numbers PLUS
  this phone's pending ops (an unsynced sale already reduces what the rep believes he
  has; a conflicted op moves nothing — it did not happen). Offline totals are labelled
  تقديري: the server computes the document money.

## Screens

| Route | What it does |
| --- | --- |
| `/` | Today: pending/conflict counts, van balance, quick actions |
| `/customers` | The customer list with THEIR prices (locked price, bonus caps, credit) |
| `/stock` | Van stock (snapshot + projected) and open load orders + **receipt confirmation** |
| `/invoice` | The van sale: order → customer/cash → qty + bonus (caps shown) → price (locked when the row says so) |
| `/receipt` | Collection on a server document OR on this device's own offline invoice (`sourceOfflineId`) |
| `/return` | Return against a document or this device's invoice |
| `/closing` | **Online-only** route close: counted-vs-expected side by side, explicit shortage acknowledgment (D-008) |
| `/sync` | Device state, delta pull, full snapshot re-pull |
| `/queue` | The device queue + conflict inbox (with the server's resolution hints) + server sync log |

## The closing rule (D-008)

Closing never goes through the offline queue and never settles silently. The screen
shows the server's expected remaining next to the rep's physical count; the difference
is the shortage; the submit button stays disabled until the rep acknowledges that the
difference goes to the accountant for the shortage decision
(`pending_policy_approval` upstream). Surplus is equally explicit — it is recorded by
the accountant's acknowledgment, never pocketed.

## Non-rep accounts

The gate probes the cheapest guard-gated route (`GET /field-sync/queue`): a definitive
403 (no salesman card / inactive / no van warehouse — D-004) shows an explanatory
screen; a network error fails OPEN (offline reps must reach their cached data).

## Running

```bash
pnpm --dir apps/rep-app dev      # REP_APP_PORT (default 3006), /api/v1 proxied to the API
pnpm --dir apps/rep-app test     # acceptance + invariant specs (fake-indexeddb + happy-dom)
```
