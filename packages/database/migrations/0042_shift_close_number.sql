-- Phase 06 part four — إغلاقات اليومية: رقم الإغلاق.
--
-- `Form_WPF/frmCloseShift.xaml` opens its grid with a `🔢 الرقم` column, and that number
-- is the desktop's `CasherClosed.ClosedID` — a close is a *document* the cashier signs,
-- not a row the database happened to create. `frmCloseShift.xaml.cs:214` selects it, and
-- `BindCloseShiftToEntry1` in `ClosShiftAndroid.xaml.cs` builds a journal entry around
-- it, so the number is what the accountant reconciles against.
--
-- The cloud's `shift_closes` row is created when the drawer is *opened*, and until now
-- carried no number at all — a cashier asking "which close was Tuesday's?" had a uuid.
-- The number is allocated when the shift is **closed**, from the tenant's document
-- sequence like every other document (a voucher is numbered on posting, not on draft),
-- which is why the column is nullable: an open shift is a draft.

ALTER TABLE shift_closes
  ADD COLUMN IF NOT EXISTS number text;

COMMENT ON COLUMN shift_closes.number IS
  '🔢 الرقم — allocated from the shift_close sequence when the drawer is closed';

CREATE UNIQUE INDEX IF NOT EXISTS shift_closes_number_key
  ON shift_closes (tenant_id, number)
  WHERE number IS NOT NULL;
