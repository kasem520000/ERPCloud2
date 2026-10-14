-- Down for 0067_tenant_card.sql — P-C2 «العملاء في العمق».
--
-- ما الذي يُفقد: ملاحظات المشغّلين على العملاء (`tenant_notes`) كلها، والسياسات التي
-- جعلت اللوحة تقرأ رايات العميل (`tenant_settings`) واستهلاكه (`sales_invoices`) ومهام
-- الطابور (`outbox_jobs`) عبر المستأجرين.
--
-- ما الذي يبقى: تجاوزات الإعدادات التي كتبها المشغّل للعميل (صفوف `platform_settings`
-- بـ`tenant_id` غير فارغ) — تُكتب بـP-C2 عبر `PUT /platform/tenants/:id/settings/:key`،
-- وتبقى في الجدول الذي بناه 0066؛ وحذف هذا الترحيل لا يحذفها. كذلك تبقى رايات
-- `tenant_settings` التي فعّلها المشغّل: الحذف هنا يمنع اللوحة من قراءتها، لا يمحوها.
--
-- ملاحظة تشغيلية: بعد هذا التراجع تعود `/platform/jobs/outbox` (من P-C1) إلى إعادة صفر
-- صفوف دائماً، وهي العلّة التي أصلحها `platform_admin_plane` على `outbox_jobs`.

-- يُعاد `platform_admin_plane` على `audit_log` إلى نسخة 0066 (قراءة فقط، بلا WITH CHECK).
DROP POLICY IF EXISTS platform_admin_plane ON audit_log;
CREATE POLICY platform_admin_plane ON audit_log
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS platform_admin_plane ON outbox_jobs;
DROP POLICY IF EXISTS platform_admin_plane ON sales_invoices;
DROP POLICY IF EXISTS platform_admin_plane ON tenant_settings;

DROP POLICY IF EXISTS platform_admin_plane ON tenant_notes;
DROP POLICY IF EXISTS tenant_isolation ON tenant_notes;
DROP TABLE IF EXISTS tenant_notes;
