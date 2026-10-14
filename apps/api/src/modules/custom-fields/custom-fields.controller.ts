import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, tryGetAuthContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { CustomFieldsService } from './custom-fields.service.js';

@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @RequiresPermission('custom_fields.view')
  list(@Query('entity') entity?: string, @Query('include_inactive') includeInactive?: string) {
    return this.fields.list(getTenantContext().tenantId, entity, includeInactive === 'true');
  }

  @Post()
  @RequiresPermission('custom_fields.manage')
  create(@Body() body: unknown) {
    return this.fields.create(getTenantContext().tenantId, body, tryGetAuthContext()?.userId);
  }

  @Put('values')
  @RequiresPermission('custom_fields.manage')
  setValues(@Body() body: unknown) {
    return this.fields.setValues(getTenantContext().tenantId, body, tryGetAuthContext()?.userId);
  }

  @Put(':id')
  @RequiresPermission('custom_fields.manage')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.fields.update(getTenantContext().tenantId, id, body, tryGetAuthContext()?.userId);
  }

  @Get('values')
  @RequiresPermission('custom_fields.view')
  values(@Query('entity') entity?: string, @Query('entity_id') entityId?: string, @Query('entityId') entityIdCamel?: string) {
    if (!entity || !(entityId ?? entityIdCamel)) return this.fields.list(getTenantContext().tenantId, entity);
    return this.fields.values(getTenantContext().tenantId, entity, entityId ?? entityIdCamel!);
  }

  @Get(':id')
  @RequiresPermission('custom_fields.view')
  get(@Param('id') id: string) {
    return this.fields.get(getTenantContext().tenantId, id);
  }

  @Patch(':id')
  @RequiresPermission('custom_fields.manage')
  patch(@Param('id') id: string, @Body() body: unknown) {
    return this.fields.update(getTenantContext().tenantId, id, body, tryGetAuthContext()?.userId);
  }

  @Delete(':id')
  @RequiresPermission('custom_fields.manage')
  remove(@Param('id') id: string) {
    return this.fields.remove(getTenantContext().tenantId, id, tryGetAuthContext()?.userId);
  }

  @Get(':id/values')
  @RequiresPermission('custom_fields.view')
  fieldValues(@Param('id') id: string, @Query('entity_id') entityId?: string, @Query('entityId') entityIdCamel?: string) {
    const entityIdValue = entityId ?? entityIdCamel;
    if (!entityIdValue) return this.fields.get(getTenantContext().tenantId, id);
    return this.fields.get(getTenantContext().tenantId, id).then((field) => this.fields.values(getTenantContext().tenantId, field.entity, entityIdValue));
  }

  @Post(':id/values')
  @RequiresPermission('custom_fields.manage')
  setFieldValue(@Param('id') id: string, @Body() body: unknown) {
    return this.fields.setSingleValue(getTenantContext().tenantId, id, body, tryGetAuthContext()?.userId);
  }

  @Put(':id/values')
  @RequiresPermission('custom_fields.manage')
  updateFieldValue(@Param('id') id: string, @Body() body: unknown) {
    return this.fields.setSingleValue(getTenantContext().tenantId, id, body, tryGetAuthContext()?.userId);
  }
}
