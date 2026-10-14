-- 0096 down — التغذية البنكية والمطابقة التلقائية
-- Existing ledger entries are not rewritten; only the feed tables and their permissions are removed.

DROP TABLE IF EXISTS bank_statement_lines;
DROP TABLE IF EXISTS bank_reconciliation_rules;
DROP TABLE IF EXISTS bank_statements;
DROP TABLE IF EXISTS bank_accounts;

DELETE FROM permissions WHERE code IN ('treasury.bank.view', 'treasury.bank.manage');

ALTER ROLE erp_api NOBYPASSRLS;
