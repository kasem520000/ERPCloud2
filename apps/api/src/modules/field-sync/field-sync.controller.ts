import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { FieldSyncRepGuardService } from './field-sync-rep-guard.service.js';
import { FieldSyncReplayService, type FieldSyncReplayInput } from './field-sync-replay.service.js';
import { FieldSyncSnapshotService } from './field-sync-snapshot.service.js';

/**
 * 🔄 مزامنة المندوب — the rep app's offline-first backend (M4).
 *
 * Every route resolves the caller through the rep guard first (D-004): membership →
 * salesman card → van warehouse scope. Route permission is the base read code
 * (`van_sales.view`); the replay endpoint re-checks the operation-specific code per row
 * so a rep licensed only to collect cannot invoice through the queue.
 */
@ApiTags('field-sync')
@ApiBearerAuth()
@Controller('field-sync')
export class FieldSyncController {
  constructor(
    private readonly guard: FieldSyncRepGuardService,
    private readonly snapshotService: FieldSyncSnapshotService,
    private readonly replayService: FieldSyncReplayService,
  ) {}

  @Get('snapshot')
  @RequiresPermission('van_sales.view')
  async snapshot() {
    const { tenantId, membershipId, roleIds, scopes } = getTenantContext();
    const rep = await this.guard.authoriseRep({ tenantId, membershipId, roleIds, scopes });
    return this.snapshotService.snapshot(tenantId, rep);
  }

  @Get('delta')
  @RequiresPermission('van_sales.view')
  async delta(@Query('since') since?: string) {
    const { tenantId, membershipId, roleIds, scopes } = getTenantContext();
    const rep = await this.guard.authoriseRep({ tenantId, membershipId, roleIds, scopes });
    return this.snapshotService.delta(tenantId, rep, since);
  }

  @Post('replay')
  @RequiresPermission('van_sales.view')
  async replay(@Body() body: FieldSyncReplayInput) {
    const { tenantId, membershipId, userId, roleIds, scopes, permissions } = getTenantContext();
    const rep = await this.guard.authoriseRep({ tenantId, membershipId, roleIds, scopes });
    return this.replayService.replay({
      tenantId,
      userId,
      membershipId,
      permissions,
      rep,
      batch: body ?? {},
    });
  }

  /** 📥 صندوق التعارضات — the caller's own queue rows only (salesman-scoped, D-004). */
  @Get('queue')
  @RequiresPermission('van_sales.view')
  async queue(@Query('status') status?: string, @Query('limit') limit?: string) {
    const { tenantId, membershipId, roleIds, scopes } = getTenantContext();
    const rep = await this.guard.authoriseRep({ tenantId, membershipId, roleIds, scopes });
    return this.replayService.queue(tenantId, rep, status, Number(limit));
  }
}
