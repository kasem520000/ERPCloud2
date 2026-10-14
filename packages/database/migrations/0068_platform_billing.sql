-- 0068_platform_billing.sql — P-C4 «الباقات والتراخيص والفوترة»
-- (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4، الجزء P-C4).
--
-- الخطة طلبت هذا الترحيل بنصّه: «`0068_platform_billing.sql` — `billing_plan_entitlements` ·
-- `platform_invoices` · `platform_invoice_lines` · `platform_payments` · `dunning_attempts`
-- (كلها RLS)» — والترقيم انتقل إلى **0068** بعد أن أخذ P-C2 الرقم 0067 (تنبيه الترقيم في
-- الخطة §6). وهو **الرقم الحر الوحيد** في المستودع الآن.
--
-- لماذا جدولٌ جديد لكلٍّ من الأربعة، بالقياس لا بالرواية:
--
--   1. **الحقوق** (`billing_plan_entitlements`). `billing_plans` يحمل السعر والدورة فقط
--      (`0019_billing_subscriptions.sql` L5-L16)، والسؤال «ماذا يشتري العميل بهذا السعر؟»
--      بلا جواب في المخطط. حقنُها في `billing_plans.meta` غير موجود، وحقنُها في
--      `platform_settings` يكسر وحدة المفتاح (كل باقة لها حقوقها، والحقّ صفٌّ له قيمة نوعية
--      لا نصّ).
--   2. **الفواتير** (`platform_invoices` + `platform_invoice_lines`). لا شيء في المستودع
--      يمثّل «فاتورة المنصة على العميل»: `sales_invoices` فاتورة *العميل على عميله*، بضريبة
--      ZATCA وأصنافٍ ورصيد مخزون. الخلط بينهما يُدخل مستندات المنصة في دفتر العميل — وهو
--      خطأ محاسبي لا تفصيل تقني.
--   3. **التحصيل** (`platform_payments`). الدفعة هنا ليست دفعة عميل على فاتورة مبيعات: هي
--      إثبات تحصيل اشتراك (تحويل بنكي غالباً) بحاجةٍ إلى مرجعٍ ومرفق إيصال. `payments`
--      القائم لتسويات بوابات الدفع داخل مستأجر (`0064_payment_gateways.sql`).
--   4. **المتابعة** (`dunning_attempts`). جدول «من طُلب منه ماذا ومتى» — بلا هذا الجدول
--      تصير «المتابعة» زرًّا يرسل رسالةً تُنسى. ولا خدمة بريد بعد (P-C6)، فالجدول يسجّل
--      المحاولة وجدولها ونصّها، ويُعلن حالته `scheduled` بدل أن يدّعي `sent`.
--
-- كذلك يُوسَّع `tenant_subscriptions` بحالات دورة الحياة التي طلبتها الخطة («تجربة ·
-- تفعيل · ترقية/تخفيض · إيقاف مؤقّت · إلغاء»): `trialing` · `paused` · `expired`، مع تواريخ
-- التجربة والإيقاف، و`cancel_at_period_end` للإلغاء في نهاية المدة.
--
-- **وأمرٌ مهم:** رقم الفاتورة لا يأتي من `document_sequences`. ذلك الجدول مستأجَرُ النطاق
-- (`tenant_id NOT NULL` + سياسة عزل مستأجر)، ورقم فاتورة المنصة يجب أن يكون **تسلسل
-- البائع** لا تسلسل المشتري — وتسلسلٌ يُعاد لكل عميل ليس تسلسلاً ضريبيًّا. فتُنشأ
-- `platform_invoice_sequences` على مستوى المنصة، بنفس أسلوب `SequencesService`: إدراجٌ مع
-- `ON CONFLICT DO UPDATE … RETURNING` داخل معاملة المستند، فلا يُستهلك رقمٌ في فاتورةٍ
-- تراجعت (فجوةٌ يسأل عنها المدقّق)، والعرض النهائي من `formatSequenceNumber` نفسه في العقود.
-- القرار مصرَّحٌ به في تقرير الجزء §«ما اخترعناه».
--
-- آمن للإعادة التشغيل: كل عبارة `IF NOT EXISTS` أو `DROP … IF EXISTS`.

-- =============================================================================
-- 1. دورة حياة الترخيص — الحالات والتواريخ الناقصة
-- =============================================================================

-- CHECK المولَّد تلقائياً على العمود اسمه `<table>_<column>_check` (نمط PostgreSQL).
ALTER TABLE tenant_subscriptions DROP CONSTRAINT IF EXISTS tenant_subscriptions_status_check;
ALTER TABLE tenant_subscriptions
  ADD CONSTRAINT tenant_subscriptions_status_check
  CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired', 'incomplete'));

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS trial_ends_at   timestamptz,
  ADD COLUMN IF NOT EXISTS paused_at       timestamptz,
  ADD COLUMN IF NOT EXISTS resumed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS canceled_reason text,
  ADD COLUMN IF NOT EXISTS billing_email   text,
  ADD COLUMN IF NOT EXISTS notes           text,
  ADD COLUMN IF NOT EXISTS updated_by      uuid;

-- سطرٌ واحد لكل ترخيص «حَيّ» لمنشأة — يمنع ترخيصين فعّالين بالخطأ (P-C4: التسجيل من اللوحة).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_active_tenant_key
  ON tenant_subscriptions (tenant_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'paused') AND canceled_at IS NULL;

-- =============================================================================
-- 2. حقوق الباقة — ماذا يشتري العميل بهذا السعر
-- =============================================================================

CREATE TABLE IF NOT EXISTS billing_plan_entitlements (
  id         uuid PRIMARY KEY,
  plan_id    uuid NOT NULL REFERENCES billing_plans (id) ON DELETE CASCADE,
  -- الوحدة تُفتح، والحدّ يُقاس، والراية تُفعَّل — وهي أنواع مختلفة في الشاشة وفي التسوية.
  kind       text NOT NULL CHECK (kind IN ('module', 'limit', 'flag')),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_plan_entitlements_plan_key
  ON billing_plan_entitlements (plan_id, key);
CREATE INDEX IF NOT EXISTS billing_plan_entitlements_plan_idx
  ON billing_plan_entitlements (plan_id);

ALTER TABLE billing_plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plan_entitlements FORCE ROW LEVEL SECURITY;

-- كتالوج الباقات مقروء للجميع (مثل `billing_plans_readable` في 0020): العميل يحتاج أن
-- يعرف ما يشتريه قبل أن يشترى، والكتابة للمنصة وحدها.
DROP POLICY IF EXISTS billing_plan_entitlements_readable ON billing_plan_entitlements;
CREATE POLICY billing_plan_entitlements_readable ON billing_plan_entitlements
  USING (true)
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON billing_plan_entitlements TO erp_api;
GRANT ALL PRIVILEGES ON billing_plan_entitlements TO erp_migrator;

-- =============================================================================
-- 3. تسلسل رقم الفاتورة — تسلسل البائع لا المشتري
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_invoice_sequences (
  doc_type      text PRIMARY KEY,
  prefix        text NOT NULL DEFAULT '',
  padding       integer NOT NULL DEFAULT 5,
  current_value bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz,
  CONSTRAINT platform_invoice_sequences_padding_check CHECK (padding BETWEEN 1 AND 18),
  CONSTRAINT platform_invoice_sequences_value_check   CHECK (current_value >= 0)
);

ALTER TABLE platform_invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoice_sequences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_plane ON platform_invoice_sequences;
CREATE POLICY platform_admin_plane ON platform_invoice_sequences
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

GRANT SELECT, INSERT, UPDATE ON platform_invoice_sequences TO erp_api;
GRANT ALL PRIVILEGES ON platform_invoice_sequences TO erp_migrator;

-- =============================================================================
-- 4. فاتورة المنصة على العميل + سطورها
-- =============================================================================

-- عنوان البائع والمشتري **لقطةٌ** لا مرجع: فاتورةٌ مطبوعة لا يجوز أن يتغيّر اسم البائع فيها
-- لأن أحداً عدّل الإعدادات بعدها. والنوعان: فاتورة، وإشعار دائن (مبالغ سالبة) — كما في شاشة
-- `/invoices` التي طلبتها الخطة.
CREATE TABLE IF NOT EXISTS platform_invoices (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id   uuid REFERENCES tenant_subscriptions (id) ON DELETE SET NULL,
  kind              text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'credit_note')),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  -- NULL حتى الإصدار: المسودّة ليست مستنداً ضريبياً، ولا تستهلك رقماً.
  number            text,
  issue_date        date,
  due_date          date,
  currency          char(3) NOT NULL DEFAULT 'SAR',
  subtotal          numeric(20,4) NOT NULL DEFAULT 0,
  tax_rate          numeric(6,3) NOT NULL DEFAULT 15 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_amount        numeric(20,4) NOT NULL DEFAULT 0,
  total             numeric(20,4) NOT NULL DEFAULT 0,
  paid_amount       numeric(20,4) NOT NULL DEFAULT 0,
  buyer_name        text NOT NULL DEFAULT '',
  buyer_tax_number  text,
  buyer_email       text,
  seller_name       text NOT NULL DEFAULT '',
  seller_tax_number text,
  seller_address    text,
  period_start      date,
  period_end        date,
  note              text,
  issued_at         timestamptz,
  issued_by         uuid,
  paid_at           timestamptz,
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  -- فاتورة بلا سطور مستندٌ فارغ، وبلا اسم بائع مستندٌ باطل ضريبيًّا: يُمنعان في القاعدة لا
  -- في الخدمة وحدها.
  CONSTRAINT platform_invoices_total_check CHECK (total = subtotal + tax_amount),
  CONSTRAINT platform_invoices_paid_check  CHECK (paid_amount >= 0),
  -- الرقم يُخصَّص عند الإصدار؛ فالمسودّة والملغاة (وقد تكون مسودّةً أُلغيت بلا إصدار) بلا
  -- رقم، وما عدا ذلك لا يوجد بلا رقم. القيد المكتوب أولاً كان يمنع إلغاء مسودّة —
  -- وهو الطريق الوحيد للتخلّص منها، لأن الحذف ممنوع على المستندات.
  CONSTRAINT platform_invoices_number_check CHECK (status IN ('draft', 'void') OR number IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_invoices_number_key
  ON platform_invoices (number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_invoices_tenant_created_idx
  ON platform_invoices (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_invoices_status_due_idx
  ON platform_invoices (status, due_date);
CREATE INDEX IF NOT EXISTS platform_invoices_subscription_idx
  ON platform_invoices (subscription_id);

CREATE TABLE IF NOT EXISTS platform_invoice_lines (
  id          uuid PRIMARY KEY,
  invoice_id  uuid NOT NULL REFERENCES platform_invoices (id) ON DELETE CASCADE,
  -- منسوخٌ عن الفاتورة: سياسة العزل المستأجَرة تعمل على العمود، وقراءة سطور فاتورة عميل
  -- من مستوى المنصة تحتاج مساراً واحداً لا ربطاً في كل استعلام.
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  line_no     integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('subscription', 'proration', 'discount', 'adjustment')),
  description text NOT NULL,
  quantity    numeric(20,4) NOT NULL DEFAULT 1,
  unit_price  numeric(20,4) NOT NULL DEFAULT 0,
  amount      numeric(20,4) NOT NULL DEFAULT 0,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_invoice_lines_invoice_no
  ON platform_invoice_lines (invoice_id, line_no);
CREATE INDEX IF NOT EXISTS platform_invoice_lines_tenant_idx
  ON platform_invoice_lines (tenant_id);

-- =============================================================================
-- 5. التحصيل — إثبات الدفعة ومرجعها ومرفقها
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_payments (
  id                uuid PRIMARY KEY,
  invoice_id        uuid NOT NULL REFERENCES platform_invoices (id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  method            text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'card', 'other')),
  amount            numeric(20,4) NOT NULL CHECK (amount > 0),
  reference         text,
  receipt_file_id   uuid,
  gateway           text CHECK (gateway IN ('geidea', 'neoleap')),
  gateway_reference text,
  status            text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'refunded', 'failed')),
  received_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by       uuid,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_payments_invoice_idx
  ON platform_payments (invoice_id, received_at DESC);
CREATE INDEX IF NOT EXISTS platform_payments_tenant_idx
  ON platform_payments (tenant_id, received_at DESC);

-- =============================================================================
-- 6. المتابعة — محاولات التحصيل وجدولها ونصّها
-- =============================================================================

CREATE TABLE IF NOT EXISTS dunning_attempts (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES tenant_subscriptions (id) ON DELETE CASCADE,
  invoice_id      uuid REFERENCES platform_invoices (id) ON DELETE SET NULL,
  attempt_no      integer NOT NULL,
  channel         text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'sms', 'manual')),
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'failed', 'skipped')),
  scheduled_at    timestamptz NOT NULL,
  sent_at         timestamptz,
  message         text NOT NULL DEFAULT '',
  outcome         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  CONSTRAINT dunning_attempts_no_check CHECK (attempt_no > 0)
);

-- لا محاولتان بالرقم نفسه على الفاتورة نفسها: نقطةٌ يُبنى عليها «منع تكرار التحصيل» واختباره.
CREATE UNIQUE INDEX IF NOT EXISTS dunning_attempts_invoice_no_key
  ON dunning_attempts (subscription_id, invoice_id, attempt_no) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dunning_attempts_subscription_idx
  ON dunning_attempts (subscription_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS dunning_attempts_tenant_status_idx
  ON dunning_attempts (tenant_id, status, scheduled_at);

-- =============================================================================
-- 7. RLS وأذونات الجداول الأربعة (نمط 0020: سياسة مستأجر + سياسة منصة، تُجمعان بـOR)
-- =============================================================================

ALTER TABLE platform_invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoices       FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_invoice_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoice_lines  FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_payments       FORCE ROW LEVEL SECURITY;
ALTER TABLE dunning_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_attempts        FORCE ROW LEVEL SECURITY;

-- سياسة المستأجر: فاتورة العميل على نفسه (تُقرأ في P-C4 من اللوحة فقط، وتُترك جاهزة
-- لشاشة «فواتيري» في سطح العميل بلا تغيير في السياسة لاحقاً).
DROP POLICY IF EXISTS tenant_isolation ON platform_invoices;
CREATE POLICY tenant_isolation ON platform_invoices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON platform_invoice_lines;
CREATE POLICY tenant_isolation ON platform_invoice_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON platform_payments;
CREATE POLICY tenant_isolation ON platform_payments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON dunning_attempts;
CREATE POLICY tenant_isolation ON dunning_attempts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- سياسة المنصة: المشغّل يقرأ ويكتب عبر كل العملاء، و`WITH CHECK` صريحة (علّة 0066 التي
-- أصلحها P-C2 على `audit_log`: سياسة قراءةٍ بلا `WITH CHECK` تُرثي USING على الإدراج).
DROP POLICY IF EXISTS platform_admin_plane ON platform_invoices;
CREATE POLICY platform_admin_plane ON platform_invoices
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS platform_admin_plane ON platform_invoice_lines;
CREATE POLICY platform_admin_plane ON platform_invoice_lines
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS platform_admin_plane ON platform_payments;
CREATE POLICY platform_admin_plane ON platform_payments
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS platform_admin_plane ON dunning_attempts;
CREATE POLICY platform_admin_plane ON dunning_attempts
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

-- السطور تُحذف وتُعاد كتابةً في مسودّة، فالحذف مسموح لها وحدها؛ الفاتورة والدفعة والمحاولة
-- لا تُحذف: تُلغى أو تُصحَّح بحالة (`void` · `refunded` · `failed`).
GRANT SELECT, INSERT, UPDATE ON platform_invoices TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_invoice_lines TO erp_api;
GRANT SELECT, INSERT, UPDATE ON platform_payments TO erp_api;
GRANT SELECT, INSERT, UPDATE ON dunning_attempts TO erp_api;
GRANT ALL PRIVILEGES ON platform_invoices, platform_invoice_lines, platform_payments, dunning_attempts
  TO erp_migrator;

ALTER ROLE erp_api NOBYPASSRLS;
