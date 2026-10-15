import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';
import { FieldSyncRepGuardService } from '../field-sync/field-sync-rep-guard.service.js';

import { RepWorkspaceService } from './rep-workspace.service.js';

/**
 * 🚐 مساحة عمل المندوب — day/custody/closing orchestration for the rep app (M4).
 *
 * The guard resolves the rep exactly like field-sync (D-004); closing additionally
 * refuses any load order that is not the caller's own, which the back-office route
 * deliberately allows (accountants closing on a rep's behalf).
 */
@ApiTags('rep-workspace')
@ApiBearerAuth()
@Controller('rep-workspace')
export class RepWorkspaceController {
  constructor(
    private readonly guard: FieldSyncRepGuardService,
    private readonly workspace: RepWorkspaceService,
  ) {}

  @Get('day')
  @RequiresPermission('van_sales.view')
  async day(@Query('date') date?: string) {
    const { tenantId, membershipId, roleIds, scopes } = getTenantContext();
    const rep = await this.guard.authoriseRep({ tenantId, membershipId, roleIds, scopes });
    return this.workspace.day(tenantId, rep, date);
  }

  @Get('custody')
  @RequiresPermission('van_sales.view')
  async custody() {
    const { tenantId, membershipId, roleIds, scopes } = getTenantContext();
    const rep = await this.guard.authoriseRep({ tenantId, membershipId, roleIds, scopes });
    return this.workspace.custodySummary(tenantId, rep);
  }

  @Post('closing')
  @RequiresPermission('van_sales.closing.submit')
  async submitClosing(
    @Body()
    body: {
      loadOrderId?: string;
      returnedQty?: string;
      damagedQty?: string;
      damageReason?: string;
      collectedCash?: string;
      actualRemainingQty?: string;
      closingNotes?: string;
    },
  ) {
    const { tenantId, membershipId, userId, roleIds, scopes } = getTenantContext();
    const rep = await this.guard.authoriseRep({ tenantId, membershipId, roleIds, scopes });
    return this.workspace.submitClosing(tenantId, userId, rep, body ?? {});
  }
}
