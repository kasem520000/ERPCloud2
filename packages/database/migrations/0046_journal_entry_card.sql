-- Phase 07 part three — 📒 إنشاء قيد يومية: the three fields of the entry card that the
-- cloud's journal entry does not carry.
--
-- `Form_WPF/FrmNewEntry.xaml` («إنشاء قيد يومية») lays out, above its `📋 تفاصيل القيد`
-- grid: `رقم القيد` (read-only, allocated on save) · `📅 التاريخ` · `⏰ الوقت` ·
-- `🔑 الرقم العام` (read-only) · `✅ قيد ضريبي` · `📝 الملاحظة`, and the grid itself
-- carries `رمز الحساب · اسم الحساب · مدين · دائن · مركز تكلفة · الشرح · المندوب`.
--
-- `⏰ الوقت` matters because the desktop stores a *timestamp*, not a date: two vouchers
-- on the same day are ordered by it, and حركة الصندوق filters by date *and* time. The
-- cloud only ever stored the date, so an entry made at 09:00 and one made at 21:00 were
-- indistinguishable.
--
-- All three are additive and nullable/false by default: every entry already on the books
-- keeps working, and a caller that sends none of them is unaffected.

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS entry_time time,
  ADD COLUMN IF NOT EXISTS is_vat boolean NOT NULL DEFAULT false;

ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS salesman_id uuid REFERENCES employees(id);

COMMENT ON COLUMN journal_entries.entry_time IS
  '⏰ الوقت — `FrmNewEntry.xaml` txtTime; NULL for entries posted before it was recorded';
COMMENT ON COLUMN journal_entries.is_vat IS
  '✅ قيد ضريبي — `FrmNewEntry.xaml` chkIsVAT (`Entry.IsVAT`); false when the clerk does not mark it';
COMMENT ON COLUMN journal_entry_lines.salesman_id IS
  'المندوب — `FrmNewEntry.xaml` colSalesman (`Entry_sub.salesman`); NULL when no one is credited';

CREATE INDEX IF NOT EXISTS journal_entry_lines_salesman_idx
  ON journal_entry_lines (tenant_id, salesman_id)
  WHERE salesman_id IS NOT NULL;
