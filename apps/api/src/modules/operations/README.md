# Operations — file-level actions (`/api/v1/settings/*`)

The five items under الإعدادات that act on the company file as a whole: backup, restore,
data rotation, invoice maintenance and creating a new file. They share one shape — a step
that only reports, and a step that acts and is recorded as a run with its actor.

Every route lives on `OperationsController` (`@Controller('settings')`) and is gated by a
permission of its own, so "can take a backup" and "can purge logs" are separate grants.

## النسخ الإحتياطي — `BackupService`

| Route | Permission | Notes |
|---|---|---|
| `GET /settings/backups` | `settings.backup.manage` | Catalogue only; payloads are never listed. |
| `POST /settings/backups` | `settings.backup.manage` | `{ note? }` → snapshot + checksum. |
| `GET /settings/backups/:id/download` | `settings.backup.manage` | The payload, one backup at a time. |

The table list is discovered from `information_schema` (every table with a `tenant_id`), so
a module added later is covered without touching this service. `NEVER_BACKED_UP` removes
the backups themselves, the operational logs and **all identity tables** — a tenant export
that carried `users`, `roles` or `role_permissions` would be a privilege-escalation vector
the moment it was restored somewhere else. The audit log is excluded for the same reason in
reverse: it exists to record what happened, and a restorable audit log records nothing.

`MAX_BACKUP_ROWS` (50 000) is a promise the service can keep. Beyond it the call fails with
`BACKUP_TOO_LARGE` and names `pg_dump`, because a silently truncated export is worse than
no export.

## إستعادة البيانات — `BackupService.restore`

`POST /settings/restores` with `{ backupId | payload, checksum?, mode, confirmTenantCode? }`.

* `dry_run` (default) counts what is in the snapshot against what is already in the file.
* `apply` inserts with `ON CONFLICT DO NOTHING`, forces `tenant_id` to the current file and
  requires `confirmTenantCode` to match the tenant's code (`RESTORE_CONFIRMATION_REQUIRED`).

Nothing is ever deleted or updated. Restoring a snapshot into the file it came from is a
no-op, which is the property that makes it safe to press twice. Foreign-key order is not
recorded in the snapshot, so failing tables are retried across up to four passes and any
still failing are reported per table rather than aborting the whole run.

## تدوير البيانات — `MaintenanceService.rotation`

`POST /settings/data-rotation` with `{ cutoffDate, mode, confirm? }`.

`ROTATABLE` is deliberately short: notifications, outbox jobs, idempotency keys. `PRESERVED`
lists the document tables and is counted **and shown** so an operator can see that invoices,
vouchers, journal entries and inventory movements are not part of this. The cutoff must be
at least 90 days old (`ROTATION_CUTOFF_TOO_RECENT`) and `apply` needs `confirm: true`
(`ROTATION_CONFIRMATION_REQUIRED`).

`audit_log` is absent because `0001_platform_services.sql` revokes `DELETE` on it from
`erp_api`. The preview reports it under `retainedByDesign` instead of quietly skipping it.

## صيانة الفواتير — `MaintenanceService.invoiceMaintenance`

`POST /settings/invoice-maintenance` with `{ mode, staleDraftDays? }`. Four findings:

1. `totalsMismatch` — header total vs the sum of its lines (0.005 tolerance).
2. `postedWithoutJournal` — posted invoices with no `journal_entries` row pointing at them.
3. `numberingGaps` — holes per `PREFIX-` series.
4. `staleDrafts` — drafts older than `staleDraftDays` (default 30).

`apply` recomputes `subtotal`, `tax_total` and `total` for **draft** invoices only. Posted
documents are reported and left alone: they have been printed, sent and possibly reported
to ZATCA, so the correction is a credit note. Each row carries `repairable`, which is
exactly `status === 'draft'`.

## إنشاء ملف — `CompanyFilesService`

`POST /settings/company-files` with `{ code, name, copy?: ('accounts'|'catalog'|'parties'|'structure')[] }`.

A new company file is a new tenant, provisioned through
`PlatformAdminService.provisionCompanyFile` — the same path as a self-service signup, so
the file starts **unlicensed** with a pending activation request. That is the guard that
keeps a tenant-level permission from minting licensed tenants.

The copy step carries master data only. Ids are rewritten through one map shared by all
tables: uuids are unique, so a value found in the map is by definition a reference to
something already copied, and a uuid that is *not* in the map is nulled rather than left
dangling into the source file. Self-referencing tables (accounts, cost centres, item
categories) are inserted parents-first. Documents, balances and users never cross.
