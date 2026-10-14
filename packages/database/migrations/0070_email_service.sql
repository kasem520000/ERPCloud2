-- 0070_email_service.sql — P-C6 «خدمة البريد».
--
-- الرقم كما في جدول ترحيلات الخطة (§6) بلا إعادة ترقيم هذه المرة: 0070 حرّ فعلاً.
--
-- ما الذي يبنيه هذا الترحيل، ولماذا بهذا الشكل:
--
--   1. **`email_templates` — نصٌّ في جدول لأنه يتغيّر بالتشغيل.** فهرس الأحداث ومتغيّراتها
--      ثابتٌ في الكود (`packages/contracts/src/platform/email.ts`): حدثٌ بلا مرسلٍ في الكود
--      لا يُرسَل أبداً، فلو كان الحدث صفّاً لأمكن إنشاء «حدث» لا يقرؤه أحد. أما **النصّ**
--      فيتحرّك: المنصة تحرّره، والعميل يتجاوزه بنصّه. ولهذا صفّان لنفس الحدث: صفٌّ عام
--      (`tenant_id IS NULL`) وصفُّ تجاوزٍ لكل منشأة — باللغة مفتاحاً (`ar` · `en`).
--   2. **فهرسٌ فريد جزئيان لا واحد.** `UNIQUE (tenant_id, event, locale)` لا يكفي: في
--      PostgreSQL كل `NULL` مختلف عن الآخر، فيمكن إدخال قالبَي منصةٍ لنفس الحدث بلا اعتراض.
--      فالفهرس العام `(event, locale) WHERE tenant_id IS NULL` هو الذي يمنع فعلاً.
--   3. **`email_messages` — السجلّ كاملاً لا ملخّصاً.** النصّ المُرسَل يُحفظ كما ذهب (لا
--      يُعاد تصييره عند العرض)، لأن تعديل قالبٍ غداً يجب ألّا يغيّر ما قيل أمس. ومعها
--      `delivery_mode` (`queue` عبر outbox أو `inline` حين لا Redis)، و`attempts`/`max_attempts`
--      لسلّم التراجع (1د · 5د · 30د)، و`status` بخمس حالات: مُدرَج · مُرسَل · فاشل · محجوب
--      · مُرجَع — والمحجوب (`suppressed`) يميّز «لم نحاول لأن الحجر منع» عن «حاولنا وفشلنا».
--   4. **`email_suppressions` بنطاقين**: صفٌّ عام بلا منشأة (ارتداد عن عنوانٍ لا يستقبل من
--      أحد) وصفٌّ لمنشأة (إلغاء اشتراك عميلٍ of عميل). والحذف مسموح للمستخدم — رفع الحظر
--      قرارٌ مشروع، بخلاف سجلّ الرسائل.
--   5. **`email_settings` — صفٌّ عام وصفٌّ لكل عميل.** المزوّد اختياريّ من الشاشة بلا إعادة
--      نشر (`console` | `smtp`)، أما اعتمادات SMTP نفسها فتبقى في البيئة ولا تُخزَّن هنا:
--      جدولٌ يقرأه مشغّلٌ ليس مكان سرّ. وهذا مصرَّحٌ به في تقرير الجزء.
--   6. **نفس العزل المعلَن**: `ENABLE`+`FORCE RLS`، وسياسة مستأجر (`app.tenant_id`) وسياسة
--      مشغّل (`app.is_platform_admin`) بنمط 0020، **و`WITH CHECK` صريحة في الاثنتين** (علّة
--      0066 التي أصلحها P-C2: سياسة قراءةٍ بلا `WITH CHECK` تُرثي `USING` على الإدراج).
--
-- آمن للإعادة التشغيل: كل عبارة `IF NOT EXISTS` أو `DROP … IF EXISTS`، ولا شيء يُحذف.

-- =============================================================================
-- 1. email_templates — نصّ القالب (عامّ + تجاوز المستأجر)
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_templates (
  id         uuid PRIMARY KEY,
  -- NULL = قالب المنصة الذي يرثه كل عميل؛ وtenants.id = تجاوزٌ كتبه العميل (نصّه فقط).
  tenant_id  uuid REFERENCES tenants (id) ON DELETE CASCADE,
  -- مفتاح الحدث من فهرس `packages/contracts/src/platform/email.ts` — نصٌّ لا enum،
  -- فإضافة حدثٍ في الفهرس لا تحتاج ترحيلاً، والقيد يمنع الفراغ لا التوسّع.
  event      text NOT NULL,
  locale     text NOT NULL DEFAULT 'ar',
  subject    text NOT NULL,
  body       text NOT NULL,
  -- يُزاد مع كل حفظ: الشاشة تقول «النسخة 3» فتُقرأ التعديلات كتاريخٍ لا كصورةٍ واحدة.
  version    integer NOT NULL DEFAULT 1,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT email_templates_locale_check  CHECK (locale IN ('ar', 'en')),
  CONSTRAINT email_templates_event_check   CHECK (length(btrim(event)) BETWEEN 3 AND 80),
  CONSTRAINT email_templates_subject_check CHECK (length(btrim(subject)) BETWEEN 1 AND 300),
  CONSTRAINT email_templates_body_check    CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  CONSTRAINT email_templates_version_check CHECK (version >= 1)
);

-- قالبٌ عامّ واحد لكل (حدث، لغة) — وهذا الفهرس هو الذي يمنع التكرار فعلاً (انظر 2 أعلاه).
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_platform_key
  ON email_templates (event, locale) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_tenant_key
  ON email_templates (tenant_id, event, locale) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_templates_event_idx ON email_templates (event, locale);

-- =============================================================================
-- 2. email_messages — سجلّ الإرسال
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_messages (
  id                  uuid PRIMARY KEY,
  -- NULL = بريد المنصة على عملائها (ترخيص، تفعيل، إعلان)؛ وtenants.id = بريد العميل.
  tenant_id           uuid REFERENCES tenants (id) ON DELETE CASCADE,
  event               text NOT NULL,
  locale              text NOT NULL DEFAULT 'ar',
  -- المرجع يبقى بعد حذف القالب (`SET NULL`) لأن الرسالة شاهدٌ لا تابع.
  template_id         uuid REFERENCES email_templates (id) ON DELETE SET NULL,
  -- من أين جاء النصّ لحظة الإرسال: `seed` (احتياط الكود) أو `platform` أو `tenant`.
  template_source     text NOT NULL DEFAULT 'seed',
  to_email            text NOT NULL,
  to_name             text,
  -- النصّ المُرسَل كما ذهب: تعديل قالبٍ غداً لا يغيّر ما قيل أمس.
  subject             text NOT NULL,
  body                text NOT NULL,
  status              text NOT NULL DEFAULT 'queued',
  provider            text NOT NULL DEFAULT 'console',
  -- `queue` حين يُسلَّم عبر outbox/Redis، و`inline` حين لا طابور (بيئة التطوير).
  delivery_mode       text NOT NULL DEFAULT 'queue',
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,
  last_error          text,
  provider_message_id text,
  -- مهمة الـoutbox التي تحمل هذه الرسالة — بها تُعاد المحاولة من الشاشة.
  outbox_job_id       uuid,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  failed_at           timestamptz,
  next_attempt_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_messages_status_check
    CHECK (status IN ('queued', 'sent', 'failed', 'suppressed', 'bounced')),
  CONSTRAINT email_messages_mode_check     CHECK (delivery_mode IN ('queue', 'inline')),
  CONSTRAINT email_messages_provider_check CHECK (provider IN ('console', 'smtp')),
  CONSTRAINT email_messages_source_check   CHECK (template_source IN ('seed', 'platform', 'tenant')),
  CONSTRAINT email_messages_locale_check   CHECK (locale IN ('ar', 'en')),
  CONSTRAINT email_messages_to_check       CHECK (position('@' in to_email) > 1),
  CONSTRAINT email_messages_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10)
);

-- رسالة اختبار من الشاشة تُسجَّل كغيرها (اختبارٌ بلا سجلّ لا يُشخَّص) وتُوسَم كي لا تُحسب
-- على العميل في تقاريره، ولا تُحتسب في حصّته (انظر `EmailService.send`).
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS email_messages_tenant_created_idx ON email_messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_messages_status_created_idx ON email_messages (status, created_at DESC);
CREATE INDEX IF NOT EXISTS email_messages_event_created_idx  ON email_messages (event, created_at DESC);
-- عنوانٌ مُطبَّع (صغيراً) لأن الحجر يعمل على المطابقة التامّة لا على التشابه.
CREATE INDEX IF NOT EXISTS email_messages_to_idx            ON email_messages (lower(to_email));
CREATE INDEX IF NOT EXISTS email_messages_outbox_idx        ON email_messages (outbox_job_id);

-- =============================================================================
-- 3. email_suppressions — قائمة الحجر
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_suppressions (
  id         uuid PRIMARY KEY,
  -- NULL = حجرٌ عامّ يسري على كل العملاء؛ وtenants.id = حجرٌ على بريد عميلٍ بعينه.
  tenant_id  uuid REFERENCES tenants (id) ON DELETE CASCADE,
  email      text NOT NULL,
  reason     text NOT NULL,
  note       text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_suppressions_reason_check CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual')),
  CONSTRAINT email_suppressions_email_check  CHECK (position('@' in email) > 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_platform_key
  ON email_suppressions (email) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_tenant_key
  ON email_suppressions (tenant_id, email) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_suppressions_email_idx ON email_suppressions (email);

-- =============================================================================
-- 4. email_settings — المُرسِل والحدود
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_settings (
  id             uuid PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants (id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'console',
  from_name      text NOT NULL DEFAULT 'منصة ERP',
  from_email     text NOT NULL DEFAULT 'no-reply@erp.local',
  reply_to       text,
  sending_domain text,
  daily_limit    integer,
  monthly_limit  integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT email_settings_provider_check CHECK (provider IN ('console', 'smtp')),
  CONSTRAINT email_settings_from_check     CHECK (position('@' in from_email) > 1),
  CONSTRAINT email_settings_reply_check    CHECK (reply_to IS NULL OR position('@' in reply_to) > 1),
  CONSTRAINT email_settings_daily_check    CHECK (daily_limit IS NULL OR daily_limit > 0),
  CONSTRAINT email_settings_monthly_check  CHECK (monthly_limit IS NULL OR monthly_limit > 0)
);

-- صفٌّ عامّ واحد: الفهرس الجزئي على تعبيرٍ ثابت (`tenant_id IS NULL` صحيحٌ دائماً داخل
-- هذا الجزء) هو الطريقة القياسية لمنع صفّين عامّين في PostgreSQL، لأن `UNIQUE (tenant_id)`
-- لا يمنع تكرار NULL.
CREATE UNIQUE INDEX IF NOT EXISTS email_settings_platform_key
  ON email_settings ((tenant_id IS NULL)) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_settings_tenant_key
  ON email_settings (tenant_id) WHERE tenant_id IS NOT NULL;

-- =============================================================================
-- 5. RLS وأذونات
-- =============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_templates', 'email_messages', 'email_suppressions', 'email_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );

    EXECUTE format('DROP POLICY IF EXISTS platform_admin_plane ON %I', t);
    EXECUTE format(
      'CREATE POLICY platform_admin_plane ON %I USING (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'') WITH CHECK (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'')',
      t
    );
  END LOOP;
END $$;

-- القوالب والرسائل دعاوى: تُكتب وتُقرأ وتُعدَّل (النصّ)، ولا تُحذف.
GRANT SELECT, INSERT, UPDATE ON email_templates TO erp_api;
GRANT SELECT, INSERT, UPDATE ON email_messages  TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_suppressions TO erp_api;
GRANT SELECT, INSERT, UPDATE ON email_settings  TO erp_api;
GRANT ALL PRIVILEGES ON email_templates, email_messages, email_suppressions, email_settings TO erp_migrator;

-- =============================================================================
-- 6. رموز الصلاحيات الأربعة (إعلانٌ في الكود + إدراجٌ idempotent هنا)
-- =============================================================================
-- الآلية نفسها التي نصّت عليها الخطة §7.4: الإعلان في `permissions.ts`، والإدراج هنا،
-- وإثبات الصفّ في `permission-codes.spec.ts` و`platform-email.spec.ts`.

INSERT INTO permissions (code, module, description) VALUES
  ('console.email.view', 'console',
   'Read the outbound e-mail log across tenants.'),
  ('console.email.manage', 'console',
   'Manage e-mail templates, sender settings and suppressions.'),
  ('tenant.email.template.manage', 'tenant',
   'Override the text of e-mail templates for the own tenant.'),
  ('tenant.email.log.view', 'tenant',
   'Read the outbound e-mail log of the own tenant.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
