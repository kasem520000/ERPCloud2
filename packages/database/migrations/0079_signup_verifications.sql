-- 0079_signup_verifications.sql — P-M4 «الاشتراك والتفعيل»
-- (`docs/roadmap/MARKETING_SITE_PLAN.md` §5، الجزء P-M4).
--
-- **المشكلة التي يحلّها هذا الجدول**: `POST /signup` كان يُنشئ منشأةً ومستخدمين فوراً بلا
-- إثبات أن من يملأ النموذج يملك البريد الذي كتبه. والبريد هو هويّة الحساب في هذا المنتج:
-- كل من يكتب عنوان غيره يمنحه منشأةً كاملة، وكل عنوانٍ يكتبه أحدٌ يجرّبه قد يُستهلك في
-- سردٍ للعناوين. فالتحقّق بالرمز ليس تجميلاً: هو الحلقة التي تجعل «البريد» يعني صاحبه.
--
-- **ولماذا جدولٌ جديد ولا reuse؟** لا جدول تحقّقٍ في المستودع أصلاً (`email_messages` سجلّ
-- إرسال، و`mfa_secrets` للمصادقة الثنائية، و`activation_requests` طابور تشغيل). فالمخزون
-- المطلوب ثلاثة حقولٍ لا تُشتقّ من غيرهما: تجزئةُ الرمز، وعدّادُ المحاولات، ووقتُ الانتهاء.
--
-- **نطاق المنصة لا المستأجر**: الصفّ يُكتب قبل أن تكتمل ثقة الزائر بمنشأته، وقارئه مسارٌ
-- عامٌّ بلا جلسة. فالسياسة الوحيدة هنا تفتح الجدول لمشغّل المنصة وحده
-- (`app.is_platform_admin = 'on'`، وهي GUC محلية المعاملة يضبطها `withPlatformAdminTx`)،
-- و`FORCE ROW LEVEL SECURITY` حتى لا يلتفّ مالكُ الجدول على السياسة — نفس نمط
-- `platform_settings` في 0066.
--
-- **وما لا يُخزَّن مقصود**: الرمز الخامس (`code`) والرمز المميّز (`token`) **لا يُكتبان**؛
-- يُخزَّن sha256 لكلٍّ منهما. فلا يقرأ الرمز من نسخةٍ احتياطية ولا من سجلّ، ولا يظهر في
-- أي استجابة. والقيد الفريد الجزئي يمنع تسجيلَين معلَّقَين لعنوانٍ واحد، ويسمح بتسجيلٍ جديد
-- بعد نجاح الأول (الصفّ القديم يبقى أثراً: تاريخُ من سجّل ومتى تحقّق).

CREATE TABLE IF NOT EXISTS signup_verifications (
  id            uuid PRIMARY KEY,
  -- البريد كما هو بعد التطبيع (حروفٌ صغيرة بلا مسافات) — التطبيع في الكود لا في القاعدة،
  -- لأن نفس الدالّة (`normalizeSignupEmail`) تُستعمل في القراءة والكتابة والاختبار.
  email         text NOT NULL,
  tenant_id     uuid REFERENCES tenants (id) ON DELETE CASCADE,
  tenant_code   text,
  -- الاسم كما كتبه الزائر، لتُخاطبه رسالة الترحيب باسم منشأته لا بمعرّفٍ تقني.
  tenant_name   text,
  owner_name    text,
  plan_id       uuid REFERENCES billing_plans (id) ON DELETE SET NULL,
  locale        text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  token_hash    text NOT NULL,
  code_hash     text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sends         integer NOT NULL DEFAULT 1 CHECK (sends >= 1),
  last_sent_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);

-- تسجيلٌ معلَّقٌ واحد لكل عنوان: إعادة البدء لا تُنشئ صفّاً ثانياً يخفي الأول.
CREATE UNIQUE INDEX IF NOT EXISTS signup_verifications_email_pending_key
  ON signup_verifications (lower(email))
  WHERE verified_at IS NULL;

-- البحث في المسار العام يكون بالرمز المميّز (تجزئته) مع البريد.
CREATE INDEX IF NOT EXISTS signup_verifications_token_hash_idx
  ON signup_verifications (token_hash);
CREATE INDEX IF NOT EXISTS signup_verifications_tenant_idx
  ON signup_verifications (tenant_id);

ALTER TABLE signup_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_verifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_verifications_platform ON signup_verifications;
CREATE POLICY signup_verifications_platform ON signup_verifications
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

GRANT SELECT, INSERT, UPDATE ON signup_verifications TO erp_api;
GRANT ALL PRIVILEGES ON signup_verifications TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
