import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  platformTenantOwnerTransferSchema,
  platformTenantPatchSchema,
  platformTenantStatusSchema,
  tenantBrandingUpdateSchema,
  tenantFlagsUpdateSchema,
  tenantNoteCreateSchema,
  tenantSettingUpdateSchema,
  uuidSchema,
  type PlatformTenantDetailResponse,
  type PlatformTenantHealthResponse,
  type PlatformTenantOwnerTransferInput,
  type PlatformTenantPatch,
  type PlatformTenantStatusInput,
  type PlatformTenantUsageResponse,
  type TenantBrandingResponse,
  type TenantBrandingUpdate,
  type TenantFlagsResponse,
  type TenantFlagsUpdate,
  type TenantNoteCreate,
  type TenantNotesResponse,
  type TenantSettingUpdate,
  type TenantSettingsResponse,
} from '@erp/contracts';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { PlatformTenantsService } from './platform-tenants.service.js';

/**
 * `/api/v1/platform/tenants/:id/*` — P-C2 «العملاء في العمق».
 *
 * | Route | Code |
 * |---|---|
 * | `GET tenants/:id` · `GET …/usage` · `GET …/health` · `GET …/notes` · `GET …/settings` · `GET …/flags` · `GET …/branding` | `console.tenants.view` |
 * | `PATCH tenants/:id` · `POST …/status` · `POST …/owner/transfer` · `POST …/notes` | `console.tenants.manage` |
 * | `PUT …/settings/:key` · `PUT …/flags` · `PUT …/branding` | `console.settings.manage` |
 *
 * The split follows the plan: reading a customer is «view», changing the customer is
 * «manage», and everything that changes **what the product does for them** (limits, feature
 * packs, branding) is the settings code that only the platform owner carries. That is the
 * whole reason P-C1 invented `console.settings.manage`: without it, an operations operator
 * who may read every customer could also switch their feature packs off.
 *
 * Every route is validated by `ZodValidationPipe` — including the `:id` path parameter, so
 * a malformed uuid answers 400 from the schema rather than a database cast error.
 */
@ApiTags('platform-tenants')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}

  @Get(':id')
  @RequiresPlatformRole('console.tenants.view')
  @ApiParam({ name: 'id', description: 'Tenant id (uuid)' })
  @ApiOperation({ summary: 'One customer in depth: overview, members, licences' })
  @ApiResponse({ status: 200, description: 'Tenant card' })
  @ApiResponse({ status: 404, description: 'Unknown tenant' })
  async detail(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: PlatformTenantDetailResponse }> {
    return { data: await this.tenants.detail(id) };
  }

  @Get(':id/usage')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'Consumption against the effective limits, plus 30 days of invoices' })
  async usage(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: PlatformTenantUsageResponse }> {
    return { data: await this.tenants.usage(id) };
  }

  @Get(':id/health')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'Subscription state, outbox depth and actionable findings' })
  async health(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: PlatformTenantHealthResponse }> {
    return { data: await this.tenants.health(id) };
  }

  @Patch(':id')
  @RequiresPlatformRole('console.tenants.manage')
  @ApiOperation({ summary: 'Rename a customer or change its code, timezone, currency' })
  @ApiResponse({ status: 409, description: 'The code is already taken' })
  async patch(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformTenantPatchSchema)) body: PlatformTenantPatch,
  ) {
    return { data: await this.tenants.patch(id, body) };
  }

  // 200, not the Nest default 201: nothing is *created* — an existing customer's state
  // changes, and the answer is the customer as it now is.
  @Post(':id/status')
  @HttpCode(200)
  @RequiresPlatformRole('console.tenants.manage')
  @ApiOperation({ summary: 'Suspend, reactivate or archive a customer — the reason is required' })
  @ApiResponse({ status: 400, description: 'Missing or too short reason (body schema)' })
  @ApiResponse({ status: 409, description: 'The customer already has this status' })
  async status(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformTenantStatusSchema)) body: PlatformTenantStatusInput,
  ) {
    return { data: await this.tenants.setStatus(id, body) };
  }

  @Post(':id/owner/transfer')
  @HttpCode(200)
  @RequiresPlatformRole('console.tenants.manage')
  @ApiOperation({ summary: 'Hand the account to another member of the same customer' })
  @ApiResponse({ status: 404, description: 'The member does not belong to this customer' })
  async transferOwner(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformTenantOwnerTransferSchema)) body: PlatformTenantOwnerTransferInput,
  ) {
    return { data: await this.tenants.transferOwner(id, body) };
  }

  // ------------------------------------------------------------------- notes

  @Get(':id/notes')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'Operator notes about this customer (newest first)' })
  async notes(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: TenantNotesResponse }> {
    return { data: await this.tenants.listNotes(id) };
  }

  @Post(':id/notes')
  @RequiresPlatformRole('console.tenants.manage')
  @ApiOperation({ summary: 'Add an operator note' })
  async addNote(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(tenantNoteCreateSchema)) body: TenantNoteCreate,
  ) {
    return { data: await this.tenants.addNote(id, body) };
  }

  @Delete(':id/notes/:noteId')
  @RequiresPlatformRole('console.tenants.manage')
  @ApiOperation({ summary: 'Delete a note (the audit row keeps its text)' })
  @ApiResponse({ status: 404, description: 'Unknown note for this customer' })
  async deleteNote(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('noteId', new ZodValidationPipe(uuidSchema)) noteId: string,
  ) {
    return { data: await this.tenants.deleteNote(id, noteId) };
  }

  // ---------------------------------------------------------------- settings

  @Get(':id/settings')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'Tenant-scoped settings with their source: tenant, platform or default' })
  async settings(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: TenantSettingsResponse }> {
    return { data: await this.tenants.listSettings(id) };
  }

  @Put(':id/settings/:key')
  @RequiresPlatformRole('console.settings.manage')
  @ApiOperation({ summary: 'Write one override for one customer (null removes it)' })
  @ApiResponse({ status: 422, description: 'The key is not tenant-scoped, or the value is invalid' })
  async updateSetting(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(tenantSettingUpdateSchema)) body: TenantSettingUpdate,
  ): Promise<{ data: TenantSettingsResponse }> {
    return { data: await this.tenants.updateSetting(id, key, body) };
  }

  // ------------------------------------------------------------------- flags

  @Get(':id/flags')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'Feature packs of this customer' })
  async flags(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: TenantFlagsResponse }> {
    return { data: await this.tenants.listFlags(id) };
  }

  @Put(':id/flags')
  @RequiresPlatformRole('console.settings.manage')
  @ApiOperation({ summary: 'Enable or disable feature packs for this customer' })
  async updateFlags(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(tenantFlagsUpdateSchema)) body: TenantFlagsUpdate,
  ): Promise<{ data: TenantFlagsResponse }> {
    return { data: await this.tenants.updateFlags(id, body.values) };
  }

  // ---------------------------------------------------------------- branding

  @Get(':id/branding')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'The customer’s logo, colour and sender name' })
  async branding(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: TenantBrandingResponse }> {
    return { data: await this.tenants.readBranding(id) };
  }

  @Put(':id/branding')
  @RequiresPlatformRole('console.settings.manage')
  @ApiOperation({ summary: 'Write the customer’s branding (any subset of the three fields)' })
  async updateBranding(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(tenantBrandingUpdateSchema)) body: TenantBrandingUpdate,
  ): Promise<{ data: TenantBrandingResponse }> {
    return { data: await this.tenants.updateBranding(id, body) };
  }
}
