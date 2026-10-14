-- 0036_transfer_closure.sql
-- Phase 05 (part 3) — بضاعة في الطريق: what is still on the road, and what happened to it.
--
-- A مناقلة that is sent but never fully received leaves goods in بضاعة تحت التحويل
-- forever: the source warehouse has already lost them, the destination never got them,
-- and the transit account keeps a balance nobody can explain. The desktop had no answer
-- for this either — the transfer simply stayed open.
--
-- This migration lets a transfer be **closed**: the outstanding remainder is either
-- returned to the source warehouse or written off as a shortage, and the transit
-- balance is cleared in both cases. Everything here is additive.

-- =============================================================================
-- 1. A closed transfer is a finished transfer
-- =============================================================================

-- Migration 0034 widened this check to allow 'in_transit'; 'closed' is the third state
-- that was always missing: nothing is outstanding any more, but the goods did not all
-- arrive. Dropping and re-adding is additive — every row valid before stays valid.
ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft', 'in_transit', 'sent', 'partially_received', 'received', 'cancelled', 'closed'));

ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS closed_journal_entry_id uuid REFERENCES journal_entries(id);
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS closure_mode text;
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS closure_reason text;

COMMENT ON COLUMN stock_transfers.closed_at IS
  'When the outstanding remainder was settled — the goods came home, or they were written off.';
COMMENT ON COLUMN stock_transfers.closure_mode IS
  '''return'' (the remainder went back to the source warehouse) or ''shortage'' (it was lost and written off).';
COMMENT ON COLUMN stock_transfers.closed_journal_entry_id IS
  'The entry that cleared بضاعة تحت التحويل: Cr transit / Dr المخزون for a return, Cr transit / Dr عجز for a shortage.';

-- =============================================================================
-- 2. How much of a line was settled by closure
-- =============================================================================

-- `received_qty` means "arrived at the destination". A remainder that went home, or that
-- was lost, is neither — so it gets its own column, and
-- outstanding = qty − received_qty − closed_qty stays honest.
ALTER TABLE stock_transfer_lines ADD COLUMN IF NOT EXISTS closed_qty numeric(20,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN stock_transfer_lines.closed_qty IS
  'The part of the line settled by closing the transfer (returned home or written off), never by receipt.';

-- =============================================================================
-- 3. A movement type for goods that came back
-- =============================================================================

-- The ledger already distinguishes the send (`stock_transfer`) from the receipt
-- (`stock_transfer_receipt`) and the cancellation (`stock_transfer_cancel`). A partial
-- return of the remainder is a fourth thing: it is not a cancellation (the transfer is
-- not void) and not a receipt (the goods never reached the destination).
COMMENT ON COLUMN inventory_transactions.doc_type IS
  'Movement source: sales_invoice, purchase_invoice, stock_voucher, stock_adjustment, stock_transfer, stock_transfer_receipt, stock_transfer_cancel, stock_transfer_return, production_order.';
