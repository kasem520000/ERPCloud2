-- Down for 0052_salesman_card.sql — the مندوب card's commissions, contacts and bridge.
--
-- What is lost: the three commission rates (so the report can no longer compute what a
-- مندوب earned), the contact details, the notes, and the link between the مندوب card and
-- the employee card. The invoices and receipts keep their `salesman_id` — they simply
-- point at a card that has no rates left, which is exactly the state before this
-- migration and the reason «كم يستحق هذا المندوب؟» had no answer.

DROP INDEX IF EXISTS salesmen_tenant_active_idx;
DROP INDEX IF EXISTS salesmen_tenant_employee_key;

ALTER TABLE salesmen
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS mobile,
  DROP COLUMN IF EXISTS tel,
  DROP COLUMN IF EXISTS employee_id,
  DROP COLUMN IF EXISTS profit_commission_rate,
  DROP COLUMN IF EXISTS collection_commission_rate,
  DROP COLUMN IF EXISTS commission_rate;
