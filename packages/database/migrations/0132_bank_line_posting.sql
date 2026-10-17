-- 0132_bank_line_posting.sql
--
-- M6.5 — مكتب التسوية البنكية: من المطابقة إلى الترحيل القابل للمراجعة.
--
-- The bank-feed plane (0096) could import a statement, match its lines to posted
-- invoices/vouchers, and report the bank-versus-ledger difference — but a line the
-- books never knew (bank charges, interest, wire fees) could only be matched,
-- ignored or left pending forever. The accountant had no reviewable way to put it
-- into the ledger.
--
-- This migration adds the last link: a pending line can be POSTED as a two-line
-- journal entry (bank leg against a counter account the reviewer explicitly
-- confirms), and the line remembers which entry carries it:
--
--   * `posted_journal_entry_id` — set when the line is posted; the suggestion
--     columns (`suggested_account_id`, `suggested_cost_center_id`) still only
--     PRE-FILL the review form, they never post by themselves. Suggestions are
--     never silently posted — the reviewer confirms the account, the entry is
--     created through the same `postJournalInTx` every other module uses, and the
--     line becomes `status = 'posted'`.
--   * Reversal lifecycle: the entry can be reversed from the journal (0125). A
--     posted line refuses to unmatch while its entry stands; once a reversal
--     exists, unmatch returns the line to pending and it can be re-posted.
--
-- Rules honoured: additive only, idempotent (`IF NOT EXISTS` guards), no changes to
-- existing columns beyond widening the 0096 status CHECK to admit 'posted'.

ALTER TABLE bank_statement_lines
  ADD COLUMN IF NOT EXISTS posted_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bank_statement_lines_posted_entry_idx
  ON bank_statement_lines(tenant_id, posted_journal_entry_id);

-- 0096 constrained the line status to pending/matched/ignored; the post flow adds
-- 'posted'. Dropping and re-adding is additive — every row valid before stays valid.
ALTER TABLE bank_statement_lines DROP CONSTRAINT IF EXISTS bank_statement_lines_status_check;
ALTER TABLE bank_statement_lines ADD CONSTRAINT bank_statement_lines_status_check
  CHECK (status IN ('pending', 'matched', 'ignored', 'posted'));
