DROP INDEX IF EXISTS sales_invoices_reference_status_idx;
ALTER TABLE opening_balances DROP CONSTRAINT IF EXISTS opening_balances_party_id_fkey;
ALTER TABLE journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_party_id_fkey;
