-- 0128_field_sync_queue.sql
--
-- M4 — rep backend (field-sync): the server-side ledger for offline-first field sales.
--
-- The rep app's IndexedDB is the working queue, exactly like offline POS (0102). This table
-- is deliberately NOT a second document store: it records the original offline payload, the
-- replay identity (device + per-device sequence + client offlineId), the operation kind and
-- the outcome returned by the canonical engines (`sales.postInTx` / treasury vouchers via
-- the van-sales sagas). Differences from `offline_queue` are the ones the field flow needs:
--
--   * `salesman_id` — the rep whose custody the row belongs to. Every route resolves the
--     rep from the caller's membership (D-004), and the queue keeps that fact so the
--     conflict inbox and the device binding are auditable after the fact.
--   * `operation` — 'invoice' | 'collection' | 'return' | 'receipt' — the replay is a
--     mixed batch, unlike POS's cash-only single kind.
--   * `result` — the engine outcome snapshot (document id/number, voucher number) kept
--     next to the error columns, so a synced row answers "what did it become?" without
--     re-deriving anything.
--
-- Rules honoured: additive only, idempotent (`IF NOT EXISTS` guards), FKs `ON DELETE SET
-- NULL` except the tenant cascade, RLS with the canonical tenant-isolation policy, no data
-- changes (new table, zero rows).

CREATE TABLE IF NOT EXISTS field_sync_queue (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id       text NOT NULL,
  salesman_id     uuid REFERENCES salesmen(id) ON DELETE SET NULL,
  offline_id      text NOT NULL,
  sequence_no     integer NOT NULL,
  operation       text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  payload         jsonb NOT NULL,
  result          jsonb,
  document_id     uuid REFERENCES van_sales_documents(id) ON DELETE SET NULL,
  error_code      text,
  error_detail    text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  synced_at       timestamptz,
  CONSTRAINT field_sync_queue_status_check CHECK (status IN ('pending', 'synced', 'conflict')),
  CONSTRAINT field_sync_queue_sequence_check CHECK (sequence_no > 0),
  CONSTRAINT field_sync_queue_device_check CHECK (char_length(device_id) BETWEEN 1 AND 128),
  CONSTRAINT field_sync_queue_offline_id_check CHECK (char_length(offline_id) BETWEEN 1 AND 160),
  CONSTRAINT field_sync_queue_operation_check
    CHECK (operation IN ('invoice', 'collection', 'return', 'receipt'))
);

-- Replay identity: one offlineId per tenant, one monotonic sequence per (tenant, device).
CREATE UNIQUE INDEX IF NOT EXISTS field_sync_queue_tenant_offline_id_key
  ON field_sync_queue(tenant_id, offline_id);
CREATE UNIQUE INDEX IF NOT EXISTS field_sync_queue_tenant_device_sequence_key
  ON field_sync_queue(tenant_id, device_id, sequence_no);
CREATE INDEX IF NOT EXISTS field_sync_queue_tenant_status_idx
  ON field_sync_queue(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS field_sync_queue_tenant_device_idx
  ON field_sync_queue(tenant_id, device_id, sequence_no);
CREATE INDEX IF NOT EXISTS field_sync_queue_salesman_idx
  ON field_sync_queue(tenant_id, salesman_id, created_at DESC);

ALTER TABLE field_sync_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_sync_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_sync_queue_tenant_isolation ON field_sync_queue;
CREATE POLICY field_sync_queue_tenant_isolation ON field_sync_queue
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON field_sync_queue TO erp_api;
GRANT ALL PRIVILEGES ON field_sync_queue TO erp_migrator;

COMMENT ON TABLE field_sync_queue IS
  'M4 field-sync: replay-safe server ledger and conflict inbox for offline rep documents';
COMMENT ON COLUMN field_sync_queue.offline_id IS
  'Client-generated identifier, unique within the tenant and safe to replay';
COMMENT ON COLUMN field_sync_queue.sequence_no IS
  'Monotonic per-device sequence; gaps are allowed, replays and older numbers are not';
COMMENT ON COLUMN field_sync_queue.operation IS
  'invoice = van sale document, collection = customer debt receipt, return = customer return, receipt = load-order receipt confirmation';
COMMENT ON COLUMN field_sync_queue.payload IS
  'Original offline payload exactly as the device sent it, retained for conflict resolution';
COMMENT ON COLUMN field_sync_queue.result IS
  'Engine outcome snapshot (document/voucher ids and numbers) for synced rows';
COMMENT ON COLUMN field_sync_queue.salesman_id IS
  'The rep whose membership replayed the row — derived, never taken from the payload (D-004)';
