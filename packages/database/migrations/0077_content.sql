-- 0077_content.sql — P-M5 «نظام إدارة المحتوى» (`docs/roadmap/MARKETING_SITE_PLAN.md` §6).
--
-- الرقم صُحِّح: الخطّة كتبت `0074_content.sql`، وقد أخذه P-C10 (النسخ والاسترجاع)؛ فالحرّ
-- التالي **0077** بعد `0076_analytics_permission.sql`.
--
-- ما الذي يبنيه هذا الترحيل، ولماذا بهذا الشكل:
--
--   1. **خمسة جداول بلا `tenant_id`.** الموقع التسويقي ليس بيانات عميل: هو مستند المنصّة إلى
--      السوق، كما أن `announcements` (P-C7) مستندها إلى عملائها — فالسياسة الوحيدة
--      `platform_admin_plane` و`FORCE` لأن المالك أيضاً يمرّ بها.
--   2. **القراءة العامة لا تمرّ بحذف RLS.** نقطة النهاية العامة تفتح معاملة **بسياق المنصّة**
--      (`withPlatformAdminTx`) ثم تُصفّي في SQL: `status = 'published'` و`published_at <= now()`.
--      البديل (منح `anon` قراءةً على الجداول) كان سيجعل **المسوّدة قابلة للقراءة** من أي عميل
--      يعرف الـslug. وهنا الفلتر شرطٌ واحد يسكن دالّةً واحدة في الخدمة، وسبيكٌ يثبت أن المسوّدة
--      والمجدولة لا تظهران. (القرار مصرَّح به في تقرير الجزء §«ما اخترعناه».)
--   3. **صفحةٌ واحدة بلغتين لا صفّان.** `title_ar` و`title_en` في الصف نفسه — نفس ما فعلته
--      `announcements`. صفحةٌ بصفّين تعني ترجمةً تنفصل عن أصلها فتصير نسخةً ثانية تُنسى؛
--      و`default_locale` يقول أيّهما الأصل. و`title_en` **قد تكون NULL** لأن الإنجليزي ليس شرطاً
--      للإطلاق — والردّ العام يقول أيّ لغةٍ نالت ترجمة.
--   4. **كتلٌ لا HTML.** `content_blocks.content` حقل `jsonb` بمفاتيح `ar`/`en`، ونوع الكتلة من
--      قائمة مغلقة. HTML حرّاً يعني أن كل تعديلٍ من اللوحة يمكن أن يكسر التصميم أو يفتح ثغرة
--      حقنٍ في موقعٍ عام — والكتل تجعل المعاينة ممكنة والتصميم مضموناً.
--   5. **نسخةٌ قبل كل كتابة.** `content_versions` صورةٌ كاملة (الصفحة + كتلها) بلقطة `jsonb`
--      ورقمٍ متزايد. ولا مسار حذفٍ للنسخ: التصحيح ليس محواً.
--   6. **حالة الجدولة مقيَّدة في القاعدة**: `scheduled` بلا `publish_at` خطأٌ لا يُقبل (كما في
--      الإعلانات)، و`published` بلا `published_at` كذلك.
--
-- آمن للإعادة التشغيل: `IF NOT EXISTS` في كل عبارة، ولا شيء يُحذف.

-- =============================================================================
-- 1. الصفحات
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_pages (
  id             uuid PRIMARY KEY,
  slug           text NOT NULL,
  -- نوع المحتوى: صفحة تسويقية · مقال مدوّنة · دراسة حالة · سؤال شائع · مقال مساعدة · قانوني.
  kind           text NOT NULL DEFAULT 'page',
  title_ar       text NOT NULL,
  title_en       text,
  summary_ar     text,
  summary_en     text,
  status         text NOT NULL DEFAULT 'draft',
  -- اللسان الأصل: أي حقلٍ يُعرض حين لا ترجمة.
  default_locale text NOT NULL DEFAULT 'ar',
  publish_at     timestamptz,
  published_at   timestamptz,
  -- SEO: العنوان والوصف وصورة المشاركة. تُولَّد من العنوان والملخّص إن غابت (الخدمة تملؤها).
  seo_title_ar   text,
  seo_title_en   text,
  seo_desc_ar    text,
  seo_desc_en    text,
  og_image_url   text,
  category       text,
  author_name    text,
  created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_pages_kind_check CHECK (
    kind IN ('page', 'post', 'case_study', 'faq', 'help', 'legal')
  ),
  CONSTRAINT content_pages_status_check CHECK (status IN ('draft', 'scheduled', 'published')),
  CONSTRAINT content_pages_locale_check CHECK (default_locale IN ('ar', 'en')),
  CONSTRAINT content_pages_slug_check CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 120),
  CONSTRAINT content_pages_title_check CHECK (length(btrim(title_ar)) BETWEEN 2 AND 200),
  CONSTRAINT content_pages_lifecycle_check CHECK (
    (status = 'draft'     AND published_at IS NULL) OR
    (status = 'scheduled' AND publish_at IS NOT NULL AND published_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL)
  )
);

-- الـslug فريد على مستوى المنصّة كلها: الرابط العام هو `/blog/<slug>` و`/help/<slug>`، وتكراره
-- يعني أن صفحةً ستُظلّل الأخرى بصمت (وكيل البحث يرى واحدة فقط).
CREATE UNIQUE INDEX IF NOT EXISTS content_pages_slug_key ON content_pages (slug);
CREATE INDEX IF NOT EXISTS content_pages_listing_idx ON content_pages (status, kind, published_at DESC);
CREATE INDEX IF NOT EXISTS content_pages_category_idx ON content_pages (category) WHERE category IS NOT NULL;

-- =============================================================================
-- 2. الكتل — محتوى الصفحة بترتيبه
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_blocks (
  id         uuid PRIMARY KEY,
  page_id    uuid NOT NULL REFERENCES content_pages (id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position BETWEEN 0 AND 500),
  kind       text NOT NULL,
  -- { ar: <any>, en: <any> } — الشكل بحسب النوع، ويُتحقَّق في العقد لا في القاعدة.
  content    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_blocks_kind_check CHECK (
    kind IN ('heading', 'text', 'image', 'cards', 'table', 'faq', 'quote', 'code', 'video', 'cta', 'list')
  ),
  CONSTRAINT content_blocks_content_check CHECK (jsonb_typeof(content) = 'object')
);

-- ترتيبٌ واحد لكل صفحة: تكرار `position` يجعل الترتيب غير قابل للتنبؤ بين قراءتين.
CREATE UNIQUE INDEX IF NOT EXISTS content_blocks_page_position_key ON content_blocks (page_id, position);

-- =============================================================================
-- 3. القوائم
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_menus (
  id         uuid PRIMARY KEY,
  position   text NOT NULL,
  -- مصفوفة عناصر: [{ key, href, labelAr, labelEn, badge? }] — الترتيب هو ترتيب المصفوفة.
  items      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_menus_position_check CHECK (position IN ('header', 'footer', 'sidebar', 'legal')),
  CONSTRAINT content_menus_items_check CHECK (jsonb_typeof(items) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS content_menus_position_key ON content_menus (position);

-- =============================================================================
-- 4. اللافتات
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_banners (
  id          uuid PRIMARY KEY,
  text_ar     text NOT NULL,
  text_en     text,
  -- رابطٌ اختياري ونصّه: لافتةٌ بلا وجهة تبقى إعلاناً نصّياً مقبولاً.
  href        text,
  link_label_ar text,
  link_label_en text,
  tone        text NOT NULL DEFAULT 'info',
  audience    text NOT NULL DEFAULT 'all',
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_banners_tone_check CHECK (tone IN ('info', 'ok', 'warn', 'danger')),
  CONSTRAINT content_banners_audience_check CHECK (audience IN ('all', 'visitors')),
  CONSTRAINT content_banners_window_check CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT content_banners_text_check CHECK (length(btrim(text_ar)) BETWEEN 3 AND 200)
);

CREATE INDEX IF NOT EXISTS content_banners_active_idx ON content_banners (active, starts_at, ends_at);

-- =============================================================================
-- 5. النسخ — صورةٌ قبل كل كتابة
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_versions (
  id         uuid PRIMARY KEY,
  page_id    uuid NOT NULL REFERENCES content_pages (id) ON DELETE CASCADE,
  version    integer NOT NULL CHECK (version > 0),
  -- الصفحة وكتلها كما كانتا لحظة الكتابة: { page: {...}, blocks: [...] }.
  snapshot   jsonb NOT NULL,
  note       text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_versions_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS content_versions_page_version_key ON content_versions (page_id, version);
CREATE INDEX IF NOT EXISTS content_versions_page_idx ON content_versions (page_id, created_at DESC);

-- =============================================================================
-- 6. RLS والأذونات
-- =============================================================================

-- جداولُ المنصّة: لا سياسة مستأجر (ولا عمود لها)، وسياسة المنصّة وحدها على الخمسة.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['content_pages', 'content_blocks', 'content_menus', 'content_banners', 'content_versions']
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

-- لا `DELETE` على الصفحات: الحذف يعني رابطاً عاماً انكسر في نتائج البحث وفي رسالة قديمة.
-- (لا مسار حذفٍ في اللوحة؛ الإخفاء بحالةٍ لا بمحو.)
GRANT SELECT, INSERT, UPDATE ON content_pages, content_blocks, content_menus, content_banners, content_versions TO erp_api;
GRANT ALL PRIVILEGES ON content_pages, content_blocks, content_menus, content_banners, content_versions TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
