-- 0080_leads.sql — P-M6 «التقاط العملاء المتوقّعين وإدارتهم» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
--
-- الخطّة سمّت الملف `0075_leads.sql`، و0075 أخذه P-C11 (اعتمادات المطوّرين). والحرّ التالي
-- **0080** بعد `0079_signup_verifications.sql`. والصلاحيات في `0081_leads_permissions.sql`
-- (نفس فصل P-M5: بنيةُ البيانات في ملف، ورموزُ اللوحة في ملف) — حتى يبقى كل ملفٍ وحيد الفكرة.
--
-- أربعة جداول، وثلاثة قرارات تحكم شكلها:
--
--   1. **العميل المتوقَّع ليس مستأجراً.** لا `tenant_id` هنا — لا عموداً ولا سياسةً. من يملأ
--      استمارةً على الإنترنت هو **بياناتُ شخصٍ في العالم**، لا صفٌّ داخل منشأة: لا يرى
--      النظام ولا يقرأ شيئاً، ولا يُمحى سطرُه إذا رفض الصفقة. و`converted_tenant_id` يُكتب
--      **مرّةً واحدة** عند التحويل (فعلٌ صريح يترك أثراً) ويبقى دليلاً على أن الطلب صار عميلاً.
--   2. **سياسة المنصّة وحدها (`platform_admin_plane`) و`FORCE`.** الجداول تقرأها اللوحة
--      وتكتبها، والمسار العامّ يمرّ بها في معاملة سياق المنصّة (`withPlatformAdminTx`) —
--      نفس ما فعلته جداول المحتوى (P-M5). ولا سياسة `anon` واحدة: بابٌ عامّ يكتب مباشرةً
--      في جدولٍ بلا خدمةٍ تحرسه ليس باباً بل ثغرة.
--   3. **لا سطر يُحذف.** GRANT بلا `DELETE`: الطلب المرفوض يبقى مرفوضاً بتاريخه، لأن سؤال
--      «لماذا لم نُتابع هذا؟» يُجاب بالصفّ لا بذاكرة الموظّف.
--
-- آمن للإعادة التشغيل: `IF NOT EXISTS` في كل عبارة.

-- =============================================================================
-- 1. العملاء المتوقّعون
-- =============================================================================

CREATE TABLE IF NOT EXISTS leads (
  id                  uuid PRIMARY KEY,
  -- مرجعٌ قصير يُقال للزائر في الاستمارة («طلبك L-3F9A2C1D») ويُبحث به في اللوحة.
  reference           text NOT NULL,
  full_name           text NOT NULL,
  company_name        text,
  -- البريد مخزَّنٌ مُطبَّعاً (حروف صغيرة، بلا مسافات) — والمفتاح الفريد أدناه على `dedupe_key`
  -- لا على العمود، لأن التطبيع قرارُ خدمةٍ لا صيغةُ عمود.
  email               text NOT NULL,
  dedupe_key          text NOT NULL,
  phone               text,
  branch_count        integer,
  plan_interest       text,
  message             text NOT NULL,
  status              text NOT NULL DEFAULT 'new',
  source              text NOT NULL DEFAULT 'form',
  locale              text NOT NULL DEFAULT 'ar',
  accepts_marketing   boolean NOT NULL DEFAULT false,
  -- UTM كاملة كما وصلت: نسخةُ الشهر الماضي من الحملة لا تُعاد كتابتها بعد اليوم.
  utm                 jsonb,
  assigned_to         uuid REFERENCES users (id) ON DELETE SET NULL,
  -- أثر التحويل: أيّ منشأةٍ وُلِدت من هذا الطلب ومتى (NULL حتى يقع التحويل).
  converted_tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  converted_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_status_check CHECK (status IN ('new', 'contacted', 'qualified', 'won', 'rejected')),
  CONSTRAINT leads_source_check CHECK (source IN ('form', 'demo', 'newsletter', 'campaign', 'manual')),
  CONSTRAINT leads_locale_check CHECK (locale IN ('ar', 'en')),
  CONSTRAINT leads_branch_count_check CHECK (branch_count IS NULL OR (branch_count >= 0 AND branch_count <= 999)),
  CONSTRAINT leads_email_check CHECK (length(email) BETWEEN 3 AND 160),
  CONSTRAINT leads_message_check CHECK (length(message) BETWEEN 10 AND 2000),
  CONSTRAINT leads_reference_check CHECK (reference ~ '^L-[0-9A-F]{8,16}$'),
  -- طلبٌ حُوّل له منشأةٌ ولحظةُ تحويل — لا واحدةٌ بلا الأخرى.
  CONSTRAINT leads_conversion_check CHECK ((converted_tenant_id IS NULL) = (converted_at IS NULL))
);

-- **منع التكرار**: عنوانٌ واحد = طلبٌ واحد. فالملء الثاني لا يُنشئ صفّاً ثانياً (يسقط في
-- `DO NOTHING` وتُضاف رسالته **ملاحظةً** على الطلب القائم): زائرٌ يضغط «إرسال» مرّتين لا
-- يتحوّل إلى عميلين، ومندوبٌ يتّصل به لا يرى بطاقتين لنفس الشخص.
CREATE UNIQUE INDEX IF NOT EXISTS leads_dedupe_key_key ON leads (dedupe_key);
CREATE UNIQUE INDEX IF NOT EXISTS leads_reference_key ON leads (reference);
CREATE INDEX IF NOT EXISTS leads_status_created_idx ON leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_assigned_idx ON leads (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_source_idx ON leads (source, created_at DESC);

-- =============================================================================
-- 2. الملاحظات — «ماذا قال المندوب؟»
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_notes (
  id           uuid PRIMARY KEY,
  lead_id      uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  body         text NOT NULL,
  author_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  -- اسمٌ محفوظ وقت الكتابة: الموظّف يُنقل أو يُوقف، والملاحظة تبقى منسوبةً لمن كتبها.
  author_label text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_notes_body_check CHECK (length(body) BETWEEN 2 AND 2000)
);

CREATE INDEX IF NOT EXISTS lead_notes_lead_idx ON lead_notes (lead_id, created_at DESC);

-- =============================================================================
-- 3. الأثر — «ما الذي جرى على هذا الطلب؟»
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_events (
  id           uuid PRIMARY KEY,
  lead_id      uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  -- الأحداث مغلقة في العقد (`leadEventKinds`): created · assigned · status_changed ·
  -- note_added · converted · duplicated.
  kind         text NOT NULL,
  detail       text,
  -- تفاصيل مُهيكلة (من حالةٍ إلى حالة، أو من مُسنَدٍ إلى مُسنَد) — تُقرأ في الشاشة.
  meta         jsonb,
  actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_label  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_events_lead_idx ON lead_events (lead_id, created_at DESC);

-- =============================================================================
-- 4. المشتركون في النشرة — تأكيدٌ مزدوج
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_subscribers (
  id                uuid PRIMARY KEY,
  email             text NOT NULL,
  dedupe_key        text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  locale            text NOT NULL DEFAULT 'ar',
  source            text NOT NULL DEFAULT 'newsletter',
  -- **sha256 للرمز** لا الرمز: من يقرأ القاعدة لا يستطيع تأكيد اشتراكٍ ليس له.
  confirm_token_hash text,
  confirm_sent_at   timestamptz,
  confirmed_at      timestamptz,
  unsubscribed_at   timestamptz,
  utm               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_subscribers_status_check CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  CONSTRAINT email_subscribers_locale_check CHECK (locale IN ('ar', 'en')),
  CONSTRAINT email_subscribers_email_check CHECK (length(email) BETWEEN 3 AND 160),
  -- مؤكَّدٌ له لحظةُ تأكيد، ومن أُلغي اشتراكه له لحظته — والعكس لا يقبل.
  CONSTRAINT email_subscribers_confirmed_check CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS email_subscribers_dedupe_key_key ON email_subscribers (dedupe_key);
CREATE UNIQUE INDEX IF NOT EXISTS email_subscribers_confirm_token_key
  ON email_subscribers (confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_subscribers_status_idx ON email_subscribers (status, created_at DESC);

-- =============================================================================
-- 5. RLS والصلاحيات
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads', 'lead_notes', 'lead_events', 'email_subscribers']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_admin_plane ON %I', t);
    EXECUTE format(
      'CREATE POLICY platform_admin_plane ON %I USING (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'') WITH CHECK (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'')',
      t
    );
  END LOOP;
END $$;

-- بلا `DELETE` عن قصد: الطابور سجلّ، والسجلّ لا يُمحى. والإلغاء حالةٌ (`rejected`).
GRANT SELECT, INSERT, UPDATE ON leads, lead_notes, lead_events, email_subscribers TO erp_api;
GRANT ALL PRIVILEGES ON leads, lead_notes, lead_events, email_subscribers TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
