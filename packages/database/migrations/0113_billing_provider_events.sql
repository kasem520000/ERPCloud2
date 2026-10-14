-- 0113_billing_provider_events.sql
-- AUD-06 — إعادة تسليم حدث Stripe كانت تنفّذ التحديثين نفسيهما مرة أخرى: الأول يلغي
-- الاشتراكات الحيّة، والثاني يفعّل صفاً `incomplete`. وبعد أن صار الصف `active`، تمرّ
-- إعادة التسليم على «إلغاء الحيّ» ثم لا تجد `incomplete` فتُلغى الرخصة النشطة بصمت.
--
-- الحلّ بنيويّ لا شرطيّ:
--   1. جدول أحداث المزوّد بقيود فريدة: `(provider, event_id)` تجعل استقبال الحدث نفسه
--      مرّتين عمليةً ذرّية واحدة (ON CONFLICT DO NOTHING).
--   2. ربط كل حدث اشتراكٍ **واحداً** بهويّته التي أنشأناها (`metadata.subscriptionId`)
--      وبمعرّف جلسة Checkout، فلا يُختار الصف بالمطابقة على tenant/plan وحدها.
--
-- RLS: الأحداث تُكتب من مسار الويب هوك (بلا سياق مستأجر) باسم المنصّة، فتُقرأ بالسياق
-- نفسه. السياسة تسمح بصفٍّ بلا مستأجر عبر `IS NOT DISTINCT FROM` (نفس منطق `audit_log`)،
-- وسياسة `platform_admin_plane` تُطبَّق عند وجود سياق المنصّة.

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES tenant_subscriptions(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_webhook_events_provider_event_key UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_tenant_idx
  ON billing_webhook_events (tenant_id, received_at DESC);

ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON billing_webhook_events;
CREATE POLICY tenant_isolation ON billing_webhook_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS platform_admin_plane ON billing_webhook_events;
CREATE POLICY platform_admin_plane ON billing_webhook_events
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

GRANT SELECT, INSERT ON billing_webhook_events TO erp_api;
GRANT ALL PRIVILEGES ON billing_webhook_events TO erp_migrator;

-- جلسة Checkout الواحدة تُربط بترخيصٍ واحد: القيد الفريد يمنع كتابة المعرّف نفسه على
-- صفّين، وبذلك لا يفعّل حدثٌ متأخّر رخصةً أخرى بالخطأ.
ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS provider_checkout_session_id text;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_checkout_session_key
  ON tenant_subscriptions (provider, provider_checkout_session_id)
  WHERE provider_checkout_session_id IS NOT NULL;

ALTER ROLE erp_api NOBYPASSRLS;
