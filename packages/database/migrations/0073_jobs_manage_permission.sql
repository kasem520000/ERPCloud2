-- P-C9 — العمليات (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
--
-- ترحيلٌ بلا جدول: هذا الجزء لا يضيف بيانات، بل يضيف **صلاحية**. وهي إضافةٌ لا زخرفة:
--
--   * قبل P-C9 كان سطح الطابور قراءةً فقط، و`console.jobs.view` تكفي لفتح `/jobs`.
--   * وبعدها صار للّوحة فعلان يغيّران ما سيراه العميل: **إعادة محاولة** مهمّة فشلت،
--     و**إلغاء** مهمّة لن تُنفَّذ. ومن يقرأ الطابور (مدقّق المنصة) ليس من يجب أن يُعيد
--     تشغيله — فالفصل هنا هو الفرق بين تقريرٍ وقرار.
--
-- والقاعدة الملزمة في هذا المستودع (README §4 بوابة 5): كل رمز `console.*` يُعلَن في
-- `packages/contracts/src/permissions.ts`، ويُدرَج إدراجاً idempotent في ترحيل، وتُمنح في
-- `rbac.ts` لمن يملكها. هذا الملف يفعل الثاني، و`permissions.spec.ts` هو من يتحقّق من
-- التطابق في مجموعة الاختبارات.

INSERT INTO permissions (code, module, description) VALUES
  ('console.jobs.manage', 'console',
   'Retry or cancel background jobs in the platform outbox.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
