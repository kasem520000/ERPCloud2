-- 0118_email_ai_provider_and_default_parties.down.sql

DROP TABLE IF EXISTS password_reset_tokens;

DELETE FROM parties WHERE code IN ('CUST-GEN', 'SUPP-GEN') AND name IN ('عميل عام', 'مورد عام');

ALTER TABLE ai_platform_settings
  DROP CONSTRAINT IF EXISTS ai_platform_settings_provider_check;

UPDATE ai_platform_settings
   SET provider = 'local'
 WHERE provider NOT IN ('openai', 'anthropic', 'local');

ALTER TABLE ai_platform_settings
  ADD CONSTRAINT ai_platform_settings_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'local'));

ALTER TABLE ai_settings
  DROP CONSTRAINT IF EXISTS ai_settings_provider_check;

UPDATE ai_settings
   SET provider = NULL
 WHERE provider IS NOT NULL AND provider NOT IN ('openai', 'anthropic', 'local');

ALTER TABLE ai_settings
  ADD CONSTRAINT ai_settings_provider_check
  CHECK (provider IS NULL OR provider IN ('openai', 'anthropic', 'local'));

ALTER TABLE ai_settings
  DROP COLUMN IF EXISTS base_url,
  DROP COLUMN IF EXISTS api_key_enc;

ALTER TABLE email_settings
  DROP CONSTRAINT IF EXISTS email_settings_provider_check;

UPDATE email_settings
   SET provider = 'console'
 WHERE provider NOT IN ('console', 'smtp');

ALTER TABLE email_settings
  ADD CONSTRAINT email_settings_provider_check
  CHECK (provider IN ('console', 'smtp'));

ALTER TABLE email_settings
  DROP COLUMN IF EXISTS smtp_secure,
  DROP COLUMN IF EXISTS smtp_password_enc,
  DROP COLUMN IF EXISTS smtp_user,
  DROP COLUMN IF EXISTS smtp_port,
  DROP COLUMN IF EXISTS smtp_host,
  DROP COLUMN IF EXISTS api_endpoint,
  DROP COLUMN IF EXISTS api_key_enc;
