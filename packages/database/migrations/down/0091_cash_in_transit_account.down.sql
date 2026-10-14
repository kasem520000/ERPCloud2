-- Down for 0091_cash_in_transit_account.sql — 🧾 نقد تحت التحويل.
--
-- What is lost: the `1211003` leaf itself, and with it the account any posted transfer
-- between safes used for the days the money was on the road. A transfer already posted
-- keeps its entry (the ledger is append-only): the lines point at an account id that no
-- longer has a row, which is why this down file refuses to run while such a line exists.
--
-- What stays: `1211001`/`1211002` and every other account of the chart, `cash_transfers`
-- itself (its columns are from `0011`) and every balance it has already moved.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM journal_entry_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code = '1211003'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'المناقلات المرحَّلة تشير إلى 1211003 — لا يُسحب الحساب';
  END IF;
END $$;

DELETE FROM accounts WHERE code = '1211003' AND legacy_source = 'cloud-r13';
