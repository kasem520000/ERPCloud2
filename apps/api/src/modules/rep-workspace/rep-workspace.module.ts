import { Module } from '@nestjs/common';

import { FieldSyncModule } from '../field-sync/field-sync.module.js';
import { VanSalesModule } from '../van-sales/van-sales.module.js';

import { RepWorkspaceController } from './rep-workspace.controller.js';
import { RepWorkspaceService } from './rep-workspace.service.js';

/**
 * M4 — thin orchestration for the rep app's working screens: day/visit summary, custody
 * summary, closing submission. No tables of its own, no engine calls of its own: reads
 * the same tables the van-screens read and delegates closing to the custody saga after
 * an explicit ownership check. Rep identity + warehouse scope come from the field-sync
 * guard (D-004), imported once and reused here.
 */
@Module({
  imports: [FieldSyncModule, VanSalesModule],
  controllers: [RepWorkspaceController],
  providers: [RepWorkspaceService],
  exports: [RepWorkspaceService],
})
export class RepWorkspaceModule {}
