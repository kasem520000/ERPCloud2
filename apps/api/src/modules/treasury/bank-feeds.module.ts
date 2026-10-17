import { Module } from '@nestjs/common';

import { AccountingModule } from '../accounting/accounting.module.js';

import { BankFeedsController } from './bank-feeds.controller.js';
import { BankFeedsService } from './bank-feeds.service.js';

/**
 * M6.5 — the module now borrows the accounting core: posting a reviewed bank line
 * (charges, interest, wires) goes through `AccountingService.postJournalInTx`, the
 * same path every other posting module uses, so periods, locks, the JE sequence and
 * the idempotency key behave identically.
 */
@Module({
  imports: [AccountingModule],
  controllers: [BankFeedsController],
  providers: [BankFeedsService],
  exports: [BankFeedsService],
})
export class BankFeedsModule {}
