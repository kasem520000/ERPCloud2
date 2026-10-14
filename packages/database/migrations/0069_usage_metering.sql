-- 0069_usage_metering.sql — P-C5 «الاستخدام والحصص».
--
-- الخطة سمّت الترحيل `0068_usage_metering.sql`، و0068 صار لفوترة المنصة في P-C4؛ فورقة
-- الترقيم تقول 0069 (القاعدة نفسها المعلنة في P-C4 §6: المنفّذ يعيد الترقيم عند التعارض).
--
-- ما الذي يبنيه هذا الترحيل، ولماذا بهذا الشكل:
--
--   1. **`usage_counters` للعدّ الذي لا جدول له.** ستة من مقاييس P-C5 الثمانية تُقرأ حيّةً
--      من جداولها (`memberships` · `branches` · `items` · `sales_invoices` ·
--      `whatsapp_messages` · `files`) فلا يمكن لرقمٍ في الشاشة أن يخالف دليلَه. ويبقى
--      مقياسان بلا جدول: استدعاءات الـAPI اليومية (لا سجلّ طلباتٍ في المنصة) وإرسالات
--      البريد (لا مُرسِل قبل P-C6) — ولهذين يُنشأ العدّاد.
--   2. **مفتاح واحد لكل (منشأة، مقياس، فترة)** بفهرسٍ فريد: الزيادة `ON CONFLICT DO UPDATE`
--      تبقى ذرّية بلا قراءةٍ سابقة، و«الفترة» نصٌّ (`2026-09-17` لليومي، `2026-09` للشهري)
--      فلا حاجة لعمودين ولا لتقويمٍ ثالث يختلف عن تقويم الفاتورة.
--   3. **نفس العزل المعلَن**: `ENABLE`+`FORCE RLS`، وسياسة مستأجر (`app.tenant_id`) وسياسة
--      مشغّل (`app.is_platform_admin`) بنمط 0020، و`WITH CHECK` صريحة في الاثنتين (علّة 0066
--      التي أصلحها P-C2: سياسة قراءةٍ بلا `WITH CHECK` تُرثي `USING` على الإدراج).
--   4. **لا حذف لمستخدم الـAPI.** العدّاد يُصحَّح بالكتابة فوقه، لا بالحذف؛ وهو سجلٌّ يُحتسب
--      عليه العميل فلا يُخفى.
--
-- آمن للإعادة التشغيل: كل عبارة `IF NOT EXISTS` أو `ON CONFLICT`/`DROP POLICY IF EXISTS`،
-- ولا شيء يُحذف أو يُضيّق.

-- =============================================================================
-- 1. usage_counters — العدّاد
-- =============================================================================

CREATE TABLE IF NOT EXISTS usage_counters (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- مفتاح المقياس من فهرس `packages/contracts/src/platform/usage.ts` — نصٌّ لا enum،
  -- فإضافة مقياسٍ في الفهرس لا تحتاج ترحيلاً، والقيد يمنع الفراغ لا التوسّع.
  metric     text NOT NULL,
  -- `2026-09-17` (يومي) أو `2026-09` (شهري) — والفترة تعني «هذه القيمة تخصّ هذه النافذة».
  period     text NOT NULL,
  value      bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_counters_metric_check CHECK (length(btrim(metric)) BETWEEN 1 AND 80),
  CONSTRAINT usage_counters_period_check CHECK (period ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),
  CONSTRAINT usage_counters_value_check CHECK (value >= 0)
);

-- (منشأة، مقياس، فترة) مرة واحدة: هوية الزيادة الذرّية.
CREATE UNIQUE INDEX IF NOT EXISTS usage_counters_scope_key
  ON usage_counters (tenant_id, metric, period);
CREATE INDEX IF NOT EXISTS usage_counters_metric_period_idx
  ON usage_counters (metric, period);
CREATE INDEX IF NOT EXISTS usage_counters_tenant_idx
  ON usage_counters (tenant_id, metric);

-- =============================================================================
-- 2. RLS وأذونات
-- =============================================================================

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON usage_counters;
CREATE POLICY tenant_isolation ON usage_counters
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS platform_admin_plane ON usage_counters;
CREATE POLICY platform_admin_plane ON usage_counters
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

GRANT SELECT, INSERT, UPDATE ON usage_counters TO erp_api;
GRANT ALL PRIVILEGES ON usage_counters TO erp_migrator;

-- =============================================================================
-- 3. سياسة الطائرة الإدارية على الجداول التي يقيسها المشغّل
-- =============================================================================
--
-- ستة مقاييس تُقرأ حيّةً من جداولها، وشبكة اللوحة تقرؤها **عبر كل العملاء** — وهذا قراءةٌ
-- في الطائرة الإدارية. ثلاثة من تلك الجداول (`memberships` · `branches` · `sales_invoices`)
-- لها سياسة `platform_admin_plane` من 0020 و0067، وثلاثة لم تكن لها:
-- **`items` · `files` · `whatsapp_messages`** — ولهذا كانت تُقاس صفراً بلا أن يشتكي شيء:
-- سياسة العزل وحدها تُخفي صفوف العميل عن معاملة المشغّل، والعدّاد يقرأ صفراً بلا خطأ.
-- أمسكها اختبار P-C5 (`platform-usage.spec.ts`) لا المراجعة.
--
-- الإضافة قراءةٌ وكتابةٌ بنفس نمط 0020 حرفياً (و`WITH CHECK` صريحة) لأن أسطح P-C9 (مدير
-- الملفات) تحتاج الكتابة نفسها، ولا معنى لسياسة قراءةٍ فقط هنا.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['items', 'files', 'whatsapp_messages'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_admin_plane ON %I', t);
    EXECUTE format(
      'CREATE POLICY platform_admin_plane ON %I USING (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'') WITH CHECK (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'')',
      t
    );
  END LOOP;
END $$;

ALTER ROLE erp_api NOBYPASSRLS;
