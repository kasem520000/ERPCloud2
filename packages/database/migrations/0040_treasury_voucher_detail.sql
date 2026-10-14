-- Phase 06 part one — سند القبض وسند الصرف: تفاصيل السند.
--
-- `Class/ReceiptOper.cs:159` (`SaveReceipt`) writes a `Receipts` row and
-- `Class/ReceiptOper.cs:21` (`BindReceiptToEntry`) turns the very same object into a
-- journal `Entry` — the document and its entry carry the same fields, because the
-- desktop has no draft: saving *is* posting.
--
-- The cloud's `vouchers` table has the money (amount, method, cheque, cost centre,
-- reference, recipient) but is missing the things a clerk actually looks at when a
-- customer phones about a receipt: what it was **for** (البيان), **when** it was taken
-- (الوقت — the desktop stores date *and* time and the daily statement is filtered by
-- both), and **who brought it in** (المندوب — `Receipts.SalesManID`, which the desktop
-- carries onto the journal line so commission and sales analysis can see it).
--
-- All four columns are additive and nullable: every existing voucher keeps working.

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS voucher_time time;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS salesman_id uuid;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS foreign_amount numeric(20, 4);

COMMENT ON COLUMN vouchers.description IS
  '📝 البيان — the desktop''s Receipts.Notes, which BindReceiptToEntry copies onto the journal entry (entry.Note = Receipt.Notes)';
COMMENT ON COLUMN vouchers.voucher_time IS
  '⏰ الوقت — Receipts.ReceiptDate carries a time as well as a date, and حركة الصندوق is filtered من وقت / إلى وقت';
COMMENT ON COLUMN vouchers.salesman_id IS
  '👔 المندوب — Receipts.SalesManID; the desktop copies it onto the journal line (account.salesman)';
COMMENT ON COLUMN vouchers.foreign_amount IS
  '💲 قيمة السند بالعملة الأجنبية — the amount as counted in `currency`, while `amount` stays in the base currency';

-- A voucher names an employee of *this* tenant; a withdrawn employee must not take the
-- voucher with it.
ALTER TABLE vouchers
  DROP CONSTRAINT IF EXISTS vouchers_salesman_id_fkey;
ALTER TABLE vouchers
  ADD CONSTRAINT vouchers_salesman_id_fkey
  FOREIGN KEY (salesman_id) REFERENCES employees (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS vouchers_salesman_idx
  ON vouchers (tenant_id, salesman_id)
  WHERE salesman_id IS NOT NULL;

-- حركة الصندوق (frmRptKhzna) reads one location between two timestamps, oldest first —
-- the existing `vouchers_cash_idx` is keyed on `posted_at` and cannot serve a date+time
-- window that a clerk types.
CREATE INDEX IF NOT EXISTS vouchers_location_date_idx
  ON vouchers (tenant_id, cash_location_id, date, voucher_time)
  WHERE status = 'posted';
