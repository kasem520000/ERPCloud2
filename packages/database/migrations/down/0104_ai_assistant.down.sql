-- Down migration for 0104 — accounting assistant.
DELETE FROM usage_counters WHERE metric = 'ai.tokens';
DELETE FROM role_permissions WHERE permission_code IN ('ai.assistant.use', 'ai.settings.manage');
DELETE FROM permissions WHERE code IN ('ai.assistant.use', 'ai.settings.manage');

DROP TABLE IF EXISTS ai_suggestions;
DROP TABLE IF EXISTS ai_usage_logs;
DROP TABLE IF EXISTS ai_conversations;
DROP TABLE IF EXISTS ai_settings;
DROP TABLE IF EXISTS ai_platform_settings;
