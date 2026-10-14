-- 0066_platform_settings.sql — P-C1 «الأساس والقشرة، وترميم الصلاحيات»
-- (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4، الجزء P-C1).
--
-- لوحة المنصة لا مقابل لها في `Desktop_ERP`: النسخة المكتبية تخدم شركة واحدة، بلا
-- مشتركين ولا اشتراكات ولا مشغّلين. لذلك تُستبدل بوابة «المصدر بالسطر» هنا ببوابة
-- «المصدر من هذا المستودع» — وهذا الترحيل يبني على ثلاثة أشياء قائمة:
--
--   1. `platform_settings` — الإعدادات التي كانت تُضبط بتحرير `.env` على المضيف.
--      الخطة (§4/‏P-C1) تسمّيها `platform_settings(key, value jsonb, updated_by,
--      updated_at)`؛ وأُضيف إليها **نطاق المستأجر** (`tenant_id` قابل للعدم) لأن
--      P-C2 يحتاج أن يتجاوز المستأجر قيمةً افتراضية بمفتاحه هو، ولسان حال الحقول
--      نفسه يسمح بذلك: صفٌّ بـ`tenant_id IS NULL` = إعداد المنصة، وصفٌّ بـ`tenant_id`
--      = تجاوز منشأةٍ بعينها. فائدةٌ ثانية أنّ الجدول يصبح مؤهَّلاً لسياسة RLS
--      القانونية (`ENABLE` + `FORCE` + سياسة `tenant_id`) بدل استثناءٍ من القاعدة.
--   2. `audit_log` — التدقيق العابر للمستأجرين. الجدول مُنفَّذ بـRLS منذ 0001، وسياسته
--      الوحيدة تتطلب `app.tenant_id`؛ فمشغّل المنصة لا يرى أثر أي عميل. تُضاف هنا
--      سياسة `platform_admin_plane` (نمط 0020 نفسه) **للقراءة فقط**: لا `WITH CHECK`،
--      لأن الكتابة تبقى على مسار المستأجر/المنصة كما كانت.
--   3. الرمز الجديد `console.settings.manage` — كتابة إعدادات المنصة ليست «إدارة
--      مستأجرين»، فمُنح رمزاً خاصاً يُدرَج هنا إدراجاً idempotent كما تُدرَج بقية الرموز
--      (`packages/contracts/src/permissions.ts` هو الإعلان، `platform_roles` هو المنح).
--
-- آمن للإعادة التشغيل: كل عبارة `IF NOT EXISTS` أو `ON CONFLICT`، ولا شيء يُحذف أو
-- يُضيّق.

-- =============================================================================
-- 1. platform_settings — إعدادات المنصة وتجاوزات المستأجرين
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_settings (
  id         uuid PRIMARY KEY,
  -- NULL = إعداد على مستوى المنصة. غير NULL = تجاوز منشأةٍ بعينها (يحتاجه P-C2).
  tenant_id  uuid REFERENCES tenants (id) ON DELETE CASCADE,
  key        text NOT NULL,
  -- القيمة بصيغتها الأصلية: نصٌّ، قائمة نصوص، عدد صحيح، أو نعم/لا.
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    int NOT NULL DEFAULT 1,
  CONSTRAINT platform_settings_key_check CHECK (length(btrim(key)) BETWEEN 1 AND 120)
);

-- `NULLS NOT DISTINCT` (PostgreSQL 15+) يجعل مفتاح المنصة وحيداً مرةً واحدة: المفتاح
-- نفسه لا يُخزَّن مرتين بـ`tenant_id IS NULL`، ويبقى لكل منشأة صفُّها الخاص.
CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_scope_key
  ON platform_settings (key, tenant_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS platform_settings_tenant_idx ON platform_settings (tenant_id, key);

-- =============================================================================
-- 2. RLS — القانون نفسه الذي تحمله كل الجداول ذات النطاق
-- =============================================================================

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings FORCE ROW LEVEL SECURITY;

-- سياسة العزل: جلسة المستأجر ترى صفّها فقط. صفوف المنصة (`tenant_id IS NULL`) لا
-- تطابقها أبداً، وهذا هو الفشل الآمن المقصود.
DROP POLICY IF EXISTS platform_settings_tenant_isolation ON platform_settings;
CREATE POLICY platform_settings_tenant_isolation ON platform_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- سياسة مشغّل المنصة (نمط 0020): قراءة وكتابة داخل معاملة تربط `app.is_platform_admin`.
DROP POLICY IF EXISTS platform_admin_plane ON platform_settings;
CREATE POLICY platform_admin_plane ON platform_settings
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- =============================================================================
-- 3. التدقيق العابر للمستأجرين — قراءة فقط
-- =============================================================================

DROP POLICY IF EXISTS platform_admin_plane ON audit_log;
CREATE POLICY platform_admin_plane ON audit_log
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- =============================================================================
-- 4. الصلاحيات والمنح
-- =============================================================================

INSERT INTO permissions (code, module, description) VALUES
  ('console.settings.manage', 'console',
   'Read and write the platform settings (support contacts, service domains, default limits, maintenance switch).')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_settings TO erp_api;
GRANT ALL PRIVILEGES ON platform_settings TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — re-asserted on every migration run.
ALTER ROLE erp_api NOBYPASSRLS;
