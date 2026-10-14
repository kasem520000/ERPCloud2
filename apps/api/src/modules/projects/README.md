# Projects and contracting pack (Phase 21)

Feature flag: `tenant_settings.pack.projects`. Disabled tenants receive `404` for `/projects/*`.

Endpoints cover project creation, stage templates, per-user stage accreditation, BOQ maintenance, progress bill calculation/posting, retention release and lightweight requirements. Progress bills compute work value, previous/cumulative values, retention and net due from BOQ terms. Posting creates a normal sale invoice through the zero-inventory/service path and can also post accounting lines if the caller supplies account ids/fiscal period.

## Contracting (`/contracting/*`, migration 0026)

The subcontractor side of the same pack, behind the same feature flag:

* `GET|POST /contracting/contracts`, `GET /contracting/contracts/:id`, and
  `POST .../activate|close|cancel` — عقد مقاول. The contract value is the sum of its
  lines; retention percentage and the agreed advance live on the header because both are
  applied across many certificates.
* `POST /contracting/contracts/:id/payments`, `GET /contracting/payments`, and
  `POST /contracting/payments/:id/approve|pay|cancel` — سند دفع لمقاول. The server
  computes retention (`gross × contract.retention_pct`) and validates advance recovery
  against the outstanding advance; `net = gross − retention − recovery`. Cumulative gross
  on `progress`/`final` certificates cannot exceed the contract value. `pay` creates a
  **draft** supplier payment voucher via `TreasuryService` and links it (`voucher_id`);
  posting it to the ledger remains a treasury action.
* `GET|POST /contracting/offers` and `POST /contracting/offers/:id/send|accept|reject|convert`
  — عروض المشاريع. Conversion creates the project and copies the offer lines into the BOQ.

Permissions: `projects.view` to read, `projects.manage` to write, and
`projects.contractor.pay` to approve or pay a certificate.
