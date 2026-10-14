-- Down for 0066_platform_settings.sql — P-C1 «الأساس والقشرة».
--
-- ما الذي يُفقد: إعدادات المنصة الثمانية إن كتبها المشغّل (بريد الدعم، هاتفه، النطاقات،
-- الحدود الافتراضية الثلاثة، مفتاح الصيانة ورسالته)، والقراءة العابرة للمستأجرين على
-- `audit_log`. أي أنّ اللوحة تعود إلى ما كانت عليه: إعدادات في `.env`، وسجلّ تدقيق
-- محصور بالمستأجر الحالي.
--
-- ما الذي يبقى: جداول `audit_log` و`permissions` و`platform_roles` كما هي، ورمز
-- `console.settings.manage` مُعلَناً في `@erp/contracts` (إعلانٌ في الكود لا يضره بقاء
-- صفٍّ في جدول الرموز)، وكل ما بنته الترحيلات السابقة. لا شيء مما سبق هذا الترحيل
-- يُحذف: `platform_settings` جدولٌ جديد، والسياسة أدناه مضافة.

DROP POLICY IF EXISTS platform_admin_plane ON audit_log;

DROP TABLE IF EXISTS platform_settings;

DELETE FROM permissions WHERE code = 'console.settings.manage';
