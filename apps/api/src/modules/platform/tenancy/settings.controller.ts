import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { settingValueSchema, type SettingValueRequest } from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../context/tenant-context.js';
import { RequiresPermission } from '../decorators/requires-permission.decorator.js';

import { SettingsService, type SettingsListResponse } from './settings.service.js';

/** API_CONTRACT §2 — `GET /settings`, `PUT /settings/{key}`. */
@ApiTags('tenancy')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequiresPermission('tenant.settings.manage')
  @ApiOperation({ summary: 'Effective tenant settings plus the typed key registry' })
  @ApiResponse({ status: 200, description: 'Settings' })
  async list(): Promise<{ data: SettingsListResponse }> {
    return { data: await this.settings.list(getTenantContext().tenantId) };
  }

  @Put(':key')
  @RequiresPermission('tenant.settings.manage')
  @zodApiBody(settingValueSchema)
  @ApiOperation({ summary: 'Write one typed tenant setting' })
  @ApiResponse({ status: 200, description: 'Stored value' })
  @ApiResponse({ status: 400, description: 'Value failed the typed schema (VALIDATION_FAILED)' })
  @ApiResponse({ status: 404, description: 'Key is not in the registry' })
  async put(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(settingValueSchema)) body: SettingValueRequest,
  ): Promise<{ data: { key: string; value: string | boolean | number | null } }> {
    return { data: await this.settings.put(getTenantContext().tenantId, key, body.value) };
  }
}
