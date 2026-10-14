import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  branchCreateSchema,
  branchListQuerySchema,
  branchUpdateSchema,
  idParamSchema,
  type BranchCreate,
  type BranchDto,
  type BranchListQueryDto,
  type BranchUpdate,
  type IdParam,
  type ListEnvelope,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { BranchesService } from './branches.service.js';

/** API_CONTRACT §3 — branches. */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequiresPermission('organization.branch.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'filter[isActive]', required: false })
  @ApiQuery({ name: 'filter[isDefault]', required: false })
  @ApiOperation({ summary: 'List branches visible to the membership branch scope' })
  @ApiResponse({ status: 200, description: 'Branch page' })
  async list(
    @Query(new ZodValidationPipe(branchListQuerySchema)) query: BranchListQueryDto,
  ): Promise<ListEnvelope<BranchDto>> {
    return this.branches.list(getTenantContext().tenantId, query);
  }

  @Get(':id')
  @RequiresPermission('organization.branch.view')
  @ApiOperation({ summary: 'Read one branch (404 when out of scope or in another tenant)' })
  @ApiResponse({ status: 200, description: 'Branch' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  async read(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<{ data: BranchDto }> {
    return { data: await this.branches.read(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('organization.branch.manage')
  @zodApiBody(branchCreateSchema)
  @ApiOperation({ summary: 'Create a branch (the first branch of a tenant becomes the default)' })
  @ApiResponse({ status: 201, description: 'Branch created' })
  @ApiResponse({ status: 422, description: 'Duplicate code' })
  async create(
    @Body(new ZodValidationPipe(branchCreateSchema)) body: BranchCreate,
  ): Promise<{ data: BranchDto }> {
    return { data: await this.branches.create(getTenantContext().tenantId, body) };
  }

  @Patch(':id')
  @RequiresPermission('organization.branch.manage')
  @zodApiBody(branchUpdateSchema)
  @ApiOperation({ summary: 'Update a branch, including the default and active toggles' })
  @ApiResponse({ status: 200, description: 'Updated branch' })
  @ApiResponse({ status: 409, description: 'Stale version (VERSION_CONFLICT)' })
  @ApiResponse({ status: 422, description: 'Invariant violated (default branch rules)' })
  async update(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
    @Body(new ZodValidationPipe(branchUpdateSchema)) body: BranchUpdate,
  ): Promise<{ data: BranchDto }> {
    return { data: await this.branches.update(getTenantContext().tenantId, params.id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('organization.branch.manage')
  @ApiOperation({ summary: 'Soft-delete a branch (CR-008)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 422, description: 'Default branch, or dependants still exist' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    await this.branches.remove(getTenantContext().tenantId, params.id);
  }
}
