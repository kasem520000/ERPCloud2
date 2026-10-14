-- تراجع P-C11: الجداول الأربعة والصلاحيتان.
--
-- ولا يُلمس `audit_log`: هذا الترحيل لم يكتب فيه، والخطايا المكتوبة تبقى شاهدةً على ما جرى.
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_endpoints;
DROP TABLE IF EXISTS api_key_uses;
DROP TABLE IF EXISTS api_keys;

DELETE FROM permissions WHERE code IN ('console.apikeys.manage', 'console.webhooks.manage');
