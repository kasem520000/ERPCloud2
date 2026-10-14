-- 0084_site_analytics.sql — P-M10 «القياس والتحسين» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
--
-- ثلاثة تغييرات في ملفٍ واحد، وكلٌّ منها **تعديلٌ لا بناء**: القياس في قاعدتنا لا في طرفٍ
-- ثالث، والاختبار أ/ب في نظام المحتوى القائم لا في جدولٍ موازٍ.
--
--   1. **`site_events` — حدثٌ مجهول.** صفٌّ واحد لكل حدث، وفيه: الاسم والمسار واللغة وعائل
--      المُحيل ومعرّف المتصفّح العشوائي ووصفٌ بمفاتيح مغلقة. **وليس فيه عنوان IP ولا بريد
--      ولا اسم ولا بصمة** — ليس لأننا لا نريد تخزينها فقط، بل لأن **العمود غير موجود**:
--      ما لا يملك عموداً لا يُكتب بالخطأ.
--
--      ولماذا صفٌّ لكل حدث لا عدّادٌ مجمَّع؟ لأن العدّاد المجمَّع يفقد تمييز الزائر، وبلا
--      تمييزٍ لا يُحسب «كم زائراً بدأ اشتراكاً» بل «كم مرّة نُقر الزرّ» — والقمع يُقاس
--      بالزوّار. والتجميع يجري في **القراءة** (‏`GROUP BY` في استعلامات اللوحة)، والدفعة
--      الواحدة تحدّ الطلبات (٢٠ حدثاً/نداء).
--
--   2. **الاحتفاظ ١٨٠ يوماً** — لا صفّ خام أبديّ. والحذف يُنفَّذ من الخدمة عند الكتابة،
--      بعلامةٍ مائية في `platform_settings` (`site.events.pruned_at`) فلا يُنفَّذ استعلامُ
--      حذفٍ في كل حدث: مرّةً كل يوم. والرقم في العقد (`SITE_EVENTS_RETENTION_DAYS`) والشاشة
--      تقوله للعميل.
--
--   3. **`content_pages.variant_of` + `variant_key` — اختبار أ/ب من نظام المحتوى.** النسخة
--      صفحةٌ كاملة (عنوانها وكتلها ودعوتها)، والربط بالأصل بعمودٍ ذاتيّ المرجع. والفهرس
--      الفريد `(variant_of, variant_key)` يمنع نسختين بحرفٍ واحد — وهذا خطأُ تحريرٍ لا خطأُ
--      نظام، والصواب أن يُمنع في البنية.
--
-- ولا رمز صلاحية جديد: شاشة قياس الموقع تقرأ برمز التحليلات القائم `console.analytics.view`
-- (P-C12) — فهي **قراءةٌ خالصة** للرقم نفسه الذي يملكه ذلك الجزء، ولا مسار فيها يكتب.
--
-- آمن للإعادة التشغيل: `CREATE ... IF NOT EXISTS` و`ADD COLUMN IF NOT EXISTS`.

-- =============================================================================
-- 1. site_events — حدثٌ مجهول الهوية
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_events (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  path          text NOT NULL,
  locale        text NOT NULL DEFAULT 'ar',
  -- عائل المُحيل فقط (`example.com`)، ولا الرابط الكامل: الرابط يحمل معاملاتٍ ونصوص بحث،
  -- وعائلٌ يكفي لسؤال «من أين جاء الزائر».
  referrer_host text,
  -- معرّف المتصفّح العشوائي (UUID) — غرضه الوحيد تمييز زيارةٍ من زيارة وتمييز مستخدمٍ عن آخر.
  visitor       text NOT NULL,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_events_name_check CHECK (
    name IN ('page_view', 'signup_start', 'signup_complete', 'request_demo',
             'newsletter_subscribe', 'experiment_exposure')
  ),
  CONSTRAINT site_events_locale_check CHECK (locale IN ('ar', 'en')),
  CONSTRAINT site_events_path_check CHECK (length(btrim(path)) BETWEEN 1 AND 200),
  -- القيد نفسه الذي في العقد: معرّف المتصفّح UUID — فلا يدخل نصٌّ حرّ باسم زائر.
  CONSTRAINT site_events_visitor_check CHECK (
    visitor ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  -- الوصف بمفاتيح مغلقة (الاسم في العقد، والقيد هنا: الجدول ليس حقل ملاحظات).
  -- والفحص بـ`-` (حذف المفاتيح المعروفة) لأن CHECK لا يقبل استعلاماً فرعياً في Postgres:
  -- فإذا لم يبقَ مفتاحٌ بعد حذف الخمسة فكلّها معروفة.
  CONSTRAINT site_events_meta_keys_check CHECK (
    jsonb_typeof(meta) = 'object'
    AND meta - ARRAY['experiment', 'variant', 'plan', 'source', 'goal'] = '{}'::jsonb
  )
);

-- الاستعلامات كلها بنافذةٍ زمنية، والفهرس يخدم: العدّ بالنافذة، والعدّ بالاسم، والاحتفاظ.
CREATE INDEX IF NOT EXISTS site_events_occurred_idx ON site_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS site_events_name_occurred_idx ON site_events (name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS site_events_visitor_idx ON site_events (visitor, occurred_at DESC);

COMMENT ON TABLE site_events IS
  'P-M10 — أحداث الموقع التسويقي: مجهولة الهوية (بلا IP أو بريد أو بصمة)، تُحتجَز ١٨٠ يوماً وتُقرأ مجمَّعةً في اللوحة.';

-- =============================================================================
-- 2. اختبار أ/ب — النسخة صفحةٌ كاملة في نظام المحتوى
-- =============================================================================

ALTER TABLE content_pages ADD COLUMN IF NOT EXISTS variant_of uuid;
ALTER TABLE content_pages ADD COLUMN IF NOT EXISTS variant_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_pages_variant_of_fkey'
  ) THEN
    ALTER TABLE content_pages
      ADD CONSTRAINT content_pages_variant_of_fkey
      FOREIGN KEY (variant_of) REFERENCES content_pages (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_pages_variant_check'
  ) THEN
    -- نسخةٌ بحرفٍ بلا أصل أو أصلٌ بحرفٍ بلا نسخةٍ: كلاهما خطأُ تحريرٍ، والقيد يمنعه.
    ALTER TABLE content_pages
      ADD CONSTRAINT content_pages_variant_check CHECK (
        (variant_of IS NULL AND variant_key IS NULL)
        OR (variant_of IS NOT NULL AND variant_key IN ('a', 'b'))
      );
  END IF;
END $$;

-- نسختان بحرفٍ واحد لصفحةٍ واحدة لا معنى لهما: أيهما يرى الزائر؟
CREATE UNIQUE INDEX IF NOT EXISTS content_pages_variant_once_key
  ON content_pages (variant_of, variant_key)
  WHERE variant_of IS NOT NULL;

COMMENT ON COLUMN content_pages.variant_of IS
  'P-M10 — معرّف الصفحة الأم إن كانت هذه نسخةً في اختبار أ/ب (وإلا NULL).';
COMMENT ON COLUMN content_pages.variant_key IS
  'P-M10 — حرف النسخة: a أو b (وNULL للأصل).';

-- =============================================================================
-- 3. RLS والصلاحيات
-- =============================================================================

ALTER TABLE site_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_admin_plane ON site_events;
CREATE POLICY platform_admin_plane ON site_events
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- الكتابة من الواجهة العامة، والقراءة من اللوحة، والحذف للاحتفاظ — بلا UPDATE:
-- الحدث خبرٌ وقع، وتصحيحه ليس تعديله بل الحدث التالي.
GRANT SELECT, INSERT, DELETE ON site_events TO erp_api;
-- و`REVOKE` صريح لأن `ALTER DEFAULT PRIVILEGES` في 0000 يمنح `UPDATE` لكل جدولٍ جديد:
-- بلا هذا السطر يكون المنع نيّةً في تعليقٍ لا قاعدةً في الصلاحيات (وقد قِيست الفجوة فعلاً:
-- `information_schema.role_table_grants` أظهر `UPDATE` في أول تشغيلٍ للتحقّق الحيّ).
REVOKE UPDATE ON site_events FROM erp_api;
GRANT ALL PRIVILEGES ON site_events TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
