-- Down for 0068_platform_billing.sql — P-C4 «الباقات والتراخيص والفوترة».
--
-- ما الذي يُفقد: فواتير المنصة على عملائها وسطورها، وسجلّ التحصيل، ومحاولات المتابعة، وحقوق
-- الباقات، وتسلسل أرقام الفواتير — كلها بيانات P-C4 وحدها، لا يقرأها سطحٌ آخر بعد.
--
-- ما الذي يبقى: الباقات (`billing_plans`) والتراخيص (`tenant_subscriptions`) وطلبات التفعيل
-- (`activation_requests`) كما أنشأها 0019 — الحذف هنا يزيل الأعمدة والحالات التي أضافها
-- P-C4 فقط، ولا يحذف صفًّا واحداً. وتراخيص بحالة `trialing` أو `paused` أو `expired` تعود
-- `pending` **قبل** إعادة قيد الحالة القديم، وإلّا فشل الترحيل العكسي على صفٍّ قائم.
--
-- ملاحظة تشغيلية: بعد هذا التراجع تعود `/plans` بلا حقوق (لا جدول لها)، و`/invoices` و
-- `/dunning` و`/revenue` تفشل — فهي أسطح P-C4 كلها.

-- =============================================================================
-- 1. الحالات والأعمدة المضافة إلى التراخيص
-- =============================================================================

ALTER TABLE tenant_subscriptions DROP CONSTRAINT IF EXISTS tenant_subscriptions_status_check;
UPDATE tenant_subscriptions
   SET status = 'pending'
 WHERE status IN ('trialing', 'paused', 'expired');
ALTER TABLE tenant_subscriptions
  ADD CONSTRAINT tenant_subscriptions_status_check
  CHECK (status IN ('pending', 'active', 'past_due', 'canceled', 'incomplete'));

DROP INDEX IF EXISTS tenant_subscriptions_active_tenant_key;

ALTER TABLE tenant_subscriptions
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS paused_at,
  DROP COLUMN IF EXISTS resumed_at,
  DROP COLUMN IF EXISTS cancel_at_period_end,
  DROP COLUMN IF EXISTS canceled_reason,
  DROP COLUMN IF EXISTS billing_email,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS updated_by;

-- =============================================================================
-- 2. جداول الفوترة الأربعة + التسلسل + الحقوق
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON dunning_attempts;
DROP POLICY IF EXISTS platform_admin_plane ON dunning_attempts;
DROP TABLE IF EXISTS dunning_attempts;

DROP POLICY IF EXISTS tenant_isolation ON platform_payments;
DROP POLICY IF EXISTS platform_admin_plane ON platform_payments;
DROP TABLE IF EXISTS platform_payments;

DROP POLICY IF EXISTS tenant_isolation ON platform_invoice_lines;
DROP POLICY IF EXISTS platform_admin_plane ON platform_invoice_lines;
DROP TABLE IF EXISTS platform_invoice_lines;

DROP POLICY IF EXISTS tenant_isolation ON platform_invoices;
DROP POLICY IF EXISTS platform_admin_plane ON platform_invoices;
DROP TABLE IF EXISTS platform_invoices;

DROP POLICY IF EXISTS platform_admin_plane ON platform_invoice_sequences;
DROP TABLE IF EXISTS platform_invoice_sequences;

DROP POLICY IF EXISTS billing_plan_entitlements_readable ON billing_plan_entitlements;
DROP TABLE IF EXISTS billing_plan_entitlements;
