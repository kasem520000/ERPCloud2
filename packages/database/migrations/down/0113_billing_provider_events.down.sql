-- Rollback for 0113 — يعيد الحالة السابقة بدقّة: لا يُحذف صفّ بيانات قائم، والقيد الفريد
-- على جلسة Checkout يُرفع قبل العمود. سجلّ الأحداث نفسه بيانات تدقيق (مَن استُقبل ومتى)،
-- فلا يُحذف إلا بخطة استعادة/احتفاظ معلنة (CMP-03).
DROP INDEX IF EXISTS tenant_subscriptions_checkout_session_key;

ALTER TABLE tenant_subscriptions
  DROP COLUMN IF EXISTS provider_checkout_session_id;

REVOKE ALL PRIVILEGES ON billing_webhook_events FROM erp_api;
DROP TABLE IF EXISTS billing_webhook_events;
