-- Phase 07/09/10 completion hardening.
-- PHASE_07: party subledger references become real database foreign keys after
-- the parties table exists (PHASE_08).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entry_lines_party_id_fkey') THEN
    ALTER TABLE journal_entry_lines
      ADD CONSTRAINT journal_entry_lines_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opening_balances_party_id_fkey') THEN
    ALTER TABLE opening_balances
      ADD CONSTRAINT opening_balances_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- PHASE_10: make return lookup efficient and deterministic for quantity enforcement.
CREATE INDEX IF NOT EXISTS sales_invoices_reference_status_idx
  ON sales_invoices (tenant_id, reference_invoice_id, kind, status);
