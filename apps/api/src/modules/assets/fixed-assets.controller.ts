import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  FixedAssetsService,
  type AssetCategoryInput,
  type DepreciationRunInput,
  type FixedAssetInput,
} from './fixed-assets.service.js';

/**
 * 🏢 الأصول الثابتة (M6.1) — routes for the register, categories, the schedule and the
 * monthly depreciation run.
 *
 * Permission split is deliberate (the same shape the rest of accounting uses):
 *   * `accounting.assets.view` — every read;
 *   * `accounting.assets.manage` — categories + the register;
 *   * `accounting.assets.depreciate` — the run, because it creates journal entries:
 *     a clerk who may register an asset is not automatically someone who posts to the GL.
 */
@ApiTags('assets')
@ApiBearerAuth()
@Controller()
export class FixedAssetsController {
  constructor(private readonly assets: FixedAssetsService) {}

  @Get('asset-categories')
  @RequiresPermission('accounting.assets.view')
  async listCategories() {
    return { data: await this.assets.listCategories(getTenantContext().tenantId) };
  }

  @Post('asset-categories')
  @RequiresPermission('accounting.assets.manage')
  @ApiOperation({ summary: 'Create a fixed-asset category (default life + posting accounts)' })
  async createCategory(@Body() body: AssetCategoryInput) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.assets.createCategory(tenantId, body, userId) };
  }

  @Patch('asset-categories/:id')
  @RequiresPermission('accounting.assets.manage')
  @ApiOperation({ summary: 'Edit a fixed-asset category' })
  async updateCategory(@Param('id') id: string, @Body() body: AssetCategoryInput) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.assets.updateCategory(tenantId, id, body, userId) };
  }

  @Get('fixed-assets')
  @RequiresPermission('accounting.assets.view')
  async listAssets(@Query('q') q?: string, @Query('category_id') categoryId?: string, @Query('status') status?: string) {
    return { data: await this.assets.listAssets(getTenantContext().tenantId, { q, categoryId, status }) };
  }

  @Post('fixed-assets')
  @RequiresPermission('accounting.assets.manage')
  @ApiOperation({ summary: 'Register a fixed asset' })
  async createAsset(@Body() body: FixedAssetInput) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.assets.createAsset(tenantId, body, userId) };
  }

  @Post('fixed-assets/depreciation-runs')
  @RequiresPermission('accounting.assets.depreciate')
  @ApiOperation({
    summary:
      'Run the monthly depreciation: one balanced journal entry through postJournalInTx; re-running the same month is a no-op',
  })
  async runDepreciation(@Body() body: DepreciationRunInput) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.assets.runDepreciation(tenantId, body, userId) };
  }

  @Get('fixed-assets/depreciation-runs')
  @RequiresPermission('accounting.assets.view')
  @ApiOperation({ summary: 'The posted depreciation ledger (optionally one period)' })
  async listRuns(@Query('period') period?: string) {
    return { data: await this.assets.listRuns(getTenantContext().tenantId, period) };
  }


  @Get('fixed-assets/:id')
  @RequiresPermission('accounting.assets.view')
  async readAsset(@Param('id') id: string) {
    return { data: await this.assets.readAsset(getTenantContext().tenantId, id) };
  }

  @Get('fixed-assets/:id/schedule')
  @RequiresPermission('accounting.assets.view')
  @ApiOperation({ summary: 'The monthly depreciation schedule with what is already posted' })
  async schedule(@Param('id') id: string) {
    return { data: await this.assets.schedule(getTenantContext().tenantId, id) };
  }

}
