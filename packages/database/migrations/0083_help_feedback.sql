-- 0083_help_feedback.sql — P-M9 «مركز المساعدة وحالة الخدمة» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
--
-- ترحيلان في ملفٍ واحد لأنّهما من جزءٍ واحد، وكلٌّ منهما **تعديلٌ لا بناء**:
--
--   1. **`changelog` نوعٌ سابع للمحتوى** — الخطّة قالت «`/changelog` من `docs/change-log` أو من
--      نظام المحتوى»، والمختار نظام المحتوى (يفسّره تقرير الجزء §«ما اخترعناه»): الموقع يقرأ
--      من القاعدة لا من ملفات المستودع، وفريق التسويق يكتب التحديث من اللوحة بلا نشرة.
--      والقيد `content_pages_kind_check` يُوسَّع ولا يُبنى جدولٌ ثانٍ: صفحةُ التغيير صفحةٌ
--      كغيرها (كتلها وSEO ولغتاها)، والفرق مسارُها العام ونوعُها.
--
--   2. **`content_feedback` — صوت «هل أفادك هذا؟»** جدولٌ صغير بثلاثة أعمدة معنى:
--      أيّ مقال (`page_id`) · أيّ حكم (`helpful`) · وأيّ متصفّح (`visitor`).
--
-- **وقراران في هذا الجدول يحتاجان تبريراً:**
--
--   * **`visitor` ليس هوية.** معرّفٌ عشوائي (UUID) يولّده متصفّح الزائر ويحفظه في
--     `localStorage`، ومعه فهرسٌ فريد `(page_id, visitor)` يمنع عدّ الصوت مرّتين من المتصفّح
--     نفسه. ولماذا لا IP ولا بصمة متصفّح؟ لأنّ الغرض منعُ التكرار لا التعرّف على الناس، ولأن
--     عنوان IP يُخزَّن في هذا الجدول حرفياً بلا خدمةٍ لأحد — والفرق بين «رأيٌ مجموع» و«ملفٌّ
--     عن قارئ» فرقٌ يجب أن يُثبَّت في البنية لا في النيّة.
--   * **لا `UPDATE` ولا `DELETE` في المنح.** الصوت يُكتب مرّة، والتصحيح ليس محواً (كما في
--     `campaign_events` و`audit_log`). ومن أخطأ في تصويته لا يُعاد صوته — والعدّادان يعرضان
--     ما حُسب فعلاً.
--
-- ولا رمز صلاحية جديد: قراءة الأصوات ليست شاشةً في اللوحة اليوم (تحليلات الموقع في P-M10)،
-- والقراءة العامة تمرّ بمعاملة منصّة كما في بقيّة مسارات المحتوى العامّة.
--
-- آمن للإعادة التشغيل: `ADD COLUMN`/`CREATE` بـ`IF NOT EXISTS`، والقيد يُعاد بناؤه بـ`DROP`/`ADD`.

-- =============================================================================
-- 1. نوع المحتوى `changelog`
-- =============================================================================

ALTER TABLE content_pages DROP CONSTRAINT IF EXISTS content_pages_kind_check;
ALTER TABLE content_pages ADD CONSTRAINT content_pages_kind_check CHECK (
  kind IN ('page', 'post', 'case_study', 'faq', 'help', 'legal', 'changelog')
);

COMMENT ON COLUMN content_pages.kind IS
  'نوع المحتوى: page · post (المدوّنة) · case_study · faq · help (مركز المساعدة) · legal · changelog (سجلّ التغييرات — P-M9).';

-- =============================================================================
-- 2. content_feedback — صوت «هل أفادك هذا؟»
-- =============================================================================

CREATE TABLE IF NOT EXISTS content_feedback (
  id         uuid PRIMARY KEY,
  -- الحذف المتسلسل مقصود: مقالٌ أُزيل من CMS لا يترك أصواتاً معلّقةً بلا صاحب.
  page_id    uuid NOT NULL REFERENCES content_pages (id) ON DELETE CASCADE,
  helpful    boolean NOT NULL,
  -- معرّف المتصفّح العشوائي (UUID من `localStorage`) — ليس هويةً ولا بصمة.
  visitor    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_feedback_visitor_check CHECK (length(visitor) BETWEEN 8 AND 64)
);

-- صوتٌ واحد لكل مقالٍ لكل متصفّح: الفهرس هو الذي يمنع العدّ المزدوج، لا شرطٌ في الكود.
CREATE UNIQUE INDEX IF NOT EXISTS content_feedback_once_key ON content_feedback (page_id, visitor);
-- عدّ المقال الواحد يُقرأ بالمجموع، والفهرس يخدمه بلا مسحٍ كامل.
CREATE INDEX IF NOT EXISTS content_feedback_page_idx ON content_feedback (page_id, helpful);

-- =============================================================================
-- 3. RLS والصلاحيات
-- =============================================================================

ALTER TABLE content_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_admin_plane ON content_feedback;
CREATE POLICY platform_admin_plane ON content_feedback
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- بلا `UPDATE` ولا `DELETE`: الصوت يُكتب مرّةً ويُقرأ مجموعاً (كما في `campaign_events`).
GRANT SELECT, INSERT ON content_feedback TO erp_api;
GRANT ALL PRIVILEGES ON content_feedback TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
