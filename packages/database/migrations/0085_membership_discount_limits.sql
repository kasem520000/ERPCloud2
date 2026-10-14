-- 0085_membership_discount_limits.sql — R1 «مطابقة شاشتي المستخدمين والصلاحيات»
-- (`docs/roadmap/AUDIT_PHASES_01_04.md` §6 · وثيقة المرحلة `docs/desktop-parity/PHASE_01_USERS_NAV.md`).
--
-- عمودان يُنقلان من الديسكتوب بلا جدولٍ جديد:
--
--   الديسكتوب كان يحفظ حدّ الخصم للمستخدم في جدولٍ مستقلّ `OperMaxDiscount(MaxDicount,
--   MaxDicountParcent, emp)`، ويقرأه في `frmUsersPermissions.xaml.cs` (س553–558) عند
--   الحفظ، ويُطبّقه عند البيع. والسحابة تحمل الحدّ **على `memberships`** لا في كيانٍ
--   ثالث: الحدّ صفةٌ من صفات العضوية كالنطاق (`branch_scope`) والأدوار، ولكلّ صفةٍ هنا
--   مسار كتابة واحد (`POST/PATCH /memberships`) ومسار قراءة واحد (`GET /memberships`،
--   `GET /me`). وجدولٌ موازٍ كان يعني مساراً ثانياً يُزامَن مع العضوية في كل تعديل.
--
--   ولماذا العمودان لا رمز صلاحية؟ لأنّ «أعلى قيمة للخصم» **رقمٌ لا حقّ**: رمز الصلاحية
--   يجيب «هل تفعل؟» والحدّ يجيب «إلى أيّ مدى؟». ولذلك يُخزَّن رقمين ويُفحص في الخدمة
--   (`assertDiscountWithinLimit` في `apps/api/src/common/discount-limit.ts`) في مساري
--   كتابة الخصم: فاتورة البيع (إنشاء/تعديل مسودّة) وكاشير نقطة البيع.
--
--   ودلالة `NULL` مقصودة ومختبَرة: `NULL` = بلا حدّ (كل العضويات القائمة اليوم، فلا
--   يتغيّر سلوكها)، و`0` = حدٌّ صريح يمنع أي خصم. والديسكتوب كذلك: مَن لا صفَّ له في
--   `OperMaxDiscount` كان بلا حدّ.
--
-- ولا رمز صلاحية جديد ولا سياسة RLS جديدة: `memberships` محميّ بـ`ENABLE`+`FORCE` منذ
-- `0000_platform_identity.sql`، والعمودان يرثان الحماية نفسها. و`erp_api` يملك UPDATE
-- على الجدول أصلاً (تعديل العضوية)، فلا منح جديد.
--
-- آمن للإعادة التشغيل: `ADD COLUMN IF NOT EXISTS` مع `DROP CONSTRAINT IF EXISTS` قبل
-- كل قيد.

-- =============================================================================
-- 1. العمودان
-- =============================================================================

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS max_discount_pct numeric(7, 4);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS max_discount_amount numeric(20, 4);

-- =============================================================================
-- 2. القيود — الحدّ لا يكون سالباً، والنسبة لا تتجاوز 100
--
-- `CHECK` على `NULL` يمرّ في Postgres (منطق ثلاثي القيم)، وهو المطلوب: `NULL` = بلا حدّ.
-- =============================================================================

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_max_discount_pct_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_max_discount_pct_check
  CHECK (max_discount_pct IS NULL OR (max_discount_pct >= 0 AND max_discount_pct <= 100));

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_max_discount_amount_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_max_discount_amount_check
  CHECK (max_discount_amount IS NULL OR max_discount_amount >= 0);

-- =============================================================================
-- 3. تدقيق — يُثبّت أنّ الحدّ وصل (لا يُبنى عليه منطق، لكنّه يُقرأ في التحقّق الحيّ)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memberships' AND column_name = 'max_discount_pct'
  ) THEN
    RAISE EXCEPTION '0085: memberships.max_discount_pct was not created';
  END IF;
END $$;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
