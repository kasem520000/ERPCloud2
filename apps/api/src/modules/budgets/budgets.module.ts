import { Module } from '@nestjs/common';

import { BudgetsController } from './budgets.controller.js';
import { BudgetsService } from './budgets.service.js';

/**
 * M6.4 — budgets and budget-versus-actual.
 *
 * Standalone by design: budgets never post journal entries, so the module imports
 * nothing from AccountingModule — it only *reads* the chart of accounts, the fiscal
 * calendar and the posted ledger (the trial balance's own sources). The variance report
 * is computed on read; there is no stored "actual" anywhere in the module.
 */
@Module({
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService],
})
export class BudgetsModule {}
