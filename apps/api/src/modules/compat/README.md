# Legacy desktop compatibility gateway

Phase 16 exposes a narrow API bridge for the existing desktop client. The desktop never
connects to PostgreSQL or the legacy SQL Server through the cloud: it authenticates as a
registered compat device and exchanges only documented master-data pulls and document
pushes.

Device keys are SHA-256 hashed with a deployment pepper. Pull cursors are per device and
use `updated_at + id` watermarks to avoid duplicates across equal timestamps. Document
pushes use `Idempotency-Key` when present, otherwise the legacy `GlobalID`.
