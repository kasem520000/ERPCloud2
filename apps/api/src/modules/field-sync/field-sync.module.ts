import { Module } from '@nestjs/common';

import { VanSalesModule } from '../van-sales/van-sales.module.js';

import { FieldSyncController } from './field-sync.controller.js';
import { FieldSyncRepGuardService } from './field-sync-rep-guard.service.js';
import { FieldSyncReplayService } from './field-sync-replay.service.js';
import { FieldSyncSnapshotService } from './field-sync-snapshot.service.js';

const FIELD_SYNC_SERVICES = [
  FieldSyncRepGuardService,
  FieldSyncSnapshotService,
  FieldSyncReplayService,
];

/**
 * M4 — the API side of the offline-first rep app.
 *
 * Thin by construction: master-data reads (snapshot/delta) are plain queries scoped by
 * the rep guard; every replay row goes through the van-sales sagas (`documents`,
 * `custody`, `loadOrders`) and through them into `sales.postInTx` / the treasury voucher
 * engine — this module never writes a document itself. The `field_sync_queue` table
 * (migration 0128) is the replay ledger and conflict inbox only.
 */
@Module({
  imports: [VanSalesModule],
  controllers: [FieldSyncController],
  providers: FIELD_SYNC_SERVICES,
  exports: FIELD_SYNC_SERVICES,
})
export class FieldSyncModule {}
