-- 0102 — tenant-scoped offline POS idempotency and conflict ledger (PHASE_06)
--
-- The browser's IndexedDB is the working queue. This table is deliberately not a second
-- invoice store: it records the original payload, replay identity and the outcome returned
-- by the canonical POS checkout path.

CREATE TABLE IF NOT EXISTS offline_queue (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id       text NOT NULL,
  offline_id      text NOT NULL,
  sequence_no     integer NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  payload         jsonb NOT NULL,
  invoice_id      uuid REFERENCES sales_invoices(id) ON DELETE SET NULL,
  invoice_number  text,
  error_code      text,
  error_detail    text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  synced_at       timestamptz,
  CONSTRAINT offline_queue_status_check CHECK (status IN ('pending', 'synced', 'conflict')),
  CONSTRAINT offline_queue_sequence_check CHECK (sequence_no > 0),
  CONSTRAINT offline_queue_device_check CHECK (char_length(device_id) BETWEEN 1 AND 128),
  CONSTRAINT offline_queue_offline_id_check CHECK (char_length(offline_id) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS offline_queue_tenant_offline_id_key
  ON offline_queue(tenant_id, offline_id);
CREATE UNIQUE INDEX IF NOT EXISTS offline_queue_tenant_device_sequence_key
  ON offline_queue(tenant_id, device_id, sequence_no);
CREATE INDEX IF NOT EXISTS offline_queue_tenant_status_idx
  ON offline_queue(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS offline_queue_tenant_device_idx
  ON offline_queue(tenant_id, device_id, sequence_no);

ALTER TABLE offline_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offline_queue_tenant_isolation ON offline_queue;
CREATE POLICY offline_queue_tenant_isolation ON offline_queue
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON offline_queue TO erp_api;
GRANT ALL PRIVILEGES ON offline_queue TO erp_migrator;

COMMENT ON TABLE offline_queue IS
  'PHASE_06: replay-safe server ledger for cash-only offline POS invoices';
COMMENT ON COLUMN offline_queue.offline_id IS
  'Client-generated UUID/identifier; unique within a tenant and safe to replay';
COMMENT ON COLUMN offline_queue.sequence_no IS
  'Monotonic per-device sequence; gaps are allowed, replays and older numbers are not';
COMMENT ON COLUMN offline_queue.payload IS
  'Original validated POS checkout payload, retained for conflict resolution';
COMMENT ON COLUMN offline_queue.status IS
  'pending before processing, synced after canonical checkout, conflict when it cannot post';
