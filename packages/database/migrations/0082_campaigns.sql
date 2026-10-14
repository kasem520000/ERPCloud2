-- 0082_campaigns.sql — P-M7 «الحملات البريدية» (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
--
-- الرقم في الخطّة كان `0076_campaigns.sql`، و«0076» شُغل فعلاً بـ`email_service` (P-C6) —
-- فالحملات تأخذ التالي المتاح (0082) بعد ترحيلَي P-M6 (`0080` · `0081`). والخطّة تُقرأ
-- **بالترتيب لا بالأرقام**، وتصحيح الرقم مُسجَّل في تقرير الجزء وفي الخطّة نفسها.
--
-- ثلاثة جداول، لأن الحملة ثلاثة أسئلة مختلفة:
--   1. `email_campaigns`     — **ماذا نرسل ولمن ومتى؟** النصّ والقرار والحالة.
--   2. `campaign_messages`   — **من وصلته الرسالة فعلاً؟** صفٌّ لكل مستلم برمزه ورابطه.
--   3. `campaign_events`     — **وماذا فعل؟** فتحٌ ونقرٌ وإلغاءٌ: سجلٌّ يُقرأ ولا يُختصر بعدّاد.
--
-- وقراران ظاهران في البنية:
--   * **الرمز مُجزَّأ** (`track_token_hash` = sha256): الرمز الخام يخرج في الرسالة وحدها،
--     فمن قرأ القاعدة لم يستطع تزوير فتحٍ ولا نقرٍ ولا إلغاءِ اشتراكِ غيره.
--   * **لا حذف**: الحملة تُلغى (`canceled`) ولا تُمحى، ورسائلها شواهدُ على ما خرج. ولذلك
--     لا `DELETE` في المنح أدناه.
--
-- وتُضاف للمنح/الحجب: `email_messages.html` (نسخة HTML للبكسل) و`email_messages.headers`
-- (ترويسات الامتثال: `List-Unsubscribe` و`List-Unsubscribe-Post`) — تُحفظ مع الرسالة لأن
-- **ما خرج يجب أن يُعرَف بعد شهر**، لا أن يُعاد تركيبه من كودٍ تغيّر.
--
-- آمن للإعادة التشغيل: كل عبارة `IF NOT EXISTS` أو `ADD COLUMN IF NOT EXISTS`.

-- =============================================================================
-- 1. الحجز على رسائل البريد: نسخة HTML وترويسات
-- =============================================================================

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS html    text;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS headers jsonb;

COMMENT ON COLUMN email_messages.html IS
  'نسخة HTML من النصّ نفسه (multipart/alternative) — منها بكسل الفتح في P-M7. لا تُعرض في اللوحة: النصّ هو المصدر.';
COMMENT ON COLUMN email_messages.headers IS
  'ترويسات أضافها المرسل (List-Unsubscribe · List-Unsubscribe-Post). تُحفظ مع الرسالة دليلاً على ما خرج.';

-- =============================================================================
-- 2. email_campaigns — النصّ والقرار
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_campaigns (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  subject       text NOT NULL,
  body          text NOT NULL,
  segment       text NOT NULL,
  locale        text NOT NULL DEFAULT 'ar',
  status        text NOT NULL DEFAULT 'draft',
  -- متى تُرسل. `NULL` مع `draft` = لم يُقرَّر بعد؛ ومع `sending`/`sent` = أُرسلت فوراً.
  scheduled_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  canceled_at   timestamptz,
  canceled_reason text,
  -- المقدَّر لحظة الجدولة (يُعرض في الشاشة). والعدّ النهائي من صفوف `campaign_messages`.
  estimated_recipients integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_campaigns_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'canceled')),
  CONSTRAINT email_campaigns_segment_check
    CHECK (segment IN ('leads', 'subscribers', 'trialing', 'active', 'past_due', 'churned')),
  CONSTRAINT email_campaigns_locale_check CHECK (locale IN ('ar', 'en')),
  CONSTRAINT email_campaigns_name_check   CHECK (char_length(btrim(name)) BETWEEN 3 AND 120),
  CONSTRAINT email_campaigns_subject_check CHECK (char_length(btrim(subject)) BETWEEN 3 AND 200),
  -- حملةٌ «مجدولة» بلا وقتٍ ليست مجدولة؛ و«قيد الإرسال» بلا بدايةٍ ليست كذلك.
  CONSTRAINT email_campaigns_scheduled_check CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CONSTRAINT email_campaigns_started_check   CHECK (status NOT IN ('sending', 'sent') OR started_at IS NOT NULL),
  -- الإلغاء يُكتب بسبب: «لماذا أُلغيت؟» سؤالٌ يُسأل بعد شهرين.
  CONSTRAINT email_campaigns_canceled_check
    CHECK (status <> 'canceled' OR (canceled_at IS NOT NULL AND btrim(coalesce(canceled_reason, '')) <> '')),
  CONSTRAINT email_campaigns_finished_check CHECK (status <> 'sent' OR finished_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS email_campaigns_status_idx ON email_campaigns (status, coalesce(scheduled_at, created_at));
CREATE INDEX IF NOT EXISTS email_campaigns_created_idx ON email_campaigns (created_at DESC);

-- =============================================================================
-- 3. campaign_messages — من وصلته الرسالة
-- =============================================================================

CREATE TABLE IF NOT EXISTS campaign_messages (
  id            uuid PRIMARY KEY,
  campaign_id   uuid NOT NULL REFERENCES email_campaigns (id) ON DELETE CASCADE,
  email         text NOT NULL,
  full_name     text,
  company_name  text,
  -- أين كان المستلم لحظة الإرسال: منشأةٌ (رسائل الحسابات) أو طلبٌ أو مشترك. `SET NULL`
  -- لأن حذف المصدر لا يمحو دليل أن رسالةً خرجت.
  tenant_id     uuid REFERENCES tenants (id) ON DELETE SET NULL,
  lead_id       uuid REFERENCES leads (id) ON DELETE SET NULL,
  subscriber_id uuid REFERENCES email_subscribers (id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending',
  detail        text,
  -- صفُّ البريد الذي خرج فعلاً (P-C6). فارغٌ يعني «لم تُنشأ رسالة»: مستبعدٌ أو فاشل.
  email_message_id uuid REFERENCES email_messages (id) ON DELETE SET NULL,
  -- sha256 للرمز الذي ذهب في الرسالة. والرمز واحد لكل الرسائل الثلاث: الفتح والنقر والإلغاء.
  track_token_hash text NOT NULL,
  -- روابط الحملة كما ذهبت في هذه الرسالة (مرتّبةً): النقرة تُقبل إن كانت وجهتها هنا.
  links         jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at       timestamptz,
  opened_at     timestamptz,
  clicked_at    timestamptz,
  unsubscribed_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_messages_status_check CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT campaign_messages_email_check  CHECK (position('@' in email) > 1)
);

-- عنوانٌ واحد مرّةً واحدة في الحملة: لا يُراسَل إنسانٌ برسالتين من حملةٍ واحدة.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_messages_campaign_email_key ON campaign_messages (campaign_id, email);
CREATE INDEX IF NOT EXISTS campaign_messages_campaign_status_idx ON campaign_messages (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_messages_token_idx ON campaign_messages (track_token_hash);

-- =============================================================================
-- 4. campaign_events — وماذا فعل
-- =============================================================================

CREATE TABLE IF NOT EXISTS campaign_events (
  id          uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES email_campaigns (id) ON DELETE CASCADE,
  message_id  uuid REFERENCES campaign_messages (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  -- للنقر: الوجهة الحقيقية كما خرجت. وللفشل: نصّ الخطأ كما ردّه المزوّد.
  url         text,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_events_kind_check CHECK (
    kind IN ('queued', 'sent', 'failed', 'suppressed', 'opened', 'clicked', 'unsubscribed', 'canceled')
  )
);

CREATE INDEX IF NOT EXISTS campaign_events_campaign_idx ON campaign_events (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_events_message_idx ON campaign_events (message_id, created_at DESC);
-- فتحٌ واحد لكل رسالة يُسجَّل مرّة (وإن فُتحت خمسين مرّة تبقى الأوّلية هي المقيسة):
-- التقارير تقول «كم فتحوا» لا «كم مرّة أعادت آلةُ الفتح تحميل البكسل».
CREATE UNIQUE INDEX IF NOT EXISTS campaign_events_first_open_key
  ON campaign_events (message_id, kind) WHERE kind = 'opened';
CREATE UNIQUE INDEX IF NOT EXISTS campaign_events_first_unsubscribe_key
  ON campaign_events (message_id, kind) WHERE kind = 'unsubscribed';

-- =============================================================================
-- 5. رمز اللوحة الجديد
-- =============================================================================

-- القاعدة الملزمة في هذا المستودع (README §4 بوابة 5): كل رمز `console.*` يُعلَن في
-- `packages/contracts/src/permissions.ts` **ويُدرَج في ترحيل**. ورمزٌ واحد لا رمزان:
-- «مَن يقرأ لوحة الحملات يقرأ قائمةَ أشخاصٍ حقيقيين بعناوينهم وتقارير فتحهم»، ولا معنى
-- لقراءةٍ بلا قرارِ إرسال — الشاشة واحدة، والحاكم الـAPI لا الشريط الجانبي.
INSERT INTO permissions (code, module, description) VALUES
  ('console.campaigns.manage', 'console',
   'Write, schedule, send and cancel marketing campaigns, and read their delivery and engagement reports.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- =============================================================================
-- 6. RLS والصلاحيات
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_campaigns', 'campaign_messages', 'campaign_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_admin_plane ON %I', t);
    EXECUTE format(
      'CREATE POLICY platform_admin_plane ON %I USING (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'') WITH CHECK (COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'')',
      t
    );
  END LOOP;
END $$;

-- بلا `DELETE` عن قصد: الحملة سجلّ، والإلغاء حالةٌ لها سببٌ وتاريخ. ورسائل الحملة شواهد.
GRANT SELECT, INSERT, UPDATE ON email_campaigns, campaign_messages, campaign_events TO erp_api;
GRANT ALL PRIVILEGES ON email_campaigns, campaign_messages, campaign_events TO erp_migrator;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
