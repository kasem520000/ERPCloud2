# Treasury module

Phase 12 unifies legacy receipts and Sand* documents into `vouchers`, adds cash transfers, expense types, cashier shift close, cheque transitions, and cash-location balance writers.

| Document | Debit | Credit |
| --- | --- | --- |
| Receipt voucher | cash/bank/card location | party receivable or counter account |
| Payment voucher | party payable, expense, VAT, salary, or counter account | cash/bank/card location |
| Cleared receipt cheque | cash/bank location | cheque clearing memo/profile account |
| Bounced cheque | reversal/memo per profile | reversal/memo per profile |
| Cash transfer send (R13) | `1211003` نقد تحت التحويل | حساب خزنة المصدر |
| Cash transfer receive (R13) | حساب خزنة الوصول | `1211003` نقد تحت التحويل |
| Shift close (R12) | 🧾 عهدة الإغلاق `1211002` (counted) + 📉 فروقات الصندوق `3110004` (shortage) | cash location (expected) + فروقات (surplus) |

Cash-location balances are updated in the same transaction as voucher posting, voiding, transfer send, and transfer receive. Cheque vouchers affect balances only on terminal collection/clearance.

## Future enhancement 01 — Bank Feeds

The bank-feed surface is implemented in `bank-feeds.controller.ts` / `bank-feeds.service.ts`:

- `POST /treasury/bank-statements/import` accepts RFC-4180 CSV text (comma, semicolon or tab), including Arabic headers and debit/credit columns.
- `GET /treasury/bank-statements/:id/lines` exposes pending, matched, ignored and posted lines; posting never happens as a side effect of listing or matching.
- `POST /treasury/bank-statements/:id/auto-match` scores posted sales/purchase invoices and vouchers by amount, date, reference and party name.
- `GET /treasury/bank-reconciliation` compares the imported bank balance with the linked journal account; when no ledger account is linked it reports the settled-lines fallback explicitly (`postedLines`/`postedMovement` count the lines posted through the flow below).
- `bank_reconciliation_rules` stores deterministic keyword suggestions. Suggestions are never silently posted.

### M6.5 — reviewable match → post (`0132_bank_line_posting.sql`)

A line the books never knew — bank charges, interest, wire fees — used to be matchable, ignorable or forever pending. It can now be **posted** (`POST /treasury/bank-statements/:id/lines/:lineId/post`):

- Only a `pending` line can be posted, and the counter **account is required** in the request: the rule suggestion (`suggested_account_id` / `suggested_cost_center_id`) only pre-fills the desk form at `apps/staff/app/treasury/bank-reconciliation/page.tsx` — nothing is ever posted from a suggestion alone.
- The entry goes through `AccountingService.postJournalInTx` like every other posting: a balanced two-line entry at the bank's own transaction date (positive deposit → Dr bank / Cr counter, negative withdrawal → Dr counter / Cr bank), open period and module-lock checks included, `source_type = 'bank_statement_line'`, `source_id = <line id>`, idempotency key `bank_statement_line:<lineId>` (a re-post after a reversal gets an ordinal suffix).
- The line becomes `status = 'posted'` with `posted_journal_entry_id` (and `postedJournalNumber` in the lines payload), and the statement reaches `reconciled` only when nothing is pending.
- Lifecycle: `unmatch` on a posted line is refused with `BANK_LINE_POSTED` while its entry stands; after the entry is reversed from the journal (0125), unmatch returns the line to `pending` and it can be re-posted or re-matched.

The database objects live in migrations `0096_bank_feeds.sql` + `0132_bank_line_posting.sql` and `packages/database/src/schema/banking.ts`. The two permissions are `treasury.bank.view` and `treasury.bank.manage`. Direct Saudi Open Banking, MT940/CAMT and automatic posting remain out of scope.

Shift close stores counted denomination lines, expected cash from posted cash vouchers inside the shift window, and `diff = counted - expected`. Reports remain structured JSON until Phase 14 rendering.

**R12 — عهدة الإغلاق**: `POST /shift-closes/:id/post` now writes the desktop's three legs
(`Class/EntryOper.cs:772` · `Form_WPF/ClosShiftAndroid.xaml.cs:1588`): the counted drawer is
debited to `1211002` «عهدة الإغلاق», the location account is credited with `expectedCash`
(every posted invoice already debited it), and only the disagreement lands on `3110004`.
A **matched** drawer posts too (two legs, no difference); the refusal (`422 SHIFT_BALANCED`)
is now only for a drawer that held nothing and was expected to hold nothing. The custody
account is resolved as `shift_close.custodyAccountId` → the chart's own `1211002` → 422
`SHIFT_CUSTODY_ACCOUNT_MISSING`; the account id and the amount are written onto the close's
`summary`, and `GET /shift-closes/day-closes` returns `custodyAccountId`/`custodyAccountCode`/
`custodyAccountName`/`custodyAmount` beside `postable`. Clearing the custody stays an
operator step: a receipt voucher whose counter account is «عهدة الإغلاق».

**R13 — مناقلة الخزن تقيّد (closed)**: `sendTransfer`/`receiveTransfer` الآن
يكتبان قيدين ويملآن `sent_journal_entry_id` / `received_journal_entry_id` (الترحيل
`0011`): الإرسال `Dr 1211003 نقد تحت التحويل / Cr خزنة المصدر`، والاستلام
`Dr خزنة الوصول / Cr 1211003`. المال في الطريق يسكن `1211003`، وحسابه يُحلّ
`cash_transfer.cashInTransitAccountId` → دليل `1211003` → 422
`CASH_TRANSFER_TRANSIT_ACCOUNT_MISSING`، والخزنة بلا حساب ⇒ 422
`CASH_ACCOUNT_REQUIRED`. والشبكة تعلن القيود (`sentJournalEntryId` /
`receivedJournalEntryId`) كما تعلن الأرصدة.
