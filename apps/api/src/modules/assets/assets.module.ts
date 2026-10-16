import { Module } from '@nestjs/common';

import { AccountingModule } from '../accounting/accounting.module.js';

import { FixedAssetsController } from './fixed-assets.controller.js';
import { FixedAssetsService } from './fixed-assets.service.js';

/**
 * M6.1 — fixed assets: register, categories, depreciation schedule and posting runs.
 *
 * Isolated by design (IMPLEMENTATION_ROADMAP M6.1): the module owns its three tables
 * (migration 0129) and imports AccountingModule for exactly one thing —
 * `postJournalInTx`. Depreciation never writes the ledger any other way, so the GL
 * invariants (balanced entries, open-period guard, module locks, sequences) stay in one
 * place and the trial-balance integrity suite keeps meaning what it means.
 */
@Module({
  imports: [AccountingModule],
  controllers: [FixedAssetsController],
  providers: [FixedAssetsService],
  exports: [FixedAssetsService],
})
export class AssetsModule {}
