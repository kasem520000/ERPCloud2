# Target Architecture

## 1. Recommendation

**Use the same monorepo and the same API.** Add two new frontends. Do not start a separate platform.

Justification: the hard parts are already present, tested, and single-writer:
- tenancy and RLS
- auth
- journal immutability and reversal
- an append-only stock ledger
- ZATCA

A separate platform would mean either duplicating these or calling across services into the same ledger. That is the "second accounting engine" the brief forbids.

```
apps/
  api/                  existing NestJS API (the only backend)
  accounting/           NEW  Next.js accounting app (desktop-first)
  field-sales/          NEW  offline-first representative app (PWA first; see D-04)
  platform-admin/       existing, extended with product entitlements
  staff/ ...            existing ERP UI, kept for current tenants
packages/
  contracts/            shared zod contracts, extended with sync command schemas
  database/             single schema + migrations (0128+)
  domain/               NEW  pure, DB-free domain rules (money, tax calc, costing math)
  sync-client/          NEW  device-side command queue + delta store, used by field-sales
  ui/                   shared components
```

## 2. API structure

Authoritative domain services. Every app calls the same services through HTTP controllers:

| Service | Owner module | Writes |
|---|---|---|
| `PostingService` (extracted from `accounting.service.ts`) | `accounting` | `journal_entries`, `journal_entry_lines` — **only writer** |
| `InventoryLedgerService` (existing `inventory.service.ts` core) | `inventory` | `inventory_transactions`, `stock_balances` — **only writer** |
| `SalesInvoiceService` (`sales.service.ts` `createInTx` / `postInTx`) | `sales` | invoices; calls Inventory + Posting + Tax in one tx |
| `TaxService` / ZATCA | `einvoicing` | e-invoice submissions and chain |
| `CustodyService`, `RouteService`, `SettlementService` (split from van-sales) | `field-sales` | custody docs. Stock and journals go through the services above |
| `SyncService` | `field-sales/sync` | device command ledger. It replays commands into the services above |

Rules:
- One DB transaction per business command. Downstream services expose `*InTx(tx, ...)` variants, and controllers open `withTenantTx` once.
- Every mutating endpoint requires an idempotency key. Device commands carry `(device_id, command_seq, idempotency_key)`.
- Concurrency uses row locks (`FOR UPDATE`) on balances and documents, the pattern van-sales already uses. Optimistic `version` columns protect user edits.
- New controllers live under `/accounting/*` and `/field-sales/*`. Both are guarded by `ProductEntitlementGuard` + `PermissionsGuard` + `BranchScopeGuard`.

## 3. Offline-first field sales

- The device holds a read-only cache of customers, items, prices, its own van stock and open invoices, pulled as deltas by `updated_at` / version cursor.
- The device writes **commands**, not ledger rows: `CreateSale`, `RecordCollection`, `RecordReturn`, `RequestLoad`, `CloseDay`.
- Commands get pre-allocated document numbers from a per-device reserved range (`document_sequences`). The server validates each command and posts through the authoritative services.
- Conflicts:
  - Insufficient custody stock or a stale price → the server rejects the command with a typed reason, and the device shows it in a resolution queue.
  - The server never "fixes" a command silently.
- ZATCA simplified invoices are generated (QR) on the device at sale time and reported by the server within the regulatory window [A: confirm the current ZATCA rule for offline simplified invoices].

## 4. Data flow: van sale

```
device CreateSale(cmd) -> /field-sales/sync/push
  withTenantTx:
    idempotency check (device_id, seq, key)
    SalesInvoiceService.createInTx + postInTx
      -> InventoryLedgerService (issue from van warehouse, WAC)
      -> PostingService.postJournalInTx (AR/cash, revenue, VAT, COGS, inventory)
      -> TaxService (invoice hash chain, QR)
    record command result
  commit
```
