-- =============================================================================
-- 0001_platform_services.sql — PHASE_04 Platform Services
-- =============================================================================
-- Implements DATABASE_DESIGN §4 (audit_log, files, notifications, outbox_jobs,
-- idempotency_keys) and the `document_sequences` table of §3, plus the RLS policies
-- of MULTI_TENANCY §3 and the append-only hardening of SECURITY_ARCHITECTURE §9.
--
-- IDEMPOTENT: every statement is guarded (`IF NOT EXISTS`, `DROP ... IF EXISTS`,
-- `DO $$ ... $$`), so the file can be applied repeatedly. Reversible: see
-- `migrations/down/0001_platform_services.down.sql`.
--
-- Primary keys are UUID v7 generated application-side (PROJECT_CONTRACT §2).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. audit_log — append-only (DATABASE_DESIGN §4)
--    tenant_id is NULLABLE on purpose: platform-plane events (a login that never
--    reached a tenant) must still be recorded. The RLS policy below makes those rows
--    write-only for the API role.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id             uuid PRIMARY KEY,
  tenant_id      uuid        REFERENCES tenants (id) ON DELETE CASCADE,
  actor_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
  actor_label    text,
  action         text        NOT NULL,
  entity         text        NOT NULL,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  meta           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_entity_idx     ON audit_log (tenant_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_at_idx ON audit_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS audit_log_tenant_actor_idx      ON audit_log (tenant_id, actor_user_id);

-- -----------------------------------------------------------------------------
-- 2. files — object-storage metadata (DATABASE_DESIGN §4)
--    `status` tracks the presign → upload → finalize lifecycle (CR-004).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id            uuid PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  bucket        text        NOT NULL,
  object_key    text        NOT NULL,
  name          text        NOT NULL,
  mime          text        NOT NULL,
  size_bytes    bigint      NOT NULL,
  checksum      text,
  status        text        NOT NULL DEFAULT 'pending',
  entity        text,
  entity_id     uuid,
  uploaded_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz,
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  CONSTRAINT files_status_check     CHECK (status IN ('pending', 'ready', 'deleted')),
  CONSTRAINT files_size_bytes_check CHECK (size_bytes > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS files_bucket_object_key_key      ON files (bucket, object_key);
CREATE INDEX IF NOT EXISTS files_tenant_entity_idx                 ON files (tenant_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS files_tenant_status_created_at_idx      ON files (tenant_id, status, created_at);

-- -----------------------------------------------------------------------------
-- 3. notifications — in-app inbox per membership (DATABASE_DESIGN §4)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id             uuid PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  membership_id  uuid        NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  type           text        NOT NULL,
  payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_tenant_membership_idx
  ON notifications (tenant_id, membership_id, created_at);
CREATE INDEX IF NOT EXISTS notifications_tenant_unread_idx
  ON notifications (tenant_id, membership_id) WHERE read_at IS NULL;

-- -----------------------------------------------------------------------------
-- 4. outbox_jobs — transactional handoff to BullMQ (DATABASE_DESIGN §4)
--    A business transaction writes the row; the publisher drains it to Redis.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_jobs (
  id            uuid PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  queue         text        NOT NULL,
  type          text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status        text        NOT NULL DEFAULT 'pending',
  attempts      integer     NOT NULL DEFAULT 0,
  run_at        timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  CONSTRAINT outbox_jobs_status_check CHECK (status IN ('pending', 'published', 'dead')),
  CONSTRAINT outbox_jobs_queue_check  CHECK (queue IN ('einvoice', 'notifications', 'reports-export', 'migration', 'maintenance'))
);

CREATE INDEX IF NOT EXISTS outbox_jobs_status_run_at_idx      ON outbox_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS outbox_jobs_tenant_created_at_idx  ON outbox_jobs (tenant_id, created_at);

-- -----------------------------------------------------------------------------
-- 5. idempotency_keys — replaces the PHASE_02 in-memory map (DATABASE_DESIGN §4)
--    `request_hash` turns "same key, different payload" into a 409 instead of a
--    silently wrong replay.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key           text        NOT NULL,
  endpoint      text        NOT NULL,
  request_hash  text        NOT NULL,
  status_code   integer,
  -- text, not jsonb: the replay must be byte-identical (API_CONTRACT §0) and jsonb
  -- normalises key order.
  response      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- -----------------------------------------------------------------------------
-- 6. document_sequences — transactional numbering (DATABASE_DESIGN §3, BL-1)
--    The scope is (tenant, branch, doc_type, fiscal_year) with NULL meaning "not
--    scoped by that dimension". SQL uniqueness ignores NULLs, so the unique index is
--    built over COALESCE expressions and the allocation statement targets exactly
--    those expressions as its ON CONFLICT arbiter.
--    branch_id/fiscal_year_id carry no FK yet: `branches` (PHASE_05) and
--    `fiscal_years` (PHASE_08) do not exist; their phases add the constraints.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_sequences (
  id              uuid PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id       uuid,
  doc_type        text        NOT NULL,
  fiscal_year_id  uuid,
  prefix          text        NOT NULL DEFAULT '',
  current_value   bigint      NOT NULL DEFAULT 0,
  padding         integer     NOT NULL DEFAULT 6,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  CONSTRAINT document_sequences_padding_check CHECK (padding BETWEEN 1 AND 18),
  CONSTRAINT document_sequences_value_check   CHECK (current_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS document_sequences_scope_key
  ON document_sequences (
    tenant_id,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    doc_type,
    coalesce(fiscal_year_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS document_sequences_tenant_doc_type_idx
  ON document_sequences (tenant_id, doc_type);

-- =============================================================================
-- Row-Level Security (MULTI_TENANCY §3.5) — every table above is tenant-scoped.
-- =============================================================================

ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log          FORCE  ROW LEVEL SECURITY;
ALTER TABLE files              ENABLE ROW LEVEL SECURITY;
ALTER TABLE files              FORCE  ROW LEVEL SECURITY;
ALTER TABLE notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications      FORCE  ROW LEVEL SECURITY;
ALTER TABLE outbox_jobs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_jobs        FORCE  ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys   ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys   FORCE  ROW LEVEL SECURITY;
ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sequences FORCE  ROW LEVEL SECURITY;

-- audit_log: reads are tenant-scoped; writes additionally accept the NULL-tenant
-- platform rows, which no tenant session can ever read back.
DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON notifications;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON outbox_jobs;
CREATE POLICY tenant_isolation ON outbox_jobs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON idempotency_keys;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON document_sequences;
CREATE POLICY tenant_isolation ON document_sequences
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- =============================================================================
-- Privileges. The tables created above inherit the default privileges granted in
-- 0000_platform_identity.sql only when the same role creates them, so the grants are
-- restated explicitly and the audit-log hardening is applied afterwards.
-- SECURITY_ARCHITECTURE §9: "audit log access restricted, immutable (no update/delete
-- grants)". Enforced with privileges, not a trigger: even a SQL injection through the
-- API role cannot rewrite history.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  audit_log, files, notifications, outbox_jobs, idempotency_keys, document_sequences
  TO erp_api;
GRANT ALL PRIVILEGES ON
  audit_log, files, notifications, outbox_jobs, idempotency_keys, document_sequences
  TO erp_migrator;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM erp_api;

-- PROJECT_CONTRACT §13.4 — re-asserted on every migration run.
ALTER ROLE erp_api NOBYPASSRLS;
