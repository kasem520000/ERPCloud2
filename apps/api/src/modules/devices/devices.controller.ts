import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  deviceCreateSchema,
  deviceUpdateSchema,
  idParamSchema,
  type DeviceCreate,
  type DeviceDto,
  type DeviceUpdate,
  type IdParam,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../openapi/zod-api-body.js';
import { getAuthContext } from '../../request-context/request-context.js';
import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { DevicesService } from './devices.service.js';

/**
 * `/api/v1/devices` — canonical tenant device registry (2026-09).
 * Staff-only (`tenant.device.*`); portal memberships are denied by
 * `PermissionsGuard` before they reach these handlers.
 */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequiresPermission('tenant.device.view')
  @ApiOperation({ summary: 'List enrolled tenant devices' })
  async list(): Promise<{ data: DeviceDto[] }> {
    return { data: await this.devices.list(getTenantContext().tenantId) };
  }

  @Post()
  @RequiresPermission('tenant.device.manage')
  @zodApiBody(deviceCreateSchema)
  @ApiOperation({ summary: 'Enrol a device; the credential is returned exactly once' })
  @ApiResponse({ status: 201, description: 'Device enrolled with its one-time credential' })
  async create(
    @Body(new ZodValidationPipe(deviceCreateSchema)) body: DeviceCreate,
  ): Promise<{ data: DeviceDto & { credential: string } }> {
    const tenant = getTenantContext();
    return {
      data: await this.devices.create(tenant.tenantId, getAuthContext().userId, body),
    };
  }

  @Patch(':id')
  @RequiresPermission('tenant.device.manage')
  @zodApiBody(deviceUpdateSchema)
  @ApiOperation({ summary: 'Update device details' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(deviceUpdateSchema)) body: DeviceUpdate,
  ): Promise<{ data: DeviceDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.devices.update(tenant.tenantId, getAuthContext().userId, params.id, body),
    };
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequiresPermission('tenant.device.manage')
  @ApiOperation({ summary: 'Activate a pending or suspended device' })
  async activate(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: DeviceDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.devices.setStatus(tenant.tenantId, getAuthContext().userId, params.id, 'active'),
    };
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequiresPermission('tenant.device.manage')
  @ApiOperation({ summary: 'Suspend a device without burning its credential' })
  async suspend(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: DeviceDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.devices.setStatus(tenant.tenantId, getAuthContext().userId, params.id, 'suspended'),
    };
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequiresPermission('tenant.device.manage')
  @ApiOperation({ summary: 'Revoke a device permanently (burns its credential)' })
  async revoke(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: DeviceDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.devices.setStatus(tenant.tenantId, getAuthContext().userId, params.id, 'revoked'),
    };
  }

  @Post(':id/rotate-credential')
  @HttpCode(200)
  @RequiresPermission('tenant.device.manage')
  @ApiOperation({ summary: 'Rotate a device credential; the new secret is returned exactly once' })
  async rotate(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: DeviceDto & { credential: string } }> {
    const tenant = getTenantContext();
    return {
      data: await this.devices.rotateCredential(tenant.tenantId, getAuthContext().userId, params.id),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('tenant.device.manage')
  @ApiOperation({ summary: 'Remove a device (soft-delete, burns its credential)' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    const tenant = getTenantContext();
    await this.devices.remove(tenant.tenantId, getAuthContext().userId, params.id);
  }
}
