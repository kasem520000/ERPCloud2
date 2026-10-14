import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  platformAuditQuerySchema,
  platformSettingsUpdateSchema,
  platformTenantSearchQuerySchema,
  type PlatformAuditQueryDto,
  type PlatformSettingsResponse,
  type PlatformTenantSearchQueryDto,
  type PlatformTenantSearchResult,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { PlatformConsoleService } from './platform-console.service.js';

/**
 * `/api/v1/platform/{audit,settings,tenants/search}` — P-C1 of
 * `docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4.
 *
 * **Why a second controller rather than more methods on `PlatformAdminController`:**
 * that file is the migration-era control plane (`tenants`/`plans`/`subscriptions`) and it
 * is already 160 lines; this one is the *console shell's* surface — the cross-tenant audit
 * trail, the settings the console writes, and the Ctrl+K lookup. Splitting them keeps the
 * P-C1 acceptance test (`apps/api/src/permission-codes.spec.ts`) able to name the files it
 * scans, and keeps the 2026-09 routes stable while the shell is rebuilt around them.
 *
 * Every route here carries `@RequiresPlatformRole('console.…')`, and — after P-C1 — so
 * does every route in `PlatformAdminController`: no `/platform/*` path is reachable on the
 * bare `pam` claim any more (that is the whole point of the part).
 */
@ApiTags('platform-console')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform')
export class PlatformConsoleController {
  constructor(private readonly console: PlatformConsoleService) {}

  // ------------------------------------------------------------------ audit

  @Get('audit')
  @RequiresPlatformRole('console.audit.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'filter[tenantId]', required: false })
  @ApiQuery({ name: 'filter[actorUserId]', required: false })
  @ApiQuery({ name: 'filter[action]', required: false })
  @ApiQuery({ name: 'filter[entity]', required: false })
  @ApiQuery({ name: 'filter[entityId]', required: false })
  @ApiQuery({ name: 'filter[from]', required: false, description: 'ISO-8601 lower bound' })
  @ApiQuery({ name: 'filter[to]', required: false, description: 'ISO-8601 upper bound' })
  @ApiOperation({ summary: 'Cross-tenant audit trail with each row’s customer (newest first)' })
  @ApiResponse({ status: 200, description: 'Audit page' })
  @ApiResponse({ status: 403, description: 'console.audit.view is required' })
  async audit(@Query(new ZodValidationPipe(platformAuditQuerySchema)) query: PlatformAuditQueryDto) {
    return { data: await this.console.listAudit(query) };
  }

  // --------------------------------------------------------------- settings

  @Get('settings')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'Platform settings: the catalogue joined with the stored values' })
  @ApiResponse({ status: 200, description: 'Eight settings and the deployment name' })
  async settings(): Promise<{ data: PlatformSettingsResponse }> {
    return { data: await this.console.listSettings() };
  }

  @Put('settings')
  @RequiresPlatformRole('console.settings.manage')
  @ApiOperation({ summary: 'Write platform settings (validated against the shared catalogue)' })
  @ApiResponse({ status: 200, description: 'The settings after the write' })
  @ApiResponse({ status: 422, description: 'Unknown key or invalid value for its kind' })
  async updateSettings(
    @Body(new ZodValidationPipe(platformSettingsUpdateSchema))
    body: { values: Record<string, unknown> },
  ): Promise<{ data: PlatformSettingsResponse }> {
    return { data: await this.console.updateSettings(body.values) };
  }

  // ------------------------------------------------------------------- jobs

  @Get('jobs/outbox')
  @RequiresPlatformRole('console.jobs.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiQuery({ name: 'status', required: false, description: 'pending | published | dead' })
  @ApiOperation({ summary: 'Transactional outbox across every customer (read-only)' })
  @ApiResponse({ status: 200, description: 'Outbox page with each job’s customer' })
  async outbox(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
  ) {
    const page = {
      limit: clampInt(limit, 50, 1, 200),
      offset: clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER),
      ...(status ? { status } : {}),
    };
    return { data: await this.console.listOutbox(page) };
  }

  // ---------------------------------------------------------------- omnibox

  @Get('tenants/search')
  @RequiresPlatformRole('console.tenants.view')
  @ApiQuery({ name: 'q', required: true, description: 'Tenant code or name fragment' })
  @ApiOperation({ summary: 'Ctrl+K lookup: up to ten customers by code or name' })
  @ApiResponse({ status: 200, description: 'Matching customers' })
  async searchTenants(
    @Query(new ZodValidationPipe(platformTenantSearchQuerySchema)) query: PlatformTenantSearchQueryDto,
  ): Promise<{ data: PlatformTenantSearchResult[] }> {
    return { data: await this.console.searchTenants(query.q) };
  }
}

/** `?limit=`/`?offset=` as integers, clamped to what the query cost allows. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
