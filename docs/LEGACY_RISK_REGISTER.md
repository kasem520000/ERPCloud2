# Legacy Risk Register

Severity: **H**igh / **M**edium / **L**ow. Status: **Open** unless noted. "Blocks" means the risk must be resolved before that roadmap phase.

| ID | Risk | Evidence | Sev | Blocks | Recommended action |
|---|---|---|---|---|---|
| R-01 | 16 tenant tables have no detected RLS (`tailoring_*`, `salary_payments`, `salary_adjustment_types`, `employee_branches`, `optics_field_labels`, `refresh_tokens`, `backup_jobs`) | Static scan of migrations | H | P1 | Verify on a migrated DB through `pg_class`. Forward migration `0128` to enable + force RLS, or document why a table is control-plane |
| R-02 | Up to 18 RLS tables may lack FORCE | Static scan (over-reported; `0002` lines 339–348 do force 5 of them) | M | P1 | Same catalog verification; force where missing |
| R-03 | Bare-`id` FKs let a tenant reference another tenant's row if a service skips validation (FKs ignore RLS) | `journal_entry_lines.account_id → accounts(id)` etc. | M | P2 | Composite `(tenant_id, id)` FKs on new tables. Negative cross-tenant tests for posting inputs |
| R-04 | Journal balance is enforced only in application code | No balance trigger found in migrations [A] | M | P2 | Deferred constraint trigger asserting Σdebit = Σcredit per posted entry (new migration) |
| R-05 | Van-sales keeps its own stock-movement table beside `inventory_transactions`; drift between them is unproven | `van-sales.service.ts` move inserts with `load-move:` / `prod-move:` keys | H | P3 | Reconciliation test: van movements ≡ ledger per (item, van warehouse). Make one of them a pure projection |
| R-06 | Van-sales is a 6,925-line raw-SQL service | `wc -l` | M | P3 | Split into services with `*InTx` APIs. Keep it covered by the existing van-sales tests while refactoring |
| R-07 | Some callers post journals in a separate transaction from their business write | `hrm.service.ts` `postAdjustmentEntry` → `accounting.postJournal` | M | P2 (pattern) | Ban `postJournal` from domain services through a lint rule; use `postJournalInTx` |
| R-08 | `stock_balances` is a mutable projection with no rebuild check | `inventory.service.ts` updates in place | M | P2 | Nightly / CI reconciliation of projection vs ledger |
| R-09 | No offline sync API exists; rep devices would need direct REST writes | grep on the van-sales controller | H | P4 | Build `SyncService` + command ledger (new) |
| R-10 | Workspace packages must be built before tests resolve; a clean CI may produce false failures | `rls.spec` failed until `pnpm --filter "./packages/*" run build` | L | P0 | Make the root test script build first, or point the vitest alias at `src` |
| R-11 | `rlsProtectedTables` constant is stale and could mislead reviewers | `rls.ts` | L | P0 | Replace with a catalog query test |
| R-12 | Large parts of the suite were not executed in this assessment (≈1,441 `it(` in `apps/api/test`; only 4 files run) | This report | M | P0 | Run the full `pnpm test` + `typecheck` + `lint` in CI and record results in PROGRESS.md |
| R-13 | Existing docs (`VAN_SALES_*`, `PROJECT_AUDIT_*`) make claims not re-verified here | — | L | — | Treat them as unverified; cite them only after verification |
| R-14 | ZATCA offline simplified-invoice reporting window for rep devices is not designed | — | M | P4 | Confirm the regulation; design server-side reporting from synced commands |
| R-15 | Legacy data migrations (`apps/migrator`, `modules/migration`, `compat`) target the desktop product shape | Paths | L | P5 | Reference only. New-product onboarding imports go through the domain services |
