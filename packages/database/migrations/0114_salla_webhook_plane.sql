-- 0114_salla_webhook_plane.sql
-- AUD-04 (Salla) — الويب هوك طلبٌ عامّ لا يحمل رمز مستخدم ولا سياق مستأجر: يأتي من متجر
-- سلة بتوقيع HMAC فقط. وكود اليوم يقرأ `getTenantContext()` فيرفض الطلب العام قبل أن
-- يصل إلى التحقّق من التوقيع، حتى لو أُعلن المسار عامّاً.
--
-- الحلّ: يبقى المستأجر **مشتقّاً من سجلّ موثوق** — صفّ الاتصال `salla_connections` —
-- لا من جسم الطلب. ولأن قراءة الاتصال بالسياق العام تحتاج مستوى المنصّة، تُضاف سياسة
-- `platform_admin_plane` (نفس نمط 0020) على جدول الاتصالات: قراءةٌ فقط عملياً، داخل
-- معاملة `withPlatformAdminTx`، ويبقى مسار المستأجر العادي (كل مسارات الشاشة) كما هو
-- تحت سياسة العزل الأصلية.

DROP POLICY IF EXISTS platform_admin_plane ON salla_connections;
CREATE POLICY platform_admin_plane ON salla_connections
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

ALTER ROLE erp_api NOBYPASSRLS;
