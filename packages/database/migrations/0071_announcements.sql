-- 0071_announcements.sql — P-C7 «الإعلانات والإشعارات».
--
-- الرقم صُحِّح: الخطة كتبت 0070 لهذا الجزء، وقد أخذه بريد P-C6 (وهو المسجَّل سلفاً في
-- جدول الترحيلات §6 للبريد)؛ فالإعلانات تأخذ التالي الحر 0071 كما في الجدول نفسه.
--
-- ما الذي يبنيه هذا الترحيل، ولماذا بهذا الشكل:
--
--   1. **`announcements` — منصةٌ فقط، بلا `tenant_id`.** الإعلان ليس بيانات عميل: هو مستند
--      المنصة إلى عملائها، فلا معنى لسياسة `tenant_isolation` عليه (ولا عمود لها). السياسة
--      الوحيدة `platform_admin_plane`، و`FORCE` لأن المالك أيضاً يجب أن يمرّ بها.
--      ولهذا لم يُمنح `erp_api` أي وصولٍ من جلسة المستأجر: RLS تمنعه بنيوياً لا بالأدب.
--   2. **استهدافٌ محفوظ لحظة النشر**: `audience` + `plan_code` + `tenant_status`. الجمهور
--      يُحلّ ويُكتب في `announcement_reads` عند النشر، فتغيير عميلٍ باقته غداً لا يعيد كتابة
--      تاريخ إعلانٍ أمس.
--   3. **`announcement_reads` — سجلّ التسليم والقراءة**, صفٌّ لكل (إعلان، عميل، قناة، عضو):
--      `notification_id` لقناة `in_app` و`email_message_id` لقناة `email`، و`read_at` يُوسم
--      عند قراءة الإشعار داخل التطبيق. فالسؤال «كم قرأ؟» له مصدرٌ واحد لا تقدير.
--   4. **الحالات ثلاث** (`draft` · `scheduled` · `published`): لا `canceled` لأن الخطة لم
--      تطلب الإلغاء، والمسودّة والمجدولة تُعدَّلان بحرّية — أمّا المنشور فلا (تعديل ما قيل
--      ليس تعديلاً بل تصحيحاً ببريدٍ ثانٍ).
--   5. **فهرسٌ واحد يمنع النشر المزدوج**: `published_at IS NOT NULL` مقترنٌ بحالة `published`
--      و`UNIQUE` على (announcement_id, tenant_id, membership_id, channel) في سجلّ التسليم —
--      فإعادة النشر (بسبب خطأ عرض أو سباق مهام) لا تُضاعف الإشعارات.
--
-- آمن للإعادة التشغيل: `IF NOT EXISTS` في كل عبارة، ولا شيء يُحذف.

-- =============================================================================
-- 1. announcements — مستند المنصة
-- =============================================================================

CREATE TABLE IF NOT EXISTS announcements (
  id            uuid PRIMARY KEY,
  title_ar      text NOT NULL,
  title_en      text NOT NULL,
  body_ar       text NOT NULL,
  body_en       text NOT NULL,
  audience      text NOT NULL DEFAULT 'all',
  -- كود الباقة المستهدَفة (لا معرّفها) لأن الكود هو ما يُقرأ في الشاشة والتقارير.
  plan_code     text,
  tenant_status text,
  -- القنوات المسموحة لهذا الإعلان: in_app و/أو email.
  channels      text[] NOT NULL DEFAULT ARRAY['in_app', 'email']::text[],
  status        text NOT NULL DEFAULT 'draft',
  publish_at    timestamptz,
  published_at  timestamptz,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcements_status_check   CHECK (status IN ('draft', 'scheduled', 'published')),
  CONSTRAINT announcements_audience_check CHECK (audience IN ('all', 'plan', 'status')),
  CONSTRAINT announcements_target_check CHECK (
    (audience = 'all'    AND plan_code IS NULL     AND tenant_status IS NULL) OR
    (audience = 'plan'   AND plan_code IS NOT NULL AND tenant_status IS NULL) OR
    (audience = 'status' AND plan_code IS NULL     AND tenant_status IS NOT NULL)
  ),
  CONSTRAINT announcements_status_target_check CHECK (
    tenant_status IS NULL OR tenant_status IN ('active', 'suspended', 'archived')
  ),
  CONSTRAINT announcements_channels_check CHECK (
    array_length(channels, 1) BETWEEN 1 AND 2 AND channels <@ ARRAY['in_app', 'email']::text[]
  ),
  CONSTRAINT announcements_publish_check CHECK (
    (status = 'draft'     AND published_at IS NULL) OR
    (status = 'scheduled' AND publish_at IS NOT NULL AND published_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL)
  ),
  CONSTRAINT announcements_title_check CHECK (
    length(btrim(title_ar)) BETWEEN 3 AND 200 AND length(btrim(title_en)) BETWEEN 3 AND 200
  ),
  CONSTRAINT announcements_body_check CHECK (
    length(btrim(body_ar)) BETWEEN 10 AND 5000 AND length(btrim(body_en)) BETWEEN 10 AND 5000
  )
);

-- المجدولة تُقرأ بزمنها: الفهرس الجزئي هو ما يجعل «ما استحقّ الآن» استعلاماً بلا مسح.
CREATE INDEX IF NOT EXISTS announcements_due_idx
  ON announcements (publish_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS announcements_recent_idx ON announcements (created_at DESC);

-- =============================================================================
-- 2. announcement_reads — سجلّ التسليم والقراءة
-- =============================================================================

CREATE TABLE IF NOT EXISTS announcement_reads (
  id               uuid PRIMARY KEY,
  announcement_id  uuid NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  membership_id    uuid NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  channel          text NOT NULL,
  -- شاهد قناة `in_app`: الإشعار المكتوب للعضو.
  notification_id  uuid REFERENCES notifications (id) ON DELETE SET NULL,
  -- شاهد قناة `email`: الرسالة في سجلّ البريد (P-C6).
  email_message_id uuid REFERENCES email_messages (id) ON DELETE SET NULL,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_reads_channel_check CHECK (channel IN ('in_app', 'email'))
);

-- الصفّ الواحد لكل (إعلان، عميل، عضو، قناة) — فلا يتضاعف التسليم إن أُعيد النشر.
CREATE UNIQUE INDEX IF NOT EXISTS announcement_reads_key
  ON announcement_reads (announcement_id, tenant_id, membership_id, channel);
CREATE INDEX IF NOT EXISTS announcement_reads_tenant_idx
  ON announcement_reads (announcement_id, tenant_id);
CREATE INDEX IF NOT EXISTS announcement_reads_unread_idx
  ON announcement_reads (announcement_id) WHERE read_at IS NULL;

-- =============================================================================
-- 3. RLS وأذونات
-- =============================================================================

-- جدول المنصة: لا سياسة مستأجر (ولا عمود tenant_id)، وسياسة المنصة وحدها.
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_admin_plane ON announcements;
CREATE POLICY platform_admin_plane ON announcements
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- سجلّ التسليم بنطاقين: جلسة المشغّل تراه كاملاً، وجلسة العميل ترى صفوفها وحدها (يقرؤها
-- المستأجر ليخصّ موظفيه بالقراءة لاحقاً)، وسياسة المنصة فوقها كما في بقية الجداول.
ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_reads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON announcement_reads;
CREATE POLICY tenant_isolation ON announcement_reads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_admin_plane ON announcement_reads;
CREATE POLICY platform_admin_plane ON announcement_reads
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- الإعلان مستندٌ لا يُمحى (ولا مسار حذف في اللوحة)، وسجلّ التسليم يُكتب ويُوسم بالقراءة.
GRANT SELECT, INSERT, UPDATE ON announcements       TO erp_api;
GRANT SELECT, INSERT, UPDATE ON announcement_reads  TO erp_api;
GRANT ALL PRIVILEGES ON announcements, announcement_reads TO erp_migrator;

-- =============================================================================
-- 4. رمز الصلاحية (إعلانٌ في الكود + إدراجٌ idempotent هنا)
-- =============================================================================

INSERT INTO permissions (code, module, description) VALUES
  ('console.notifications.manage', 'console',
   'Write, target and publish platform announcements, and read their delivery.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
