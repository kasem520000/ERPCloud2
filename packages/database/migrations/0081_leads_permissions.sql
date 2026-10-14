-- 0081_leads_permissions.sql — P-M6 «التقاط العملاء المتوقّعين وإدارتهم».
--
-- ترحيلٌ **بلا جدول**: الجداول الأربعة بنيت في `0080_leads.sql`، وهذا الملف يُدرج رمزَي
-- اللوحة فقط — والقاعدة الملزمة في هذا المستودع (README §4 بوابة 5) توجب أن كل رمز
-- `console.*` يُعلَن في `packages/contracts/src/permissions.ts` **ويُدرَج في ترحيل**.
--
-- ولماذا رمزان لا رمز؟
--   * `console.leads.view` — قراءة الطلب وملاحظاته وأثره، وقراءة المشتركين في النشرة.
--   * `console.leads.manage` — الإسناد وتغيير الحالة والملاحظات و**التحويل إلى منشأة**.
-- التحويل هو الفعل الأخطر: يُنشئ مستأجراً ومديراً وترخيصاً بتجربة — أي يفتح باباً إلى النظام.
-- فمن يجيب على الاستفسار (الدعم) يقرأ، ومن يقرّر التحويل (المالك والفوترة) يملك — ولا يُمنح
-- التحويل لرقيبٍ ولا لتشغيلٍ لا يوقّعان على ترخيص.

INSERT INTO permissions (code, module, description) VALUES
  ('console.leads.view', 'console',
   'Read leads, their notes, their timeline and newsletter subscribers.'),
  ('console.leads.manage', 'console',
   'Assign leads, change their status, write notes, convert a lead into a tenant, and manage subscribers.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
