-- 0118_email_ai_provider_and_default_parties.sql
--
-- 0. Create `password_reset_tokens` (platform table, SHA-256 hashed tokens) for
--    the "Forgot Password" / password reset flow.
-- 1. Expand `email_settings` so operators and tenants can configure external
--    providers (Resend, SMTP, generic HTTP webhook, or console) with encrypted
--    credentials stored alongside sender identity.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_code text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at);
-- 2. Expand `ai_platform_settings` and `ai_settings` so tenants and platform
--    operators can configure AI API providers ('openai', 'anthropic', 'gemini',
--    'custom', 'local'), encrypted API keys (`api_key_enc`), and custom endpoints
--    (`base_url`).
-- 3. Seed default general customer (`عميل عام`, code `CUST-GEN`) and general
--    supplier (`مورد عام`, code `SUPP-GEN`) for provisioned tenants (those that
--    already have the default chart of accounts `12310001` / `22111001`).

ALTER TABLE email_settings
  ADD COLUMN IF NOT EXISTS api_key_enc text,
  ADD COLUMN IF NOT EXISTS api_endpoint text,
  ADD COLUMN IF NOT EXISTS smtp_host text,
  ADD COLUMN IF NOT EXISTS smtp_port integer,
  ADD COLUMN IF NOT EXISTS smtp_user text,
  ADD COLUMN IF NOT EXISTS smtp_password_enc text,
  ADD COLUMN IF NOT EXISTS smtp_secure boolean NOT NULL DEFAULT false;

ALTER TABLE email_settings
  DROP CONSTRAINT IF EXISTS email_settings_provider_check;

ALTER TABLE email_settings
  ADD CONSTRAINT email_settings_provider_check
  CHECK (provider IN ('console', 'smtp', 'resend', 'http'));

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS api_key_enc text,
  ADD COLUMN IF NOT EXISTS base_url text NOT NULL DEFAULT '';

ALTER TABLE ai_settings
  DROP CONSTRAINT IF EXISTS ai_settings_provider_check;

ALTER TABLE ai_settings
  ADD CONSTRAINT ai_settings_provider_check
  CHECK (provider IS NULL OR provider IN ('openai', 'anthropic', 'gemini', 'custom', 'local'));

ALTER TABLE ai_platform_settings
  DROP CONSTRAINT IF EXISTS ai_platform_settings_provider_check;

ALTER TABLE ai_platform_settings
  ADD CONSTRAINT ai_platform_settings_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'custom', 'local'));

-- Backfill default customer (`عميل عام`) and default supplier (`مورد عام`) for
-- every tenant that has the default COA accounts (`12310001` / `22111001`).
INSERT INTO parties (id, tenant_id, code, kind, name, legal_name, credit_limit)
SELECT
  gen_random_uuid(),
  a.tenant_id,
  'CUST-GEN',
  'customer',
  'عميل عام',
  'عميل عام',
  0
FROM accounts a
WHERE a.code = '12310001'
  AND a.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM parties p
    WHERE p.tenant_id = a.tenant_id
      AND (p.code = 'CUST-GEN' OR p.name = 'عميل عام')
      AND p.deleted_at IS NULL
  );

INSERT INTO parties (id, tenant_id, code, kind, name, legal_name, credit_limit)
SELECT
  gen_random_uuid(),
  a.tenant_id,
  'SUPP-GEN',
  'supplier',
  'مورد عام',
  'مورد عام',
  0
FROM accounts a
WHERE a.code = '22111001'
  AND a.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM parties p
    WHERE p.tenant_id = a.tenant_id
      AND (p.code = 'SUPP-GEN' OR p.name = 'مورد عام')
      AND p.deleted_at IS NULL
  );
