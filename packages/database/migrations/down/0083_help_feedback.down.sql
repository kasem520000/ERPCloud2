-- تراجع P-M9: جدول الأصوات يسقط، ونوع `changelog` يخرج من القيد — **وصفحاتٌ كُتبت به**
-- لا تُحذف: تبقى في القاعدة بنوعٍ لم يعد مقبولاً في القيد الجديد، ولذلك تُعاد إلى `page`
-- قبل إحكام القيد، فلا يفشل التراجع على بياناتٍ حقيقية.
DELETE FROM content_feedback;
DROP TABLE IF EXISTS content_feedback;

UPDATE content_pages SET kind = 'page' WHERE kind = 'changelog';

ALTER TABLE content_pages DROP CONSTRAINT IF EXISTS content_pages_kind_check;
ALTER TABLE content_pages ADD CONSTRAINT content_pages_kind_check CHECK (
  kind IN ('page', 'post', 'case_study', 'faq', 'help', 'legal')
);
