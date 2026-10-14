-- =============================================================================
-- 0001_platform_services.down.sql — reverse of 0001_platform_services.sql
-- =============================================================================
-- Applied by `pnpm db:migrate:down`. Drops the six PHASE_04 platform-service tables
-- together with their policies and privileges.
--
-- WARNING: destructive. `audit_log` is append-only *within* a schema version; a
-- deliberate operator rollback is the only way its rows are ever removed, and
-- SECURITY_ARCHITECTURE §10 (retention ≥ 7 years) means this script must never run
-- against an environment that holds real tenant history.
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON document_sequences;
DROP POLICY IF EXISTS tenant_isolation ON idempotency_keys;
DROP POLICY IF EXISTS tenant_isolation ON outbox_jobs;
DROP POLICY IF EXISTS tenant_isolation ON notifications;
DROP POLICY IF EXISTS tenant_isolation ON files;
DROP POLICY IF EXISTS tenant_isolation ON audit_log;

ALTER TABLE IF EXISTS document_sequences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS document_sequences DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS idempotency_keys   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS idempotency_keys   DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS outbox_jobs        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS outbox_jobs        DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notifications      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notifications      DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS files              NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS files              DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS audit_log          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS audit_log          DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS document_sequences;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS outbox_jobs;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS audit_log;
