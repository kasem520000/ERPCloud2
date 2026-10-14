# Migration API

Phase 15 exposes the tenant-controlled run-management surface for the SQL Server to
PostgreSQL migration engine:

- `POST /migration/runs` starts `analyze`, `dry_run`, `import`, `reconcile`, or `rollback`.
- `GET /migration/runs` and `GET /migration/runs/:id` read run state.
- `GET /migration/runs/:id/issues` returns deduplicated blocker/warn/info rows.
- `GET /migration/runs/:id/reconciliation` returns the R1-R7 report payload.

The API role remains tenant-scoped by RLS. The separate `apps/migrator` worker is the only
component intended to run with a migration writer role during controlled cutover windows.
