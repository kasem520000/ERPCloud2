# Decisions

Status: **Proposed** (awaiting review) unless marked otherwise.

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D-01 | Build the new product inside the existing monorepo and share `apps/api` | Tenancy, auth, posting, the stock ledger and ZATCA already exist and are tested; a split would duplicate the ledgers | Proposed |
| D-02 | One PostgreSQL database and one tenant model. Products are separated by entitlement, not by schema or database | The RLS model fails closed and is tested; shared entities stay single-source | Proposed |
| D-03 | Exactly one writer each for journals (`PostingService`) and for stock (`InventoryLedgerService`) | Brief requirement; current code already converges on this | Proposed |
| D-04 | Field-sales app is a PWA first (IndexedDB + service worker) in `apps/field-sales`. Revisit native (Expo) if device APIs (printing, background sync) prove insufficient | Reuses the React / contracts / ui stack; the sync protocol is client-agnostic | Proposed — needs product input |
| D-05 | Devices send idempotent **commands**; the server is authoritative and rejects instead of auto-correcting | Protects custody and ledger integrity under offline concurrency | Proposed |
| D-06 | Historical migrations are immutable; all fixes are forward migrations `0128+` with down files | Safety requirement | Accepted (from brief) |
| D-07 | Vertical modules (tailoring, optics, marina, salla) are out of scope and must not block, but their RLS gaps must be closed because they share the DB | Isolation is global | Proposed |
