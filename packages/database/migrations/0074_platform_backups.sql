-- P-C10 — البيانات والاسترجاع (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
--
-- جدولان للنسخ (كما نصّت الخطة: `backup_jobs` · `backup_artifacts`) وثالثٌ لطلبات
-- البيانات، وسببُ الثالث صريح: الخطة تسرد ضمن شاشات هذا الجزء «طلبات تصدير/حذف البيانات
-- الشخصية» ولم تُسمِّ لها جدولاً، وطلبُ محوٍ بلا صفٍّ يُسجّل من طلب ومتى ومن قرّر وكيف
-- انتهى = وعدٌ بلا إيصال. أمّا **موعد** الاحتفاظ فليس جدولاً: سياستها تُحفظ في
-- `platform_settings` تحت المفتاح `retention.policy` (وهو ما يجعلها قابلةً للقراءة في
-- شاشة الإعدادات نفسها، ولها أثرٌ في التدقيق).
--
-- وفصلُ `backup_jobs` عن `backup_artifacts` مقصود: **المحاولة** شيء و**الملف** شيء آخر.
-- محاولةٌ فشلت قبل أن تُكتب لها بايتات صفٌّ مشروع (`failed` بلا `artifact`)، وملفٌّ واحد
-- قد يُقرأ مرّاتٍ (تحقّق، تنزيل) فتتغيّر تواقيته بلا أن تتغيّر النسخة.

-- -----------------------------------------------------------------------------
-- 1. backup_artifacts — الملف كما استقرّ في مخزنه
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_artifacts (
  id            uuid PRIMARY KEY,
  kind          text        NOT NULL DEFAULT 'platform-dump'
                            CHECK (kind IN ('platform-dump', 'data-export')),
  -- أين استقرّ فعلاً: `object-storage` عبر منفذ S3/MinIO، أو `filesystem` حين لا اعتمادات.
  store         text        NOT NULL CHECK (store IN ('object-storage', 'filesystem')),
  object_key    text        NOT NULL,
  -- الترويسة التي تسبق البايتات المشفّرة (النسخة) — تُحفظ مع الصفّ ليُقرأ الملف بلا
  -- الرجوع إلى الشاشة، ويُقرأ بها التحقّق.
  format        text        NOT NULL DEFAULT 'erp-platform-dump/1',
  encryption    text        NOT NULL DEFAULT 'aes-256-gcm',
  iv            text,
  bytes         integer     NOT NULL CHECK (bytes > 0),
  -- بصمة **النصّ الصريح** لا المشفّر: هي ما يقارنه التحقّق، وهي ما يُثبت أنّ البايتات
  -- لم تتغيّر في المخزن.
  checksum      text        NOT NULL,
  tables        integer     NOT NULL DEFAULT 0 CHECK (tables >= 0),
  rows          integer     NOT NULL DEFAULT 0 CHECK (rows >= 0),
  -- الاحتفاظ: `pruned_at` يعني «حُذف الملف من المخزن» ولا يعني «حُذف الصفّ» — الإيصال يبقى.
  pruned_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS backup_artifacts_kind_created_idx
  ON backup_artifacts (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS backup_artifacts_prunable_idx
  ON backup_artifacts (created_at)
  WHERE pruned_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. backup_jobs — المحاولة: من طلبها، وبأيّ نطاق، وكيف انتهت
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_jobs (
  id              uuid PRIMARY KEY,
  scope           text        NOT NULL DEFAULT 'platform'
                              CHECK (scope IN ('platform', 'tenant')),
  -- NULL مع نطاق المنصّة، وإلزاميٌّ مع نطاق المستأجر (القيد أدناه).
  tenant_id       uuid        REFERENCES tenants (id) ON DELETE SET NULL,
  status          text        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'succeeded', 'failed')),
  artifact_id     uuid        REFERENCES backup_artifacts (id) ON DELETE SET NULL,
  note            text        CHECK (note IS NULL OR length(note) BETWEEN 3 AND 500),
  failure_reason  text,
  tables          integer     NOT NULL DEFAULT 0 CHECK (tables >= 0),
  rows            integer     NOT NULL DEFAULT 0 CHECK (rows >= 0),
  tenants         integer     NOT NULL DEFAULT 0 CHECK (tenants >= 0),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  verified_at     timestamptz,
  verified_checksum text,
  requested_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
  -- الاسم صريحٌ ومُطوَّل عمداً: `backup_jobs_scope_check` هو الاسم الذي تُولّده
  -- PostgreSQL تلقائياً لقيد العمود `scope` أعلاه، فتسميةُ هذا القيد به تُصطدم بها
  -- داخل نفس الأمر ("constraint already exists") — وهو خطأٌ وقعنا فيه مرّةً هنا.
  CONSTRAINT backup_jobs_tenant_scope_check CHECK (
    (scope = 'tenant') = (tenant_id IS NOT NULL)
  ),
  CONSTRAINT backup_jobs_finish_check CHECK (
    (status = 'running') = (finished_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS backup_jobs_started_idx ON backup_jobs (started_at DESC);
CREATE INDEX IF NOT EXISTS backup_jobs_tenant_idx ON backup_jobs (tenant_id, started_at DESC);

-- -----------------------------------------------------------------------------
-- 3. data_requests — طلب تصدير/محو بيانات شخصٍ بعينه
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_requests (
  id            uuid PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('export', 'erase')),
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'cancelled')),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- البريد كما طُلب. يبقى في الصفّ بعد التنفيذ عمداً: هو **الإيصال** — «أي بريدٍ مُحي؟»
  -- سؤالٌ يُسأل بعد المحو، ولا يُجاب من `users` وقد صار `erased+…@erased.invalid`.
  subject_email text        NOT NULL CHECK (length(subject_email) BETWEEN 3 AND 200),
  subject_user_id uuid      REFERENCES users (id) ON DELETE SET NULL,
  note          text        CHECK (note IS NULL OR length(note) BETWEEN 3 AND 500),
  decision_note text        CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 5 AND 500),
  decided_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
  decided_at    timestamptz,
  executed_at   timestamptz,
  result        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  requested_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  -- التنفيذ لا يسبق القرار، والقرار لا يسبق الطلب.
  CONSTRAINT data_requests_decision_check CHECK (
    (decided_at IS NULL) = (status IN ('pending', 'cancelled'))
  ),
  CONSTRAINT data_requests_execution_check CHECK (
    (executed_at IS NULL) OR (status = 'completed')
  )
);

CREATE INDEX IF NOT EXISTS data_requests_status_idx ON data_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS data_requests_tenant_idx ON data_requests (tenant_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. العزل والصيانة
-- -----------------------------------------------------------------------------
-- الجداول الثلاثة **صفوفُ منصّة**: لا `tenant_id` في `backup_*` أصلاً، و`data_requests`
-- يحمل `tenant_id` لكن قارئه مشغّل المنصّة وحده (سطح `/platform/*`). فلا تُبنى لها سياسة
-- عزلٍ مستأجري ولا تُمنح صلاحيات لـ`erp_api` — الدور يقرأ ويكتب ما مُنح له سابقاً في
-- `public` (GRANT عام في 0002)، والمنع يأتي من RLS على الجداول التي تحمله لا من هذه.
-- وهذا ترتيبٌ مقصود: `data_requests` بدون RLS مثل `tenants` و`users` — قراءةٌ محصورة
-- بالحارس `PlatformAdminGuard` على مستوى المسار.
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_admin_plane ON data_requests;
CREATE POLICY platform_admin_plane ON data_requests
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- `audit_log` يُقرأ في عدّ الاحتفاظ ولا يُمحى — يُعاد التأكيد على المنع (PROJECT_CONTRACT §13.4).
REVOKE UPDATE, DELETE ON audit_log FROM erp_api;

INSERT INTO permissions (code, module, description) VALUES
  ('console.backups.manage', 'console',
   'Run and verify platform backups, set the retention policy, and execute data export or erasure requests.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

ALTER ROLE erp_api NOBYPASSRLS;
