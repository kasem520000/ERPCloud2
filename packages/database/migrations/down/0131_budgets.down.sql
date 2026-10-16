-- 0131_budgets.down.sql
--
-- Reverses 0131: drops the two budget tables. ⚠️ This deletes the budgets and their
-- lines — run it only when the whole budgets feature is being rolled back. Nothing in
-- the ledger is touched: budgets never post entries, and the variance report reads
-- `journal_entries` which stay exactly as they are. The two `accounting.budget.*`
-- permission codes are left in place: codes are additive registry entries, and roles
-- that reference them keep working.

DROP TABLE IF EXISTS budget_lines;
DROP TABLE IF EXISTS budgets;
