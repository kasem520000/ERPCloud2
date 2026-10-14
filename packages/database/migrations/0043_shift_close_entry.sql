-- Phase 06 — قيد الإغلاق: the journal entry a *counted* shift produces.
--
-- `Class/EntryOper.cs` `BindCloseShiftToEntry` builds one entry per close and hangs it
-- on the close's own number (`ReffNo = inv.ClosedId`, `Note = "اغلاق اليومية خاصة الموظف …
-- رقم …"`), because in the desktop nothing is posted when an invoice is saved — the
-- close *is* the accounting event. The cloud is the other way round: every posted sale
-- already wrote its entry (sales, VAT, discount, and the debit to the till's or the
-- bank's own account), so reproducing that entry here would double the whole day.
--
-- What no other document can know is the **count**: the drawer was counted by hand and
-- it disagreed with the books. That difference — 📉 الفرق — is the one thing this entry
-- exists to carry, and it is the desktop's own `3110004` «فرق بالصندوق».
--
-- The columns are additive and nullable: a shift that balances has no entry, and a
-- closed shift that predates this migration simply has none recorded.

ALTER TABLE shift_closes
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS posted_at timestamptz;

COMMENT ON COLUMN shift_closes.journal_entry_id IS
  '📒 القيد — the entry the count produced; NULL when the drawer balanced or was never posted';
COMMENT ON COLUMN shift_closes.posted_at IS
  'When the count was posted to the ledger';

CREATE INDEX IF NOT EXISTS shift_closes_entry_idx
  ON shift_closes (tenant_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;
