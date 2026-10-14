import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { companyProfilePutSchema, type CompanyProfileDto, type CompanyProfilePut } from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { zodApiBody } from '../../../openapi/zod-api-body.js';
import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { CompanyProfileService } from './company-profile.service.js';

/** API_CONTRACT §3 — `GET/PUT /company-profile` (one row per tenant). */
@ApiTags('organization')
@ApiBearerAuth()
@Controller('company-profile')
export class CompanyProfileController {
  constructor(private readonly companyProfile: CompanyProfileService) {}

  @Get()
  @RequiresPermission('organization.companyprofile.view')
  @ApiOperation({ summary: 'Read the company profile of the current tenant' })
  @ApiResponse({ status: 200, description: 'Company profile' })
  @ApiResponse({ status: 404, description: 'The tenant has no profile yet' })
  async read(): Promise<{ data: CompanyProfileDto }> {
    return { data: await this.companyProfile.read(getTenantContext().tenantId) };
  }

  @Put()
  @RequiresPermission('organization.companyprofile.manage')
  @zodApiBody(companyProfilePutSchema)
  @ApiOperation({ summary: 'Create or replace the company profile (upsert)' })
  @ApiResponse({ status: 200, description: 'Stored company profile' })
  @ApiResponse({ status: 409, description: 'Stale version (VERSION_CONFLICT)' })
  @ApiResponse({ status: 422, description: 'Logo file missing, not finalised, or not an image' })
  async put(
    @Body(new ZodValidationPipe(companyProfilePutSchema)) body: CompanyProfilePut,
  ): Promise<{ data: CompanyProfileDto }> {
    return { data: await this.companyProfile.put(getTenantContext().tenantId, body) };
  }
}
