import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { auditListQuerySchema, type AuditEntryDto, type AuditListQueryDto, type ListEnvelope } from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { getTenantContext, RequiresPermission } from '../../platform/index.js';

import { AuditService } from './audit.service.js';

/**
 * `GET /audit-log` — API_CONTRACT §2, `platform.audit.view`.
 *
 * Read-only by construction: `UPDATE`/`DELETE` are revoked from the API database role
 * (SECURITY_ARCHITECTURE §9), so there is no write surface to expose.
 */
@ApiTags('platform-services')
@ApiBearerAuth()
@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequiresPermission('tenant.audit.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[entity]', required: false })
  @ApiQuery({ name: 'filter[entityId]', required: false })
  @ApiQuery({ name: 'filter[action]', required: false })
  @ApiQuery({ name: 'filter[actorUserId]', required: false })
  @ApiQuery({ name: 'filter[from]', required: false, description: 'ISO-8601 lower bound' })
  @ApiQuery({ name: 'filter[to]', required: false, description: 'ISO-8601 upper bound' })
  @ApiOperation({ summary: 'Read the tenant audit trail (newest first)' })
  @ApiResponse({ status: 200, description: 'Audit page' })
  @ApiResponse({ status: 400, description: 'Unknown filter (FILTER_NOT_ALLOWED)' })
  async list(
    @Query(new ZodValidationPipe(auditListQuerySchema)) query: AuditListQueryDto,
  ): Promise<ListEnvelope<AuditEntryDto>> {
    return this.audit.list(getTenantContext().tenantId, query);
  }
}
