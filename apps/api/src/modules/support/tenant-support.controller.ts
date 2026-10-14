import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { getTenantContext } from '../platform/context/tenant-context.js';

import { SupportService } from './support.service.js';

/**
 * مسار الدعم الفني للمنشآت المشتركة (`/api/v1/support/tickets`) — يسمح لأي مستخدم في المنشأة
 * برفع طلب مساعدة وتتبعه والرد عليه، ليصل مباشرة إلى صندوق تذاكر مدير المنصة.
 */
@ApiTags('support')
@ApiBearerAuth()
@Controller('support/tickets')
export class TenantSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  async list() {
    const { tenantId } = getTenantContext();
    return { data: await this.support.listForTenant(tenantId) };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const { tenantId } = getTenantContext();
    return { data: await this.support.getForTenant(tenantId, id) };
  }

  @Post()
  async create(@Body() body: { subject?: string; body?: string; priority?: string; category?: string }) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.support.createFromTenant(tenantId, userId, body ?? {}) };
  }

  @Post(':id/reply')
  async reply(@Param('id') id: string, @Body() body: { body?: string }) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.support.replyFromTenant(tenantId, userId, id, body?.body) };
  }
}
