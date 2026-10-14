import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  idParamSchema,
  roleCreateSchema,
  roleListQuerySchema,
  rolePermissionsSchema,
  roleUpdateSchema,
  type IdParam,
  type ListEnvelope,
  type RoleCreate,
  type RoleDetailDto,
  type RoleListQueryDto,
  type RolePermissionsRequest,
  type RoleUpdate,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { getTenantContext } from '../context/tenant-context.js';
import { RequiresPermission } from '../decorators/requires-permission.decorator.js';

import { RolesService } from './roles.service.js';

/** API_CONTRACT §2 — roles & permission assignment. */
@ApiTags('tenancy')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequiresPermission('tenant.role.manage')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[isSystem]', required: false })
  @ApiOperation({ summary: 'List tenant roles with their permission codes' })
  @ApiResponse({ status: 200, description: 'Role page' })
  async list(
    @Query(new ZodValidationPipe(roleListQuerySchema)) query: RoleListQueryDto,
  ): Promise<ListEnvelope<RoleDetailDto>> {
    return this.roles.list(getTenantContext().tenantId, query);
  }

  @Get(':id')
  @RequiresPermission('tenant.role.manage')
  @ApiOperation({ summary: 'Read one role with its permission codes (404 across tenants)' })
  @ApiResponse({ status: 200, description: 'Role' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async read(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<{ data: RoleDetailDto }> {
    return { data: await this.roles.read(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('tenant.role.manage')
  @zodApiBody(roleCreateSchema)
  @ApiOperation({ summary: 'Create a role' })
  @ApiResponse({ status: 201, description: 'Role created' })
  @ApiResponse({ status: 422, description: 'Unknown permission code or duplicate name' })
  async create(
    @Body(new ZodValidationPipe(roleCreateSchema)) body: RoleCreate,
  ): Promise<{ data: RoleDetailDto }> {
    const tenant = getTenantContext();
    return { data: await this.roles.create(tenant.tenantId, getAuthContext().userId, body) };
  }

  @Put(':id')
  @RequiresPermission('tenant.role.manage')
  @zodApiBody(roleUpdateSchema)
  @ApiOperation({ summary: 'Update a role (system role names are immutable)' })
  @ApiResponse({ status: 200, description: 'Updated role' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(roleUpdateSchema)) body: RoleUpdate,
  ): Promise<{ data: RoleDetailDto }> {
    const tenant = getTenantContext();
    return { data: await this.roles.update(tenant.tenantId, getAuthContext().userId, params.id, body) };
  }

  @Post(':id/permissions')
  @RequiresPermission('tenant.role.manage')
  @zodApiBody(rolePermissionsSchema)
  @ApiOperation({ summary: 'Replace the permission set of a role' })
  @ApiResponse({ status: 201, description: 'Permissions replaced' })
  @ApiResponse({ status: 422, description: 'Unknown permission code' })
  async replacePermissions(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(rolePermissionsSchema)) body: RolePermissionsRequest,
  ): Promise<{ data: RoleDetailDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.roles.replacePermissions(
        tenant.tenantId,
        getAuthContext().userId,
        params.id,
        body.permissionCodes,
      ),
    };
  }
}
