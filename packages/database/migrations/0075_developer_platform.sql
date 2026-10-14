-- P-C11 — بوابة المطوّر (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
--
-- ثلاثة جداول كما نصّت الخطة: `api_keys` · `webhook_endpoints` · `webhook_deliveries`.
-- ورقم الملف **0075** لا 0073: الرقم الذي في الخطة أُخذ قبل هذا الجزء (0073 لـP-C9،
-- و0074 لـP-C10) — والقاعدة في هذا المستودع أن الرقم لا يُعاد.
--
-- وقراران يُقرآن من التعريفات نفسها:
--
--   1. **المفتاح لا يُخزَّن نصّاً.** المحفوظ `prefix` (للقراءة في السجلّات) و`hash`
--      (SHA-256 على النصّ كاملاً). والبحث عند الطلب يمرّ بالـ`prefix` أولاً — فهو فهرسٌ
--      فريد لا يمسح الجدول. فحتى تسريب نسخة القاعدة لا يعطي مفتاحاً يعمل.
--   2. **التسليم صفٌّ مستقل عن المحاولة.** `webhook_deliveries` يحمل الحمولة والنتيجة
--      والمحاولات؛ ولا يُحذف صفٌّ منه بحذف العنوان (`ON DELETE CASCADE` على العنوان مقصود:
--      حذفُ العنوان يعني «لا أريد هذا التكامل» — فلا معنى لإيصالاتِ تسليمٍ لا مستلِمَ لها).

-- -----------------------------------------------------------------------------
-- 1. api_keys — مفتاح تكاملٍ لمستأجر واحد
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id              uuid PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name            text        NOT NULL CHECK (length(name) BETWEEN 3 AND 60),
  -- `erp_live_ab12cd34` — أول 17 محرفاً من المفتاح، يُعرض في الشاشة ويُقرأ في السجلّات.
  key_prefix      text        NOT NULL UNIQUE CHECK (key_prefix LIKE 'erp_live_%'),
  -- SHA-256 للنصّ كاملاً (hex). لا `secret` ولا `encrypted` — لا نُخزّن ما لا نحتاج قراءته.
  key_hash        text        NOT NULL CHECK (length(key_hash) = 64),
  -- النطاقات المسموحة: قدراتٌ على موارد المستأجر، وتُقرأ في الحارس عند كل طلب.
  scopes          text[]      NOT NULL CHECK (array_length(scopes, 1) BETWEEN 1 AND 8),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at      timestamptz,
  last_used_at    timestamptz,
  last_used_ip    text,
  revoked_at      timestamptz,
  revoked_reason  text        CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 5 AND 200),
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  rotated_from    uuid        REFERENCES api_keys (id) ON DELETE SET NULL,
  -- الإبطال له وقتٌ وسبب؛ والمفتاح النشط لا يحمل أياً منهما.
  CONSTRAINT api_keys_revocation_check CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id, created_at DESC);
-- فهرسٌ جزئي للتحقّق السريع: البحث عند كل طلبٍ به مفتاح لا يرى إلا المفاتيح الحيّة.
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (key_prefix) WHERE status = 'active';

-- سجلّ استخدامٍ مختصر: من استعمل المفتاح، ومتى، ومن أي عنوان، وماذا ردّ عليه الخادم.
-- ولا يُخزَّن فيه نصّ طلب ولا جسمه — العدد والزمن يكفيان للإجابة عن «هل ما زال مستعملاً؟».
CREATE TABLE IF NOT EXISTS api_key_uses (
  id            bigserial PRIMARY KEY,
  api_key_id    uuid        NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  method        text        NOT NULL,
  path          text        NOT NULL CHECK (length(path) <= 200),
  status_code   integer,
  ip            text
);

CREATE INDEX IF NOT EXISTS api_key_uses_key_idx ON api_key_uses (api_key_id, at DESC);

-- -----------------------------------------------------------------------------
-- 2. webhook_endpoints — عنوانٌ يُخبَر، وأحداثٌ اشترك بها
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id              uuid PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  url             text        NOT NULL CHECK (length(url) BETWEEN 12 AND 500),
  -- الأحداث المشترَك بها: مفاتيحها من كتالوج العقود، والقيد يمنع صفّاً فارغاً.
  events          text[]      NOT NULL CHECK (array_length(events, 1) BETWEEN 1 AND 12),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- السرّ بحالتين: `prefix` يُعرض، والنصّ الكامل **مشفَّراً** لا مُجزَّأً.
  -- والفرق عن مفتاح الـAPI مقصود: السرّ يجب أن يُقرأ لحظة التوقيع (لا يُقارن فقط)،
  -- فهو يُخزَّن مشفَّراً بمغلّف `v1:` (`platform/auth/secret-box.ts`، مفتاح `DATA_ENC_KEY`)
  -- لا مُجزَّأً.
  secret_prefix   text        NOT NULL,
  secret_enc      text        NOT NULL,
  secret_set_at   timestamptz NOT NULL DEFAULT now(),
  description     text        CHECK (description IS NULL OR length(description) BETWEEN 3 AND 200),
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id, created_at DESC);
-- فهرسٌ جزئي: الإرسال يسأل «من يشترك بهذا الحدث وهو حيّ؟» فقط.
CREATE INDEX IF NOT EXISTS webhook_endpoints_active_idx ON webhook_endpoints (status) WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- 3. webhook_deliveries — المحاولة والنتيجة
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              uuid PRIMARY KEY,
  endpoint_id     uuid        NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  event           text        NOT NULL CHECK (length(event) BETWEEN 3 AND 60),
  -- الحمولة كما أُرسلت: بيانات العميل نفسه، ويُعرض منها في اللوحة **مفاتيحها** لا قيمها.
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer     NOT NULL DEFAULT 4 CHECK (max_attempts BETWEEN 1 AND 10),
  response_code   integer,
  response_body   text        CHECK (response_body IS NULL OR length(response_body) <= 500),
  duration_ms     integer     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error           text,
  next_attempt_at timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- الحكم النهائي له وقت: `delivered` يحمل `delivered_at`، والمنتظِر يحمل موعداً قادماً.
  CONSTRAINT webhook_deliveries_result_check CHECK (
    (status = 'delivered') = (delivered_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
  ON webhook_deliveries (endpoint_id, created_at DESC);
-- ما ينتظر الإرسال: صفٌّ واحد يُسأل عنه العامل أو المسح اليدوي.
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';

-- -----------------------------------------------------------------------------
-- 4. العزل والصلاحيات
-- -----------------------------------------------------------------------------
-- الجداول الأربعة **مستأجريّة**: كل صفٍّ يخصّ منشأةً واحدة، ويُقرأ من سطح المنصة (المشغّل)
-- ومن الحارس (المفتاح). فالسياسة سياستان كسائر جداول العميل: سياسة مستأجرٍ لسياق
-- `app.tenant_id`، وسياسة مستوى المنصة للمشغّل — وهذا ما يجعل عزل «مفتاح عميلٍ لا يرى
-- مفاتيح غيره» مُنفَّذاً في القاعدة لا في شرطٍ في الكود ينُسى.
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON api_keys;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_admin_plane ON api_keys;
CREATE POLICY platform_admin_plane ON api_keys
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

ALTER TABLE api_key_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_uses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON api_key_uses;
CREATE POLICY tenant_isolation ON api_key_uses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_admin_plane ON api_key_uses;
CREATE POLICY platform_admin_plane ON api_key_uses
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook_endpoints;
CREATE POLICY tenant_isolation ON webhook_endpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_admin_plane ON webhook_endpoints;
CREATE POLICY platform_admin_plane ON webhook_endpoints
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook_deliveries;
CREATE POLICY tenant_isolation ON webhook_deliveries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_admin_plane ON webhook_deliveries;
CREATE POLICY platform_admin_plane ON webhook_deliveries
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- منح erp_api: قراءةٌ وكتابةٌ وإبطال — **بلا DELETE على المفاتيح** (الإبطال وسمٌ لا حذف،
-- فالسجلّ يقول من أبطل ومتى)، وDELETE على العناوين وحدها لأن حذف التكامل قرارُ العميل.
GRANT SELECT, INSERT, UPDATE ON api_keys TO erp_api;
GRANT SELECT, INSERT ON api_key_uses TO erp_api;
-- و`id` في `api_key_uses` عمودٌ متسلسل: بلا هذا المنح يقرأ الـAPI المفتاح ويُصادق عليه ثم
-- **يفشل تسجيل الاستعمال** (permission denied for sequence) — وهو خطأ لا يظهر إلا في تشغيلٍ
-- حقيقي، لأن `0000` منحت «كل التسلسلات القائمة» يومها ولم تُمنح الافتراضية للتسلسلات.
GRANT USAGE, SELECT ON SEQUENCE api_key_uses_id_seq TO erp_api, erp_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO erp_api;
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO erp_api;

INSERT INTO permissions (code, module, description) VALUES
  ('console.apikeys.manage', 'console',
   'Issue, rotate and revoke tenant API keys, and read their last use.'),
  ('console.webhooks.manage', 'console',
   'Create and edit tenant webhook endpoints, send a test event, and retry a failed delivery.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

ALTER ROLE erp_api NOBYPASSRLS;
