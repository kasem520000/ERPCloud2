import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  idParamSchema,
  postingProfileListQuerySchema,
  postingProfileResolveQuerySchema,
  postingProfileUpsertSchema,
  type IdParam,
  type ListEnvelope,
  type PostingProfileDto,
  type PostingProfileListQueryDto,
  type PostingProfileResolutionDto,
  type PostingProfileResolveQuery,
  type PostingProfileUpsert,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { PostingProfilesService } from './posting-profiles.service.js';

/** API_CONTRACT §3 — branch posting profiles. */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('branch-posting-profiles')
export class PostingProfilesController {
  constructor(private readonly profiles: PostingProfilesService) {}

  @Get()
  @RequiresPermission('organization.postingprofile.view')
  @ApiQuery({ name: 'filter[branchId]', required: false })
  @ApiQuery({ name: 'filter[docType]', required: false })
  @ApiOperation({ summary: 'List posting profiles (tenant defaults included)' })
  @ApiResponse({ status: 200, description: 'Posting-profile page' })
  async list(
    @Query(new ZodValidationPipe(postingProfileListQuerySchema)) query: PostingProfileListQueryDto,
  ): Promise<ListEnvelope<PostingProfileDto>> {
    return this.profiles.list(getTenantContext().tenantId, query);
  }

  /** Declared before `:id` so the literal segment is not captured as a uuid. */
  @Get('resolve')
  @RequiresPermission('organization.postingprofile.view')
  @ApiQuery({ name: 'branchId', required: true })
  @ApiQuery({ name: 'docType', required: true })
  @ApiOperation({ summary: 'Resolve the profile for a (branch, doc type) through the fallback chain' })
  @ApiResponse({ status: 200, description: 'Resolved mapping and the rung that answered' })
  @ApiResponse({ status: 422, description: 'No profile resolves (ACCOUNT_PROFILE_MISSING)' })
  async resolve(
    @Query(new ZodValidationPipe(postingProfileResolveQuerySchema)) query: PostingProfileResolveQuery,
  ): Promise<{ data: PostingProfileResolutionDto }> {
    const tenant = getTenantContext();
    return {
      data: await this.profiles.resolvePostProfile(tenant.tenantId, query.branchId, query.docType),
    };
  }

  @Get(':id')
  @RequiresPermission('organization.postingprofile.view')
  @ApiOperation({ summary: 'Read one posting profile' })
  @ApiResponse({ status: 200, description: 'Posting profile' })
  async read(
    @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
  ): Promise<{ data: PostingProfileDto }> {
    return { data: await this.profiles.read(getTenantContext().tenantId, params.id) };
  }

  @Post()
  @RequiresPermission('organization.postingprofile.manage')
  @zodApiBody(postingProfileUpsertSchema)
  @ApiOperation({ summary: 'Create or replace the profile of one (branch, doc type) scope' })
  @ApiResponse({ status: 201, description: 'Posting profile stored' })
  @ApiResponse({ status: 404, description: 'Branch not found in this tenant' })
  async upsert(
    @Body(new ZodValidationPipe(postingProfileUpsertSchema)) body: PostingProfileUpsert,
  ): Promise<{ data: PostingProfileDto }> {
    return { data: await this.profiles.upsert(getTenantContext().tenantId, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiresPermission('organization.postingprofile.manage')
  @ApiOperation({ summary: 'Delete a posting profile' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam): Promise<void> {
    await this.profiles.remove(getTenantContext().tenantId, params.id);
  }
}
