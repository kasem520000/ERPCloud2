-- 0115_compat_sessions.sql
-- AUD-09 — جلسات gateway التوافق كانت في `Map` داخل العملية (`compat.service.ts`):
-- تختفي بإعادة التشغيل، ولا يراها replica آخر، ولا يمكن إبطالها على مستوى المخزن.
-- الجلسة الآن صفٌّ في القاعدة، والمخزَّن **بصمة** الرمز لا الرمز نفسه.
--
-- معدّل الطلبات يستعمل العمودين القائمين `rate_window_started_at`/`rate_window_count`
-- على `compat_devices` (0014) — العدّ داخل صفّ الجهاز نفسه يتسلسل مع كل طلب، فيعمل
-- الحدّ عبر replicas بلا حالةٍ محلية إضافية.

CREATE TABLE IF NOT EXISTS compat_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES compat_devices(id) ON DELETE CASCADE,
  /** SHA-256 للرمز عالي العشوائية (256-bit) — لا يُخزَّن الرمز نفسه ولا يُسجَّل. */
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS compat_sessions_token_key ON compat_sessions(token_hash);
CREATE INDEX IF NOT EXISTS compat_sessions_device_idx ON compat_sessions(tenant_id, device_id);
CREATE INDEX IF NOT EXISTS compat_sessions_expiry_idx ON compat_sessions(expires_at);

ALTER TABLE compat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compat_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compat_sessions_tenant_isolation ON compat_sessions;
CREATE POLICY compat_sessions_tenant_isolation ON compat_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON compat_sessions TO erp_api;
GRANT ALL PRIVILEGES ON compat_sessions TO erp_migrator;
