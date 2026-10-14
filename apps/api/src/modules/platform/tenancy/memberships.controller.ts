import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  idParamSchema,
  membershipCreateSchema,
  membershipListQuerySchema,
  membershipScopesSchema,
  membershipUpdateSchema,
  type IdParam,
  type ListEnvelope,
  type MembershipCreate,
  type MembershipDto,
  type MembershipListQueryDto,
  type MembershipScopesRequest,
  type MembershipUpdate,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getAuthContext } from '../../../request-context/request-context.js';
import { getTenantContext } from '../context/tenant-context.js';
import { RequiresPermission } from '../decorators/requires-permission.decorator.js';

import { MembershipsService } from './memberships.service.js';

/** API_CONTRACT §2 — memberships. */
@ApiTags('tenancy')
@ApiBearerAuth()
@Controller('memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get('assignable-roles')
  @RequiresPermission('tenant.membership.manage')
  @ApiOperation({ summary: 'List role choices available when managing tenant memberships' })
  @ApiResponse({ status: 200, description: 'Role identifiers and labels, without permission details' })
  async assignableRoles(): Promise<{ data: Array<{ id: string; name: string; isSystem: boolean }> }> {
    return { data: await this.memberships.assignableRoles(getTenantContext().tenantId) };
  }

  @Get()
  @RequiresPermission('tenant.membership.manage')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiOperation({ summary: 'List tenant memberships' })
  @ApiResponse({ status: 200, description: 'Membership page' })
  @ApiResponse({ status: 400, description: 'Disallowed filter (FILTER_NOT_ALLOWED)' })
  async list(
    @Query(new ZodValidationPipe(membershipListQuerySchema)) query: MembershipListQueryDto,
  ): Promise<ListEnvelope<MembershipDto>> {
    return this.memberships.list(getTenantContext().tenantId, query);
  }

  @Get(':id')
  @RequiresPermission('tenant.membership.manage')
  @ApiOperation({ summary: 'Read one membership (404 when it belongs to another tenant)' })
  @ApiResponse({ status: 200, description: 'Membership' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async read(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<{ data: MembershipDto }> {
    return { data: await this.memberships.read(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('tenant.membership.manage')
  @zodApiBody(membershipCreateSchema)
  @ApiOperation({ summary: 'Invite a user into the tenant (by e-mail) with roles and branch scope' })
  @ApiResponse({ status: 201, description: 'Membership created' })
  @ApiResponse({ status: 422, description: 'Role does not belong to this tenant' })
  async create(
    @Body(new ZodValidationPipe(membershipCreateSchema)) body: MembershipCreate,
  ): Promise<{ data: MembershipDto }> {
    const tenant = getTenantContext();
    return { data: await this.memberships.create(tenant.tenantId, getAuthContext().userId, body) };
  }

  @Patch(':id')
  @RequiresPermission('tenant.membership.manage')
  @zodApiBody(membershipUpdateSchema)
  @ApiOperation({ summary: 'Update a membership (display name, branch scope, status, roles)' })
  @ApiResponse({ status: 200, description: 'Updated membership' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(membershipUpdateSchema)) body: MembershipUpdate,
  ): Promise<{ data: MembershipDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.memberships.update(tenant.tenantId, getAuthContext().userId, params.id, body),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('tenant.membership.manage')
  @ApiOperation({ summary: 'Soft-delete a membership' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 422, description: 'Cannot remove the last active owner' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    const tenant = getTenantContext();
    await this.memberships.remove(tenant.tenantId, getAuthContext().userId, params.id);
  }

  @Post(':id/scopes')
  @RequiresPermission('tenant.membership.manage')
  @zodApiBody(membershipScopesSchema)
  @ApiOperation({ summary: 'Replace the per-role scope restrictions of a membership' })
  @ApiResponse({ status: 201, description: 'Updated membership with scopes' })
  @ApiResponse({ status: 422, description: 'Scope references a role the membership does not hold' })
  async replaceScopes(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(membershipScopesSchema)) body: MembershipScopesRequest,
  ): Promise<{ data: MembershipDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.memberships.replaceScopes(
        tenant.tenantId,
        getAuthContext().userId,
        params.id,
        body.scopes,
      ),
    };
  }
}
