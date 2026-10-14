-- 0104 — accounting assistant (PHASE_08)
--
-- 0102 is offline POS and 0103 is Mudad/Moyasar, so this phase uses 0104.
-- The assistant reads aggregates only. It never posts journals and never stores
-- national IDs or payroll lines. The platform key lives in its own table so a
-- tenant session cannot read it; tenant chat loads it through the admin plane.

CREATE TABLE IF NOT EXISTS ai_platform_settings (
  id boolean PRIMARY KEY DEFAULT true,
  provider text NOT NULL DEFAULT 'local',
  model text NOT NULL DEFAULT 'local-grounded',
  api_key_enc text,
  base_url text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  default_monthly_token_limit integer NOT NULL DEFAULT 200000,
  cost_per_million_in numeric(12, 6) NOT NULL DEFAULT 0,
  cost_per_million_out numeric(12, 6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_platform_settings_singleton CHECK (id),
  CONSTRAINT ai_platform_settings_provider_check CHECK (provider IN ('openai', 'anthropic', 'local')),
  CONSTRAINT ai_platform_settings_limit_check CHECK (default_monthly_token_limit >= 0)
);

INSERT INTO ai_platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  platform_suspended boolean NOT NULL DEFAULT false,
  provider text,
  model text,
  monthly_token_limit integer,
  monthly_cost_limit numeric(12, 4),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_settings_provider_check CHECK (provider IS NULL OR provider IN ('openai', 'anthropic', 'local')),
  CONSTRAINT ai_settings_token_limit_check CHECK (monthly_token_limit IS NULL OR monthly_token_limit >= 0),
  CONSTRAINT ai_settings_cost_limit_check CHECK (monthly_cost_limit IS NULL OR monthly_cost_limit >= 0)
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  messages jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost numeric(12, 6) NOT NULL DEFAULT 0,
  provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_logs_tokens_check CHECK (tokens_in >= 0 AND tokens_out >= 0),
  CONSTRAINT ai_usage_logs_cost_check CHECK (cost >= 0)
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  period date NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_suggestions_kind_check CHECK (kind IN ('overdue_invoices', 'low_stock'))
);

CREATE INDEX IF NOT EXISTS ai_conversations_user_idx
  ON ai_conversations (tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_logs_period_idx
  ON ai_usage_logs (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ai_suggestions_tenant_kind_period_key
  ON ai_suggestions (tenant_id, kind, period);

ALTER TABLE ai_platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_platform_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions FORCE ROW LEVEL SECURITY;

-- Platform key: admin plane only. A tenant GUC matches nothing here.
DROP POLICY IF EXISTS platform_admin_plane ON ai_platform_settings;
CREATE POLICY platform_admin_plane ON ai_platform_settings
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS ai_settings_tenant_isolation ON ai_settings;
CREATE POLICY ai_settings_tenant_isolation ON ai_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_admin_plane ON ai_settings;
CREATE POLICY platform_admin_plane ON ai_settings
  USING (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on')
  WITH CHECK (COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on');

DROP POLICY IF EXISTS ai_conversations_tenant_isolation ON ai_conversations;
CREATE POLICY ai_conversations_tenant_isolation ON ai_conversations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS ai_usage_logs_tenant_isolation ON ai_usage_logs;
CREATE POLICY ai_usage_logs_tenant_isolation ON ai_usage_logs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS ai_suggestions_tenant_isolation ON ai_suggestions;
CREATE POLICY ai_suggestions_tenant_isolation ON ai_suggestions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON ai_platform_settings TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_settings, ai_conversations, ai_usage_logs, ai_suggestions TO erp_api;
GRANT ALL PRIVILEGES ON ai_platform_settings, ai_settings, ai_conversations, ai_usage_logs, ai_suggestions TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('ai.assistant.use', 'ai', 'Ask the accounting assistant and read own conversations.'),
  ('ai.settings.manage', 'ai', 'Enable the assistant and set tenant provider, model and monthly limits.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

COMMENT ON TABLE ai_conversations IS
  'PHASE_08: per-user assistant threads. Messages are redacted before storage.';
COMMENT ON TABLE ai_usage_logs IS
  'PHASE_08: token and cost log. Monthly caps also increment usage_counters metric ai.tokens.';
COMMENT ON TABLE ai_platform_settings IS
  'PHASE_08: platform LLM provider and encrypted key. Not readable from a tenant session.';

ALTER ROLE erp_api NOBYPASSRLS;
