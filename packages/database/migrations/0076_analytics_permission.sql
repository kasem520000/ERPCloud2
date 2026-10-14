-- P-C12 — التحليلات (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
--
-- ترحيلٌ بلا جدول — كما قالت الخطة حرفياً («ترحيل: — (يقرأ القائم + عدّادات P-C5)»). وهذا
-- الجزء كله **قراءة**: لا يكتب صفّاً واحداً في أي جدول، ولا يضيف عموداً ولا فهرساً. والقاعدة
-- الملزمة في هذا المستودع (README §4 بوابة 5) توجب أن **كل رمز `console.*` يُعلَن في
-- `packages/contracts/src/permissions.ts` ويُدرَج إدراجاً idempotent في ترحيل** — فالاستثناء
-- الوحيد هنا هو الإدراج نفسه.
--
-- ولماذا رمزٌ بصيغة `view` لا `manage`؟ لأن هذه الوحدة لا تملك مساراً يغيّر شيئاً: كل نهاياتها
-- `GET`، وحتى ملف الـCSV يُبنى في الذاكرة ويُرسل. فصلُ الرمز عن `manage` يقول ذلك صراحةً في
-- جدول الصلاحيات بدل أن يُترك للقارئ أن يستنتجه من الكود.

INSERT INTO permissions (code, module, description) VALUES
  ('console.analytics.view', 'console',
   'Read platform analytics: MRR, churn, activation funnel, cohorts, trial conversion and usage per plan.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
