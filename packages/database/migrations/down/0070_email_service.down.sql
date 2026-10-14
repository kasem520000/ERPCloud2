-- Down for 0070_email_service.sql — P-C6 «خدمة البريد».
--
-- ما الذي يُفقد: **سجلّ الإرسال كاملاً** (`email_messages`) ونصوص القوالب المحرَّرة
-- (`email_templates`) وقائمة الحجر (`email_suppressions`) وإعدادات المُرسِل
-- (`email_settings`).
--
-- وهذا أخطر ما في هذا الترحيل عند التراجع: السجلّ **دعوى تُقرأ** لا ملفّ تهيئة — «هل أُرسل
-- لك تنبيه انتهاء الترخيص؟» سؤالٌ يُجاب من `email_messages` لا من الطابور (الطابور يُفرَّغ،
-- والسجلّ يبقى). ومع ذلك لا يترابط شيء: لا فاتورة ولا قيد محاسبي يقرأ هذه الجداول، فالتراجع
-- يُوقف الخدمة ولا يفسد بيانات. و`usage_counters.email_sends_per_month` (من P-C5) يبقى كما
-- هو: عدّادُ حصّةٍ لا سجلّ، ولا يعنيه اختفاء الرسائل.
--
-- ويبقى أيضاً ما لا يملكه هذا الترحيل: مهمّات `outbox_jobs` من النوع `email.send` تبقى
-- معلّقةً بلا معالجٍ لها → تُعدّ فاشلةً بعد استنفاد محاولاتها (وهذا سلوك الطابور المعتاد).

DROP TABLE IF EXISTS email_settings;
DROP TABLE IF EXISTS email_suppressions;
DROP TABLE IF EXISTS email_messages;
DROP TABLE IF EXISTS email_templates;
