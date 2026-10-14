import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';

import { PlatformAdminGuard, RequiresPlatformRole } from '../platform/index.js';

import { AiService } from './ai.service.js';

/**
 * Platform provider setup and the per-tenant kill switch.
 * The encrypted key is write-only: responses expose `hasApiKey` only.
 */
@Controller('platform/ai')
@UseGuards(PlatformAdminGuard)
export class AiPlatformController {
  constructor(private readonly ai: AiService) {}

  @Get('settings')
  @RequiresPlatformRole('console.settings.manage')
  async read() {
    return { data: await this.ai.platformView() };
  }

  @Put('settings')
  @RequiresPlatformRole('console.settings.manage')
  async update(@Body() body: Record<string, unknown>) {
    return { data: await this.ai.updatePlatform(body ?? {}) };
  }

  @Post('tenants/:tenantId/suspension')
  @RequiresPlatformRole('console.settings.manage')
  async suspension(@Param('tenantId') tenantId: string, @Body() body: { suspended?: boolean }) {
    return { data: await this.ai.setSuspension(tenantId, body?.suspended !== false) };
  }

  @Post('tenants/:tenantId/suggest')
  @RequiresPlatformRole('console.settings.manage')
  async suggest(@Param('tenantId') tenantId: string) {
    return { data: await this.ai.runDailySuggestions(tenantId) };
  }
}
