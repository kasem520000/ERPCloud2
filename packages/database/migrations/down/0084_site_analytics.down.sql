-- down/0084_site_analytics.down.sql — عكس 0084 حرفياً: يُزيل ما أُضيف ولا يمسّ ما قبله.
--
-- والتتابع مقصود: النسخ تُفصل قبل حذف الجدول (لا علاقة بينهما، لكن الترتيب يقرأ كسردٍ)،
-- و`DROP TABLE site_events` يأخذ معه الفهارس والسياسات والمنح.

ALTER TABLE content_pages DROP CONSTRAINT IF EXISTS content_pages_variant_check;
ALTER TABLE content_pages DROP CONSTRAINT IF EXISTS content_pages_variant_of_fkey;
DROP INDEX IF EXISTS content_pages_variant_once_key;
ALTER TABLE content_pages DROP COLUMN IF EXISTS variant_key;
ALTER TABLE content_pages DROP COLUMN IF EXISTS variant_of;

DROP TABLE IF EXISTS site_events;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
