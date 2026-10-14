-- تراجع P-M7: جداول الحملات تسقط (والأحداث والرسائل معها بالتتابع)، وتُعزَل ترويسات
-- الامتثال ونسخة HTML عن `email_messages` — لكن **الرمز يُرمى ثانيةً**: لا يُعاد عمودٌ
-- يحمل رمزاً مُجزَّأً لأحد.
DROP TABLE IF EXISTS campaign_events;
DROP TABLE IF EXISTS campaign_messages;
DROP TABLE IF EXISTS email_campaigns;
ALTER TABLE email_messages DROP COLUMN IF EXISTS headers;
ALTER TABLE email_messages DROP COLUMN IF EXISTS html;
DELETE FROM permissions WHERE code = 'console.campaigns.manage';
