-- 0087_pos_holds_cashier.sql — R4 «إكمال نقطة البيع» (`docs/roadmap/AUDIT_PHASES_01_04.md` §6،
-- وثيقة المرحلة `docs/desktop-parity/PHASE_04_POS_SHIFTS.md` §R4).
--
-- يُضيف شيئين، وكلٌّ منهما له أصلٌ في نافذةٍ مكتبية:
--
--   1. **`sales_invoices.cashier_id`** — الديسكتوب يخزّن الموظف على كل حركة
--      (`Entry.emp`, يُقرأ في `frmPOS.xaml.cs` عند كتابة الفاتورة)، ووردية الإغلاق تحمل
--      `CasherClosed.UserId`. والسحابة كان عندها `created_by` وحده: يقول مَن كتب الصفّ
--      لا مَن كان على الصندوق، وهما يفترقان حين ينوب مشرف عن كاشير داخل وردية الكاشير.
--      ولا `NOT NULL` ولا `RESTRICT`: المستخدمون يُؤرشَفون، وتاريخ المبيعات لا يُمنع من
--      الإشارة إليهم — `SET NULL` تحفظ الفاتورة وتفقد الاسم، كما في `shift_id` (0033).
--
--   2. **`pos_holds`** — «تعليق الفواتير» في `frmPOS.xaml.cs` L1871–L1962: ٩ أزرار
--      (`HoldList = new int[9]`، L179) تُملأ من الفواتير المعلّقة، والضغط على زرٍّ فارغ
--      يشتكي «لقد وصلت للحد الاقصي من عمليات الايقاف المؤقت» (L1935).
--
--      والديسكتوب يحفظ المعلّق **فاتورةً حقيقية** (`inv_type=3, proc_type=3, IS_Deleted=0`،
--      L1882–L1884) فيبقى للمعلّق رقمٌ في السلسلة ويظهر في التقارير قبل أن يُدفع. والسحابة
--      لا تكرّر ذلك: رقمُ الفاتورة يُمنح عند الترحيل (`sequences` في `postInTx`)، ولو كتبنا
--      المعلّق فاتورةً لظهر في دفتر المبيعات بيعٌ لم يقع. فالجديد يحمل **السلة** كما كتبها
--      الكاشير (`cart` jsonb) ومجموعَها التقريبي (`total`) وعددَ سطورها (`lines_count`) —
--      بياناتُ شاشةٍ لا مستند، تُمسح إذا لم تُستَرجع. ولا ضريبة ولا تكلفة ولا قيد هنا.
--
--      والخانة فريدة لكل كاشير في الفرع (`pos_holds_slot_key`)، فزرٌّ واحد لا يحمل
--      سلّتين، ومحاولة الكتابة في خانةٍ مشغولة تحدّثها — كما يفعل الديسكتوب حين يكتب في
--      `HoldList[holdSlot]`.
--
--      و`user_id` بلا مفتاح أجنبي: المستخدم قد يُؤرشَف ويبقى معلّقُه قابلاً للاسترجاع
--      لصاحبه، والصفوف تُفلتَر بالخانة والفرع والمستخدم الثلاثة معاً في الخدمة.
--
-- آمن للإعادة التشغيل: `IF NOT EXISTS` على كل عمود/جدول/فهرس، و`DROP … IF EXISTS` على
-- السياسة قبل إنشائها.

-- =============================================================================
-- 1. عمود الكاشير
-- =============================================================================

ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS cashier_id uuid;

-- القيد يُضاف منفصلاً حتى يُصحّح تشغيلٌ سبق أن أنشأ العمود بلا قيد.
ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_cashier_id_fkey;
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_cashier_id_fkey
  FOREIGN KEY (cashier_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sales_invoices_cashier_idx
  ON sales_invoices(tenant_id, cashier_id);

-- =============================================================================
-- 2. خانات التعليق
-- =============================================================================

CREATE TABLE IF NOT EXISTS pos_holds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  slot int NOT NULL CHECK (slot >= 0 AND slot <= 8),
  label text,
  cart jsonb NOT NULL DEFAULT '{}',
  total numeric(20,4) NOT NULL DEFAULT 0,
  lines_count int NOT NULL DEFAULT 0,
  held_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  legacy_source text,
  legacy_id text
);

-- زرٌّ واحد لكل كاشير في الفرع — والفرع في المفتاح لأن كاشيرين في فرعين مختلفين
-- لكلٍّ منهما «الخانة ١» بلا تعارض.
CREATE UNIQUE INDEX IF NOT EXISTS pos_holds_slot_key
  ON pos_holds(tenant_id, branch_id, user_id, slot);
CREATE INDEX IF NOT EXISTS pos_holds_scope_idx ON pos_holds(tenant_id, branch_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_invoices' AND column_name = 'cashier_id'
  ) THEN
    NULL;
  ELSE
    RAISE EXCEPTION '0087: sales_invoices.cashier_id was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pos_holds') THEN
    RAISE EXCEPTION '0087: pos_holds was not created';
  END IF;
END $$;

-- الحماية كما في بقية جداول المستأجر: RLS مفروضة، وسياسةُ العزل **بصيغتها بعد 0067** —
-- أي `nullif(current_setting('app.tenant_id', true), '')`: الاتصال المُجمَّع يعيد `''`
-- بعد أن يخدم معاملة مستأجر، و`''::uuid` يرمي `invalid input syntax for type uuid`.
-- و`0015` (المصدر) قديمٌ يسبق 0067، فنسخُ نصّه حرفياً هو ما كشفه
-- `platform-tenants.spec.ts` «leaves no RLS policy casting an empty app.tenant_id to uuid».
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pos_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t, t);
  END LOOP;
END $$;

-- الملّاك الوحيد للحذف هو الكاشير نفسه (إفراغٌ أو استرجاع)، والمنح يتبع ذلك:
-- `ALTER DEFAULT PRIVILEGES` في 0000 يمنح DELETE لأي جدولٍ جديد، وهو المطلوب هنا.
GRANT SELECT, INSERT, UPDATE, DELETE ON pos_holds TO erp_api;
GRANT ALL PRIVILEGES ON pos_holds TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
