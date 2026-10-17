-- 0132_bank_line_posting.down.sql
--
-- Reverses 0132: drops the posted-entry link column and its index. ⚠️ Run it only
-- when the bank-line posting flow is being rolled back — lines already posted lose
-- their pointer to the journal entry that carries them (the entry itself, its
-- source_type/source_id and the idempotency key are untouched, so the audit trail
-- in `journal_entries` survives). No ledger data is modified.

DROP INDEX IF EXISTS bank_statement_lines_posted_entry_idx;

ALTER TABLE bank_statement_lines
  DROP COLUMN IF EXISTS posted_journal_entry_id;
