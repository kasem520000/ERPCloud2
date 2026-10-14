-- 0116_session_handoff_codes.sql
-- AUD-08 — جسر الدخول بين الواجهات: كان `smart-login` يمرّر `access`/`refresh` في
-- query string، فيظهر الرمز في عنوان الطلب الأول وسجلّات الوكلاء و`Referer`، ولا يكفي
-- حذفه من العنوان بعد التحميل. البديل: رمز تسليم **لامركزية** لمرة واحدة قصير العمر،
-- يُستبدل عبر `POST /auth/handoff/redeem` بجلسةٍ جديدة، ويُستهلك ذرّياً عند أول استبدال.
--
-- الجدول منصّيّ بلا سياسة RLS كـ`refresh_tokens`: التسليم يقع **قبل** وجود سياق مستأجر
-- (الواجهة الهدف لم تسجّل الدخول بعد)، والمفتاح الوحيد هو بصمة الرمز نفسها.
--
-- `redeemed_at` في شرط `UPDATE … WHERE redeemed_at IS NULL` هو ما يمنع استبدالين
-- متزامنين من النجاح معاً؛ والبصمة `sha256` لرمزٍ عشوائي 256-bit.

CREATE TABLE IF NOT EXISTS session_handoff_codes (
  id uuid PRIMARY KEY,
  /** SHA-256 hex لرمز التسليم عالي العشوائية — لا يُخزَّن الرمز نفسه. */
  code_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  tenant_code text NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS session_handoff_codes_code_key ON session_handoff_codes (code_hash);
CREATE INDEX IF NOT EXISTS session_handoff_codes_expiry_idx ON session_handoff_codes (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON session_handoff_codes TO erp_api;
GRANT ALL PRIVILEGES ON session_handoff_codes TO erp_migrator;
