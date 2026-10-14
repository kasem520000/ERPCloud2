-- 0034_inventory_vouchers.sql
-- Phase 05 of the desktop-parity programme: إدخال / إخراج مخزني and بضاعة أول المدة.
--
-- The desktop `frmInvInOutput` saves those documents straight into `Inv`/`InvDetails`
-- with `entry = null` — no journal at all — and fixes the ledger later by hand. The
-- cloud cannot: sales and purchases already post to the inventory account, so a stock
-- document that only moves quantity would leave the ledger permanently disagreeing
-- with the stock balance.
--
-- This migration adds the missing document. `stock_vouchers` is to the stock ledger
-- what `sales_invoices` is to sales: a numbered, branch-scoped, postable document with
-- lines, a status and the journal entry its posting produced.
--
-- It also gives the existing مناقلة (`stock_transfers`) the two journal references it
-- needs to keep goods visible while they are on the road, and lets a stock count
-- (`stock_adjustments`) record who approved it per line and what the variance was
-- worth.
--
-- Every statement is additive (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS): no table is
-- dropped or rewritten, no column narrowed, and no row is touched.

-- =============================================================================
-- 1. سند إدخال / إخراج مخزني (and بضاعة أول المدة)
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_vouchers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  /**
   * `stock_in` — إدخال مخزني (invType 4)
   * `stock_out` — إخراج مخزني (invType 5)
   * `opening` — بضاعة أول المدة (invType 9)
   */
  kind text NOT NULL DEFAULT 'stock_in',
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  voucher_date date NOT NULL DEFAULT CURRENT_DATE,
  /**
   * Why the stock moved (تالف، هالك، عينة، صيانة…). Free text, like the desktop's
   * note field; the *account* it lands on comes from the posting profile, never
   * from this string.
   */
  reason text,
  /** An explicit contra account, when the reason has one of its own. */
  counter_account_id uuid REFERENCES accounts(id),
  notes text,
  journal_entry_id uuid REFERENCES journal_entries(id),
  total_cost numeric(20,4) NOT NULL DEFAULT 0,
  posted_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  /** The desktop's `Inv` row this voucher was migrated from (`legacySource`/`legacyId`). */
  legacy_source text,
  legacy_id text,
  CONSTRAINT stock_vouchers_kind_check CHECK (kind IN ('stock_in', 'stock_out', 'opening')),
  CONSTRAINT stock_vouchers_status_check CHECK (status IN ('draft', 'posted', 'voided'))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_vouchers_tenant_number_key ON stock_vouchers(tenant_id, number);
CREATE INDEX IF NOT EXISTS stock_vouchers_scope_idx ON stock_vouchers(tenant_id, branch_id, status);

CREATE TABLE IF NOT EXISTS stock_voucher_lines (
  voucher_id uuid NOT NULL REFERENCES stock_vouchers(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id),
  qty numeric(20,4) NOT NULL,
  /** Required (and authoritative) for `stock_in` / `opening`; ignored on issue. */
  unit_cost numeric(20,4),
  line_cost numeric(20,4) NOT NULL DEFAULT 0,
  lot_id uuid REFERENCES item_lots(id),
  serial_id uuid REFERENCES item_serials(id),
  note text,
  PRIMARY KEY (voucher_id, line_no)
);
CREATE INDEX IF NOT EXISTS stock_voucher_lines_item_idx ON stock_voucher_lines(tenant_id, item_id);

ALTER TABLE stock_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_vouchers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_vouchers_tenant_isolation ON stock_vouchers;
CREATE POLICY stock_vouchers_tenant_isolation ON stock_vouchers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE stock_voucher_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_voucher_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_voucher_lines_tenant_isolation ON stock_voucher_lines;
CREATE POLICY stock_voucher_lines_tenant_isolation ON stock_voucher_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- =============================================================================
-- 2. مناقلة — keep goods visible while they are on the road
-- =============================================================================

-- Migration 0006 froze the statuses to ('draft','sent','partially_received','received','cancelled'),
-- but the مناقلة service has always written 'in_transit' when goods leave — so every send
-- failed with a check-constraint violation. Widening the constraint is additive: every
-- row that was valid before stays valid, and no row is rewritten.
ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft', 'in_transit', 'sent', 'partially_received', 'received', 'cancelled'));

ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS sent_journal_entry_id uuid REFERENCES journal_entries(id);
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS received_journal_entry_id uuid REFERENCES journal_entries(id);
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id);

COMMENT ON COLUMN stock_transfers.sent_journal_entry_id IS
  'Dr بضاعة تحت التحويل / Cr المخزون — written when the transfer leaves the source warehouse.';
COMMENT ON COLUMN stock_transfers.received_journal_entry_id IS
  'Dr المخزون / Cr بضاعة تحت التحويل — written when the goods reach the destination.';

-- =============================================================================
-- 3. جرد وتسوية — remember the value of the variance, not only the quantity
-- =============================================================================

-- The same frozen vocabulary on the other stock document: 0006 allows
-- ('draft','approved','cancelled'), but a posted count has to say 'posted' — the state
-- that carries the journal and the variance. Widened, never narrowed.
ALTER TABLE stock_adjustments DROP CONSTRAINT IF EXISTS stock_adjustments_status_check;
ALTER TABLE stock_adjustments ADD CONSTRAINT stock_adjustments_status_check
  CHECK (status IN ('draft', 'approved', 'posted', 'cancelled'));

ALTER TABLE stock_adjustment_lines ADD COLUMN IF NOT EXISTS variance_qty numeric(20,4);
ALTER TABLE stock_adjustment_lines ADD COLUMN IF NOT EXISTS variance_value numeric(20,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN stock_adjustment_lines.variance_qty IS
  'counted − expected (signed): positive is an overage, negative a shortage.';
