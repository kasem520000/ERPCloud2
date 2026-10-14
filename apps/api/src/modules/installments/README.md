# Installments pack (Phase 21)

Feature flag: `tenant_settings.pack.installments`. Disabled tenants receive `404` for `/installments/*`.

Endpoints:
- `GET /installments/contracts`
- `POST /installments/contracts`
- `GET /installments/contracts/:id`
- `GET /installments/overdue?asOf=YYYY-MM-DD`
- `POST /installments/contracts/:id/collect`

Contracts may reference a posted sales invoice or be standalone against a party and optional item. Schedules are generated as equal installments with `periodUnit = days | months` and rounding assigned to the last line. Collections create a receipt voucher and allocate the amount to the oldest unpaid schedule rows.
