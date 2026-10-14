-- Down migration for 0039_document_line_serials.sql.
-- Drops the policies and indexes first, then the table, then the three additive columns.

DROP POLICY IF EXISTS tenant_isolation ON stock_document_serials;

DROP INDEX IF EXISTS stock_document_serials_doc_key;
DROP INDEX IF EXISTS stock_document_serials_serial_idx;
DROP INDEX IF EXISTS stock_document_serials_line_key;

DROP TABLE IF EXISTS stock_document_serials;

ALTER TABLE stock_transfer_lines
  DROP COLUMN IF EXISTS serial_nos;

ALTER TABLE stock_adjustment_lines
  DROP COLUMN IF EXISTS serial_nos;

ALTER TABLE stock_voucher_lines
  DROP COLUMN IF EXISTS serial_nos;
