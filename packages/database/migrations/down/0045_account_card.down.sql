-- Down for 0045_account_card.sql — three columns the card introduced, dropped again.
-- Journal lines keep their own `cost_center_id`, so no line loses its centre here.

DROP INDEX IF EXISTS accounts_cost_center_idx;

ALTER TABLE accounts
  DROP COLUMN IF EXISTS cost_center_id,
  DROP COLUMN IF EXISTS opening_balance,
  DROP COLUMN IF EXISTS opened_at;
