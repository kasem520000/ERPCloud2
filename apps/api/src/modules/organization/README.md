# Organization module (PHASE_05)

Company profile, branches, warehouses, cash locations, currencies & FX, price lists and
branch posting profiles — the org skeleton every later module hangs off.

Sources of truth: `docs/DATABASE_DESIGN.md §5` (+ §3 for currencies/FX),
`docs/API_CONTRACT.md §3`, `docs/DOMAIN_MODEL.md §1–§3`, `docs/MULTI_TENANCY.md §2–§3`.

```
organization/
├── shared/org-support.ts        version/default-flag/branch-scope helpers
├── branches/                    branches CRUD  (legacy `Branches`)
├── warehouses/                  warehouses CRUD (legacy `Stocks`)
├── cash-locations/              safes + banks + balances (legacy `Safes`/`Banks`)
├── currencies/                  currencies, fx rates, `resolveFx`
├── price-lists/                 price lists + items (legacy `priceTypes`/`Pricing`)
├── posting-profiles/            `PostProfileV1` mappings + `resolvePostProfile`
├── company-profile/             1:1 tenant profile + logo (legacy `Foundation`)
└── provisioning/                `provisionOrgDefaults(tenantId)`
```

## Posting-profile resolution

`resolvePostProfile(tenantId, branchId, docType)` replaces the legacy pair of account
mappings — the global `SettingGeneral.*Acc` columns and the per-branch `Branches.*Acc`
overrides — with one JSONB document per `(branch, doc_type)`. Rows are matched in a fixed
order and the **first** match wins:

| # | `branch_id` | `doc_type` | Legacy equivalent |
|---|---|---|---|
| 1 | the requested branch | the requested doc type | `Branches.*Acc` for one document kind |
| 2 | the requested branch | `'*'` | `Branches.*Acc` |
| 3 | `NULL` (tenant default) | the requested doc type | — |
| 4 | `NULL` (tenant default) | `'*'` | `SettingGeneral.*Acc` |

No match is a **hard failure**: `422 ACCOUNT_PROFILE_MISSING`. A posting engine must never
fall back to a guessed account, because a wrong account produces a plausible-looking
journal entry that nobody notices until the trial balance is closed.

The stored document is validated against `postProfileV1Schema` on write *and* on read; a
row whose JSON no longer parses is reported rather than partially applied. `version: 1` is
a literal discriminator, so a future `PostProfileV2` is a reader switch, not a migration.

Account ids inside a mapping are plain uuids until PHASE_07 introduces `accounts`
(`ValidatedAtRuntime: P07`, CR-006). `POST_PROFILE_ACCOUNT_KEYS` in `@erp/contracts` is
the list PHASE_07 iterates when it adds the "exists and is postable" check.

## FX resolution

`resolveFx(tenantId, from, to, date?)` answers with a rate **and** the rung it came from,
because `1.0000` from an identity and `1.0000` from a stale table mean different things:

1. `identity` — same currency, rate `1`, no table read.
2. `direct` — newest `fx_rates` row for `from→to` with `effective_from <= date`.
3. `inverse` — `1 / rate` of the newest `to→from` row.
4. `triangulated` — `from→base × base→to`, each leg direct or inverse, `via` naming the
   pivot and `effectiveFrom` reporting the **staler** of the two legs.

Nothing else is invented: an unreachable pair is `422 VALIDATION_FAILED`. All arithmetic
runs through decimal.js (`FX_SCALE = 10`, `ROUND_HALF_UP`); intermediate legs keep full
precision and only the answer is rounded, so a triangulated rate never rounds twice.

## Invariants the services maintain

- **One default per tenant** — branch, warehouse, price list; **one per kind** for cash
  locations (a default safe *and* a default bank); **one base currency**. Enforced by
  partial unique indexes (`… WHERE is_default AND deleted_at IS NULL`) and serialised by
  a transaction-scoped advisory lock, so a burst of concurrent promotions queues instead
  of failing.
- The **first** row a tenant creates becomes the default. Clearing the flag is a 422:
  promote another row instead. Deactivating or deleting the default is a 422.
- **Codes are unique per tenant among live rows** (`… WHERE deleted_at IS NULL`), so a
  soft-deleted `MAIN` frees its code.
- **DELETE is a soft delete** on master data (CR-008); `fx_rates`, `price_list_items` and
  `branch_posting_profiles` have no soft-delete columns and are removed for real — a
  lingering "deleted" mapping that still resolved would be worse than none.
- **Branch scope** (`MULTI_TENANCY §2`) narrows every list and detail read. A row outside
  the membership's `branch_scope` is reported as **404, never 403**: the caller must not
  learn that a branch it cannot see exists.
- **Optimistic concurrency** — every PATCH/PUT accepts an optional `version`; a stale one
  is `409 VERSION_CONFLICT` rather than a silent overwrite.

## Sensitive data and audit

Bank details live in `cash_locations.bank`. The IBAN is **masked in list responses** and
returned in full only on the single-row read (`SECURITY_ARCHITECTURE §5`) — and it is
masked in the audit row too, because an audit log is read by more people than the record
it describes.

Cash locations, posting profiles and the company profile write their audit rows
themselves, inside the same transaction as the change, with a real `before`/`after`, and
call `markRequestAudited()` so the global interceptor produces no second row.

## Provisioning

`OrgProvisioningService.provisionOrgDefaults(tenantId, options?)` gives a bare tenant the
minimum it needs to record a document: the base currency as a real `currencies` row, a
`MAIN` branch, a warehouse, a safe with a zero balance row, and a default price list. It
is **idempotent** — every step is skipped when its row exists — and `provisionInTx` lets a
caller fold it into its own transaction. It writes through the tables rather than the CRUD
services because it runs outside any HTTP request: no branch scope, no actor, no
interceptor to satisfy.

## Depends on / used by

- **Uses**: `SequencesService` for any numbering (never `max()+1`), `AuditService`,
  `FileAttachmentRegistry` (the `company_profile` logo is its first registered entity),
  `withTenantTx` for the RLS GUC.
- **Used by**: PHASE_06 (`price_list_items.item_id` FK), PHASE_07 (account FKs + posting
  profile validation), PHASE_08+ (`resolvePostProfile`), PHASE_12 (cash balances writer),
  PHASE_15 (migrator calls `provisionOrgDefaults` with the legacy branch code).
