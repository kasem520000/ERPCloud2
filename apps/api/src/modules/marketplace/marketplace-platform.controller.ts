import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';

import { tryGetAuthContext } from '../../request-context/request-context.js';
import { PlatformAdminGuard, RequiresPlatformRole } from '../platform/index.js';

import { MarketplaceService } from './marketplace.service.js';

/** تسعير الكتالوج المُراجَع وإدارة طلبات تفعيل الباقات للمنشآت. */
@Controller('platform/marketplace')
@UseGuards(PlatformAdminGuard)
export class MarketplacePlatformController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get('apps')
  @RequiresPlatformRole('console.marketplace.manage')
  async list() {
    return { data: await this.marketplace.platformList() };
  }

  @Put('apps/:code')
  @RequiresPlatformRole('console.marketplace.manage')
  async update(@Param('code') code: string, @Body() body: { monthlyPrice?: string; isActive?: boolean }) {
    return { data: await this.marketplace.platformUpdate(code, body ?? {}) };
  }

  @Get('requests')
  @RequiresPlatformRole('console.marketplace.manage')
  async listRequests(@Query('status') status?: string) {
    return { data: await this.marketplace.platformListRequests(status) };
  }

  @Post('requests/:id/decide')
  @RequiresPlatformRole('console.marketplace.manage')
  async decideRequest(
    @Param('id') id: string,
    @Body() body: { decision?: 'approved' | 'rejected'; note?: string },
  ) {
    const actorUserId = tryGetAuthContext()?.userId;
    return {
      data: await this.marketplace.platformDecideRequest(
        id,
        actorUserId,
        body?.decision === 'rejected' ? 'rejected' : 'approved',
        body?.note,
      ),
    };
  }

  @Put('tenants/:tenantId/apps/:code')
  @RequiresPlatformRole('console.marketplace.manage')
  async toggleTenantApp(
    @Param('tenantId') tenantId: string,
    @Param('code') code: string,
    @Body() body: { enabled?: boolean },
  ) {
    const actorUserId = tryGetAuthContext()?.userId;
    return {
      data: await this.marketplace.platformToggleTenantApp(
        tenantId,
        actorUserId,
        code,
        body?.enabled !== false,
      ),
    };
  }
}
