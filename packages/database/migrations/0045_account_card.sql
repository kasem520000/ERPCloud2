-- Phase 07 part one — بطاقة حساب: the three fields `frmAccountsTree` shows on the card
-- that the cloud's account row does not carry.
--
-- `Form_WPF/frmAccountsTree.xaml` («بطاقة حساب») lays out, beside the fields the cloud
-- already has: `📅 تاريخ فتح الحساب`, `👤 المستخدم`, `💰 الرصيد الافتتاحي` and
-- `📊 مركز التكلفة`. Two of the three are simply missing columns; the third
-- (`👤 المستخدم`) is `created_by`, which the audit columns already keep.
--
-- All three additions are nullable and additive: an account opened years ago has no
-- recorded opening date, and a chart of accounts imported by `desktop-coa.ts` must not
-- be forced to invent one. `cost_center_id` is the card's *default* cost centre — the
-- one a journal line inherits when the clerk does not choose one; the line itself keeps
-- its own `cost_center_id`, so setting this never rewrites history.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS opened_at date,
  ADD COLUMN IF NOT EXISTS opening_balance numeric(20, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES cost_centers(id);

COMMENT ON COLUMN accounts.opened_at IS
  '📅 تاريخ فتح الحساب — `frmAccountsTree`; NULL for accounts opened before it was recorded';
COMMENT ON COLUMN accounts.opening_balance IS
  '💰 الرصيد الافتتاحي — `frmAccountsTree`; 0 by default, never a NULL that breaks a sum';
COMMENT ON COLUMN accounts.cost_center_id IS
  '📊 مركز التكلفة — the card''s default centre, inherited by a journal line that names none';

CREATE INDEX IF NOT EXISTS accounts_cost_center_idx
  ON accounts (tenant_id, cost_center_id)
  WHERE cost_center_id IS NOT NULL;
