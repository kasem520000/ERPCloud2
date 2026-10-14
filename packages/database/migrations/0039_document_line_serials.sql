-- Phase 05 part seven — الرقم التسلسلي على سطر المستند.
--
-- `Class/InvoiceOper.cs:1635` puts `ItemSerialNo` and `BatchNo` on the document line:
-- a serial says *which piece* moved, and the document says *who moved it*. The cloud
-- had the serial's state machine but no link from a document to the numbers it moved,
-- so a sold number could not be traced back to the invoice or the voucher that sold
-- it. This migration is the link, and it is purely additive.
--
-- Two things are added:
--   1. `serial_nos jsonb` on the three stock line tables — the numbers the clerk typed
--      or scanned, kept on the line so a **draft** remembers them without inventing
--      `item_serials` rows for stock that has not arrived yet;
--   2. `stock_document_serials`, the resolved link written at posting time: one row per
--      (document line, serial), queryable both ways — "what did this voucher move?" and
--      "which documents has this number travelled through?".

ALTER TABLE stock_voucher_lines
  ADD COLUMN IF NOT EXISTS serial_nos jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE stock_adjustment_lines
  ADD COLUMN IF NOT EXISTS serial_nos jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS serial_nos jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN stock_voucher_lines.serial_nos IS
  '🔢 الأرقام التسلسلية as typed on the line; resolved into stock_document_serials at posting time';
COMMENT ON COLUMN stock_adjustment_lines.serial_nos IS
  '🔢 الأرقام التسلسلية counted on the line';
COMMENT ON COLUMN stock_transfer_lines.serial_nos IS
  '🔢 الأرقام التسلسلية travelling on the line';

CREATE TABLE IF NOT EXISTS stock_document_serials (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  doc_id uuid NOT NULL,
  line_no integer NOT NULL,
  item_id uuid NOT NULL REFERENCES items (id),
  serial_id uuid NOT NULL REFERENCES item_serials (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE stock_document_serials IS
  'Which serial number travelled on which document line — the desktop''s InvoiceItemDetail.ItemSerialNo, kept as a real relation instead of a text column';

-- One serial may appear on a given line only once.
CREATE UNIQUE INDEX IF NOT EXISTS stock_document_serials_line_key
  ON stock_document_serials (tenant_id, doc_type, doc_id, line_no, serial_id);

-- "Which documents has this number travelled through?" — the trace a support call asks for.
CREATE INDEX IF NOT EXISTS stock_document_serials_serial_idx
  ON stock_document_serials (tenant_id, serial_id);

-- The same number must not ride twice inside one document, even on different lines.
CREATE UNIQUE INDEX IF NOT EXISTS stock_document_serials_doc_key
  ON stock_document_serials (tenant_id, doc_type, doc_id, serial_id);

ALTER TABLE stock_document_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_document_serials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stock_document_serials;
CREATE POLICY tenant_isolation ON stock_document_serials
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
