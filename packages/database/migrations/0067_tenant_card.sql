-- 0067_tenant_card.sql — P-C2 «العملاء في العمق»
-- (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4، الجزء P-C2).
--
-- الخطة قالت عن هذا الجزء: «يُكتفى بـ0066 (الإعدادات) + `tenant_settings` القائم للرايات
-- (`feature.*`)». الإعدادات والرايات فعلاً لا تحتاج جدولاً جديداً — لكن ثلاث حاجات ظهرت
-- بالقياس على قاعدة حقيقية، وكلٌّ منها يمنع جزءاً من بطاقة العميل من العمل:
--
--   1. **الملاحظات** (`GET/POST /platform/tenants/:id/notes`) لا جدول لها في المستودع.
--      لا يمكن تخزينها في `platform_settings` بلا كسر وحدة المفتاح الواحد (كل ملاحظة صفٌّ
--      له مؤلّف وتاريخه، لا قيمةٌ لمفتاح)، ولا في `tenants.meta` (بلا مؤلّف ولا تدقيق).
--      فتُنشأ `tenant_notes` بقاعدة RLS القانونية نفسها.
--   2. **الرايات** (`feature.pos`, `feature.hrm`, …) تعيش في `tenant_settings`، وهذا
--      الجدول يحمل سياسة العزل وحدها (`0000_platform_identity.sql` L209). أي أن مشغّل
--      المنصة يقرأ صفر صفوف ويحدّث صفر صفوف: قراءةٌ صامتة كاذبة. تُضاف سياسة
--      `platform_admin_plane` (نمط 0020) فتصير راية العميل قابلة للقراءة والكتابة من
--      اللوحة — ولا تتغيّر حماية المستأجر نفسه: السياستان PERMISSIVE وتُجمعان بـOR.
--   3. **الاستخدام والصحة** يعدّان فواتير العميل (`sales_invoices`) ومهام الطابور
--      (`outbox_jobs`). الجدولان كذلك بسياسة العزل وحدها، فكانت `/platform/jobs/outbox`
--      التي أضافها P-C1 تُعيد صفر صفوف **دائماً** — علّة حقيقية في P-C1 لا في P-C2،
--      تُصلَح هنا ويكتب لها اختبار: مهمة عميلٍ ما يجب أن تظهر للمشغّل.
--
-- آمن للإعادة التشغيل: كل عبارة `IF NOT EXISTS` أو `DROP POLICY IF EXISTS`، ولا شيء
-- يُحذف أو يُضيّق.

-- =============================================================================
-- 1. tenant_notes — ملاحظات المشغّلين على العميل
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_notes (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- نصّ الملاحظة كما كتبه مشغّل المنصة.
  body           text NOT NULL,
  author_user_id uuid,
  -- اسم المؤلف كما يجب أن يظهر في الشاشة بعد حذف المستخدم أو تغيير اسمه.
  author_label   text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        int NOT NULL DEFAULT 1,
  CONSTRAINT tenant_notes_body_check CHECK (length(btrim(body)) BETWEEN 3 AND 4000)
);

CREATE INDEX IF NOT EXISTS tenant_notes_tenant_idx
  ON tenant_notes (tenant_id, created_at DESC);

ALTER TABLE tenant_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_notes;
CREATE POLICY tenant_isolation ON tenant_notes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ملاحظات المنصة عن عميل هي بطبيعتها خارج نطاق العميل: لا يُقصد أن يقرأها، ولا أن
-- يعرف أنها كُتبت. مشغّل المنصة وحده يراها.
DROP POLICY IF EXISTS platform_admin_plane ON tenant_notes;
CREATE POLICY platform_admin_plane ON tenant_notes
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- =============================================================================
-- 2. أثر المشغّل على سجل العميل — كتابة داخل مستوى المنصة
-- =============================================================================

-- 0066 أضاف `platform_admin_plane` على `audit_log` **للقراءة فقط** (بلا `WITH CHECK`).
-- لكن `tenant_isolation` تفرض على الإدراج شرط
-- `tenant_id IS NOT DISTINCT FROM nullif(app.tenant_id,'')::uuid` — وفي معاملة المنصة
-- تكون `app.tenant_id` غير مضبوطة (NULL)، فلا يُقبل إلا صفٌّ بـ`tenant_id IS NULL`.
-- أي أن تعليق عميل من اللوحة كان سيُدوَّن كحدث منصة بلا عميل، أو يفشل الإدراج.
-- والسلوك الصحيح أن يُقرأ أثر تعليق العميل على **سجل العميل نفسه** أيضاً: يُعاد إنشاء
-- السياسة مع `WITH CHECK`. الجدول append-only (`REVOKE UPDATE, DELETE … FROM erp_api`)،
-- فالتوسيع يسمح بالإضافة لا بالتحريف.
DROP POLICY IF EXISTS platform_admin_plane ON audit_log;
CREATE POLICY platform_admin_plane ON audit_log
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- =============================================================================
-- 3. رايات الميزات — قراءة وكتابة من اللوحة
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings TO erp_api;

DROP POLICY IF EXISTS platform_admin_plane ON tenant_settings;
CREATE POLICY platform_admin_plane ON tenant_settings
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- =============================================================================
-- 4. الاستخدام والصحة — الفواتير والطابور عبر كل العملاء
-- =============================================================================

GRANT SELECT ON sales_invoices TO erp_api;
GRANT SELECT ON outbox_jobs TO erp_api;

-- قراءة فقط: كتابة الفواتير تبقى على مسار المستأجر وحده (سياسة العزل)، فالمنصة ترى
-- استهلاك العميل ولا تُعدّل دفتره.
DROP POLICY IF EXISTS platform_admin_plane ON sales_invoices;
CREATE POLICY platform_admin_plane ON sales_invoices
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS platform_admin_plane ON outbox_jobs;
CREATE POLICY platform_admin_plane ON outbox_jobs
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- مهام الطابور تُقرأ وتُعاد المحاولة من اللوحة في P-C9؛ الاستخدام هنا قراءةٌ وعدٌّ فقط.
ALTER TABLE tenant_notes OWNER TO erp_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_notes TO erp_api;
GRANT ALL PRIVILEGES ON tenant_notes TO erp_migrator;

GRANT ALL PRIVILEGES ON tenant_settings TO erp_migrator;
GRANT ALL PRIVILEGES ON sales_invoices TO erp_migrator;
GRANT ALL PRIVILEGES ON outbox_jobs TO erp_migrator;

-- =============================================================================
-- 5. ترميم سياسات العزل: `''::uuid` يقتل مستوى المنصة
-- =============================================================================

-- العلّة الحقيقية التي كشفها P-C2 أثناء التشغيل الحيّ (لا في الاختبارات):
--
--   سياساتٌ كثيرة في المستودع تكتب الشرط هكذا:
--       USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
--   بينما الهيئة القانونية (المستعملة في 0000 و0002 و0020 وما بعدهما) هي:
--       USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
--
-- فرقٌ لا يظهر في جلسة مستأجر أبداً، لأن GUC مضبوط بـuuid صحيح. لكن **معامل الجلسة لا
-- يعود NULL بعد أن يُضبط مرةً ويُصفَّر**: داخل معاملة المستأجر يُضبط بـ`set_config(…, true)`
-- ثم بعد الالتزام تعيد قراءته `current_setting(…, true)` كـ**نصٍّ فارغ** لا كـNULL. وعلى
-- تجميعة اتصالات مُعادة الاستعمال (أي على خادم حقيقي)، تصبح قراءة المنصة لهذه الجداول:
--
--       ''::uuid  →  ERROR: invalid input syntax for type uuid: ""
--
-- أي أن كل قراءة عابرة للمستأجرين تمرّ بجدول منها تفشل بـ500 **بشكل متقطّع**: تعمل على
-- اتصال جديد وتفشل على اتصال سبقه طلب مستأجر. لهذا لم تُمسكها الاختبارات (كل متصفّح
-- اختبار يشغّل مجموعةً معزولة)، ولم تُمسك في P-C1 (جداوله كلها بـ`nullif`)، وظهرت هنا في
-- `sales_invoices` و`memberships`… عند أول قراءة حقيقية من اللوحة.
--
-- الإصلاح: تُستبدل كل سياسة تحمل النمط القديم بنظيره القانوني عبر `ALTER POLICY` —
-- يحفظ الأمر الأمر (`FOR …`) والأدوار والنمط (`AS PERMISSIVE`) كما هي، فلا تتغيّر حماية
-- أي مستأجر: `nullif` تزيد حالة واحدة فقط (GUC غير مضبوط ⇒ NULL ⇒ لا صفوف)، وهي بالضبط
-- حالة مستوى المنصة التي تتولّاها سياسات `platform_admin_plane`.
DO $$
DECLARE
  policy record;
  fixed_qual text;
  fixed_check text;
  repaired int := 0;
BEGIN
  FOR policy IN
    SELECT tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE (qual LIKE '%current_setting(''app.tenant_id''%' AND qual NOT ILIKE '%nullif%')
        OR (with_check LIKE '%current_setting(''app.tenant_id''%' AND with_check NOT ILIKE '%nullif%')
  LOOP
    -- الشكل الذي يعيده pg_policies على PostgreSQL 15+ يستعمل `::text`؛ والنمط الثاني
    -- احتياطٌ لنسخة تُعيد النداء بلا صبغة.
    fixed_qual := regexp_replace(
      policy.qual,
      'current_setting\(''app\.tenant_id''(::text)?, true\)',
      'NULLIF(current_setting(''app.tenant_id''\1, true), '''')',
      'g'
    );

    IF policy.with_check IS NOT NULL THEN
      fixed_check := regexp_replace(
        policy.with_check,
        'current_setting\(''app\.tenant_id''(::text)?, true\)',
        'NULLIF(current_setting(''app.tenant_id''\1, true), '''')',
        'g'
      );
      EXECUTE format('ALTER POLICY %I ON %I USING (%s) WITH CHECK (%s)',
                     policy.policyname, policy.tablename, fixed_qual, fixed_check);
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I USING (%s)',
                     policy.policyname, policy.tablename, fixed_qual);
    END IF;
    repaired := repaired + 1;
  END LOOP;

  RAISE NOTICE 'RLS nullif repair: % policies rewritten', repaired;
END $$;

-- حزام أمان: بعد الترميم لا يجوز أن يبقى سياسةٌ واحدة بالنمط القديم. إن بقيت، يفشل
-- الترحيل بدل أن يترك العلّة صامتة.
DO $$
DECLARE
  offenders int;
BEGIN
  SELECT count(*) INTO offenders
    FROM pg_policies
   WHERE (qual LIKE '%current_setting(''app.tenant_id''%' AND qual NOT ILIKE '%nullif%')
      OR (with_check LIKE '%current_setting(''app.tenant_id''%' AND with_check NOT ILIKE '%nullif%');
  IF offenders > 0 THEN
    RAISE EXCEPTION 'RLS nullif repair incomplete: % policies still cast an empty app.tenant_id', offenders;
  END IF;
END $$;

-- PROJECT_CONTRACT §13.4 — re-asserted on every migration run.
ALTER ROLE erp_api NOBYPASSRLS;
