-- 0125_journal_reversal_convention.sql
--
-- 🔁 اصطلاح عكس القيود — repairing what the old cancellation paths left behind.
--
-- The convention this project adopted (migration `0047`, and what the reports already read in
-- `apps/api/src/modules/reporting/report-catalog.ts ← entryStateScope`) is:
--
--   * a reversal is the **mirror alone** — the original entry keeps `status = 'posted'` and its
--     values are never touched, so the two together net to nothing in every balance that counts
--     `status = 'posted'` (ميزان المراجعة، الأستاذ، أرصدة الحسابات، تقارير المخزون والخزينة);
--   * «لاغي» in a report is *an entry a reversal points at* (`reversal_of`), not `status = 'void'`;
--   * `status = 'void'` is a separate, deliberate act for an entry that is **not** mirrored.
--
-- Three code paths broke that convention: `InventoryService.reversalEntry` (cancel a transfer,
-- cancel a stock voucher), `SalesService.void` and `PurchasesService.void`. Each posted the
-- mirror **and** voided the original, so the original dropped out of every posted-only balance
-- while its mirror stayed in: the ledger kept the *reversal* of a cancelled document without the
-- document itself. Cancelling a 1 000 SAR invoice moved the revenue account by +1 000 instead of
-- back to 0, and `cancelTransfer` did the same to المخزون / بضاعة تحت التحويل.
--
-- The code now routes all three through `AccountingService.reverseJournalInTx` (one mechanism,
-- mirror only, `reversal_of` set, every line dimension carried, no double reversal). This file
-- repairs the rows those paths already wrote.
--
-- Safety:
--   * only entries that **have a posted mirror** are touched — an entry voided on purpose without
--     a reversal is left exactly as it is;
--   * no row is deleted, no amount, date, account or dimension is changed: the only column written
--     is `status` (void → posted), which is precisely what makes the pair net to zero again;
--   * the immutability guard `prevent_posted_journal_mutation()` allows this update: it protects
--     entries whose OLD status is `posted`, and these are `void`;
--   * idempotent — running it twice changes nothing the second time;
--   * additive and reversible (`down/0125_journal_reversal_convention.down.sql`).

UPDATE journal_entries je
SET status = 'posted',
    updated_at = now()
WHERE je.status = 'void'
  AND EXISTS (
    SELECT 1
    FROM journal_entries rev
    WHERE rev.reversal_of = je.id
      AND rev.status = 'posted'
  );
