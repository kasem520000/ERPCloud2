import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, Public, RequiresPermission } from '../platform/index.js';

import { MarketplaceService } from './marketplace.service.js';

/**
 * سوق المستأجر والعلامة البيضاء.
 * القراءة مفتوحة لكل موظف حتى تُخفى شاشات الإضافات غير المثبّتة.
 * التثبيت والدومين والشعار لـ `tenant.apps.manage`.
 */
@Controller()
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get('marketplace/apps')
  @RequiresPermission('tenant.view')
  async list() {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.listForTenant(tenantId) };
  }

  @Post('marketplace/apps/:code/install')
  @RequiresPermission('tenant.apps.manage')
  async install(@Param('code') code: string) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.marketplace.install(tenantId, userId, code) };
  }

  @Post('marketplace/apps/:code/request')
  @RequiresPermission('tenant.view')
  async requestActivation(@Param('code') code: string, @Body() body: { note?: string }) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.marketplace.requestActivation(tenantId, userId, code, body?.note) };
  }

  @Delete('marketplace/apps/:code')
  @RequiresPermission('tenant.apps.manage')
  async uninstall(@Param('code') code: string) {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.uninstall(tenantId, code) };
  }

  @Get('settings/white-label/domains')
  @RequiresPermission('tenant.apps.manage')
  async domains() {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.listDomains(tenantId) };
  }

  @Post('settings/white-label/domains')
  @RequiresPermission('tenant.apps.manage')
  async addDomain(@Body() body: { domain?: string }) {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.addDomain(tenantId, body?.domain ?? '') };
  }

  @Post('settings/white-label/domains/:id/verify')
  @RequiresPermission('tenant.apps.manage')
  async verify(@Param('id') id: string) {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.verifyDomain(tenantId, id) };
  }

  @Delete('settings/white-label/domains/:id')
  @RequiresPermission('tenant.apps.manage')
  async removeDomain(@Param('id') id: string) {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.removeDomain(tenantId, id) };
  }

  @Get('settings/white-label/branding')
  @RequiresPermission('tenant.view')
  async branding() {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.branding(tenantId) };
  }

  @Put('settings/white-label/branding')
  @RequiresPermission('tenant.apps.manage')
  async saveBranding(@Body() body: { logoFileId?: string; primaryColor?: string; secondaryColor?: string }) {
    const { tenantId } = getTenantContext();
    return { data: await this.marketplace.saveBranding(tenantId, body ?? {}) };
  }

  /** Host → brand. The lookup policy returns one active domain and nothing else. */
  @Public()
  @Get('public/branding')
  async publicBrand(@Query('host') host?: string) {
    return { data: await this.marketplace.resolveHost(host ?? '') };
  }
}
