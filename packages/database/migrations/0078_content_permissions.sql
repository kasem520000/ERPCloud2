-- 0078_content_permissions.sql — P-M5 «نظام إدارة المحتوى».
--
-- ترحيلٌ **بلا جدول**: الجداول الخمسة بنيت في `0077_content.sql`، وهذا الملف يُدرج رمزَي
-- اللوحة فقط — والقاعدة الملزمة في هذا المستودع (README §4 بوابة 5) توجب أن كل رمز
-- `console.*` يُعلَن في `packages/contracts/src/permissions.ts` **ويُدرَج في ترحيل**، فكان
-- الفصل بين الملفين ترتيبياً لا وظيفياً: بنية البيانات في 0077، والصلاحيات في 0078 — حتى
-- يبقى كل ملفٍ وحيد الفكرة.
--
-- ولماذا رمزان لا رمز؟
--   * `console.content.view` — قراءة الصفحات **والمسوّدات**. وهي الفرق عن الواجهة العامة:
--     العامّ يرى المنشور وحده، ومن يملك هذا الرمز يرى ما لم يُنشر بعد.
--   * `console.content.manage` — الكتابة والنشر والجدولة والسحب والاستعادة.
-- الفصل مقصود: مراجعةٌ لغوية تُقرأ قبل النشر بلا أن تملك النشر، والمدقّق يقرأ المحتوى بلا
-- أن يستطيع تغيير كلمةٍ منه.

INSERT INTO permissions (code, module, description) VALUES
  ('console.content.view', 'console',
   'Read marketing content pages, drafts, menus and banners.'),
  ('console.content.manage', 'console',
   'Write, publish, schedule, retract and restore marketing content pages, menus and banners.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
