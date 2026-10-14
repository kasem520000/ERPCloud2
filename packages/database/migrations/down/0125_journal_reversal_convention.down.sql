-- 0125_journal_reversal_convention.down.sql
--
-- ⚠️ تحذير صريح — هذا التراجع **يعيد الاصطلاح المعيب**، لا حالة سليمة سابقة: فهو يُبطل كل قيد
-- أصلي له مرآة، فيسقط الأصل من كل رصيد يعتمد `status = 'posted'` وتبقى مرآته ⇒ ينحرف ميزان
-- المراجعة والأستاذ بمقدار كل عملية ملغاة. لا تشغّله على قاعدة تشغيلية إلا إذا كنت تُرجع الكود
-- نفسه إلى ما قبل إصلاح `reverseJournalInTx` (وإلا فالتراجع يفسخ ما يصلحه الكود الجديد).
--
-- لا يحذف أي صف، ولا يغيّر أي مبلغ أو بُعد: يكتب `status` فقط (posted → void) للقيود التي لها
-- مرآة مُرحَّلة، وهي نفس المجموعة التي أصلحها ملف الصعود.
--
-- الحارس `prevent_posted_journal_mutation()` يسمح بهذا التحديث: فهو يسمح بالتحديث الوحيد
-- `posted → void` ويمنع ما عداه.

UPDATE journal_entries je
SET status = 'void',
    updated_at = now()
WHERE je.status = 'posted'
  AND EXISTS (
    SELECT 1
    FROM journal_entries rev
    WHERE rev.reversal_of = je.id
      AND rev.status = 'posted'
  );
