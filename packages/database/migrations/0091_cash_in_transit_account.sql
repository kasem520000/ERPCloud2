-- R13 — 🧾 نقد تحت التحويل (`1211003`): الحساب الذي يسكنه المال بين خزنتين.
--
-- `cash_transfers` موجود منذ `0011_treasury.sql`، وأعمدته `sent_journal_entry_id` و
-- `received_journal_entry_id` تُعلن أنّ المناقلة وثيقةٌ محاسبية: الإرسال يقيّد، والاستلام
-- يقيّد. و`sendTransfer`/`receiveTransfer` كانا يحرّكان `cash_location_balances` ولا
-- يكتبان قيداً، فبقي النقد ينتقل بين خزنتين بلا أثرٍ في دفتر اليومية.
--
-- ولا يُخترع القيد بلا حسابٍ يحمل المال في الطريق: الإرسال يُخرج المبلغ من خزنة المصدر
-- ولا يُدخله خزنة الوصول بعد (والرصيدان يشهدان بذلك)، فالطرف المقابل بينهما حسابُ أصول.
-- الديسكتوب لا يحتاجه لأنّه ينقل المال بسندَي صرفٍ وقبض، كلٌّ منهما يسمّي الطرف الآخر
-- (`Form_WPF/frmPaymentVoucher.xaml.cs:559`); والسحابة تنقله بوثيقةٍ واحدة بحالتين.
-- ونظيره في المخزون قائمٌ منذ المرحلة 05: `1270003` «بضاعة تحت التحويل». فهذا امتدادُ
-- السحابة الثاني من النوع نفسه، ويُزرع تحت `1211` «صناديق الفرع الرئيسي» الذي فيه
-- `1211001` «الصندوق الرئيسي» و`1211002` «عهدة الإغلاق» — فالورقة التالية `1211003`.
--
-- الترحيل يُكمل دليل الحسابات لمستأجرٍ سُبِق تأسيسه (`DEMO_CHART_OF_ACCOUNTS` صار يحمل
-- الورقة، و`ensureChartOfAccounts` يُكمل الناقص عند التأسيس التالي — وهذا يسبقه)، ولا
-- يمسّ حساباً موجوداً ولا دليلاً لا جذرَ صناديق فيه: عدّادٌ بلا خزائن لا يحتاج الحساب.
--
-- Idempotent: `WHERE NOT EXISTS` على الزوج (المستأجر، الكود). وإعادة تشغيله لا تُنشئ ثانياً.

DO $$
DECLARE
  tenant_row record;
  parent_row record;
  new_id uuid;
  account_name constant text := 'نقد تحت التحويل';
BEGIN
  FOR tenant_row IN
    SELECT t.id
    FROM tenants t
    WHERE t.status <> 'archived'
      AND EXISTS (
        SELECT 1 FROM accounts a
        WHERE a.tenant_id = t.id AND a.code = '1211' AND a.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM accounts a
        WHERE a.tenant_id = t.id AND a.code = '1211003'
      )
  LOOP
    SELECT a.id, a.path, a.level
      INTO parent_row
      FROM accounts a
     WHERE a.tenant_id = tenant_row.id AND a.code = '1211' AND a.deleted_at IS NULL
     LIMIT 1;

    IF parent_row.id IS NULL THEN
      CONTINUE;
    END IF;

    new_id := gen_random_uuid();

    INSERT INTO accounts (
      id, tenant_id, code, name_ar, name_en, parent_id, level, path, type, normal_balance,
      is_postable, allow_manual, created_at, legacy_source
    )
    VALUES (
      new_id, tenant_row.id, '1211003', account_name, NULL, parent_row.id,
      parent_row.level + 1, parent_row.path || '.' || new_id::text, 'asset', 'debit',
      true, true, now(), 'cloud-r13'
    );
  END LOOP;
END $$;

COMMENT ON TABLE cash_transfers IS
  '🧾 مناقلة الخزن — مسودة ← إرسال (يقصّ خزنة المصدر) ← استلام (يُدخل خزنة الوصول). '
  'السطر الفاصل بين الإرسال والاستلام يسكن «نقد تحت التحويل» 1211003 (R13)، فيقاس في '
  'دفتر اليومية كما يقاس في الأرصدة.';
