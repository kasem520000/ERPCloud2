-- 0033_pos_shift_link.sql
-- Phase 04 of the desktop-parity programme: point of sale and cashier shifts.
--
-- The cloud already had a POS (table orders) and a cashier shift (`shift_closes`),
-- but the two never met: a POS sale created an invoice nobody could attribute to
-- the cashier's shift, and closing a shift counted only manually captured cash
-- vouchers — the drawer's own cash sales were invisible to the closing report.
-- The desktop (`frmPOS` / `frmCloseShift`) ties every till invoice to the open
-- `CasherClosed` row and refuses to touch an invoice once the day is closed
-- ("نأسف! لا يمكن حذف فاتورة بعد إغلاق اليومية").
--
-- This migration is the smallest link that makes that behaviour possible. It is
-- purely additive and loss-free:
--
--   1. `sales_invoices.shift_id` — nullable FK to `shift_closes(id)` with
--      ON DELETE SET NULL, so every existing invoice keeps working unchanged and
--      a deleted shift does not cascade away the sales history.
--   2. A tenant-scoped index for the shift closing report and the
--      "invoices of this shift" query.
--
-- Nothing is dropped, renamed, narrowed or backfilled.

-- =============================================================================
-- 1. Link a sales invoice to the cashier shift that captured it
-- =============================================================================

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shift_closes (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sales_invoices_shift_idx
  ON sales_invoices (tenant_id, shift_id);

COMMENT ON COLUMN sales_invoices.shift_id IS
  'Open cashier shift (`shift_closes.id`) that captured this till sale. NULL for '
  'back-office invoices and for sales made with no shift open; the shift closing '
  'report falls back to the branch+time window for those.';
