import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { BudgetsService, type BudgetCreateInput, type BudgetUpdateInput } from './budgets.service.js';

/**
 * 📊 الموازنات — draft/approved lifecycle plus the computed variance report.
 *
 * Reading (list, card, variance) sits behind `accounting.budget.view`; writing (create,
 * update, approve, delete-draft) behind `accounting.budget.manage`. Approving is a
 * manage action, not a separate gate: the budget is the manager's own plan, and the
 * ledger is untouched either way — budgets never post entries.
 */
@Controller('budgets')
export class BudgetsController {
  constructor(private readonly budgeting: BudgetsService) {}

  @Get()
  @RequiresPermission('accounting.budget.view')
  list() {
    return this.budgeting.list(getTenantContext().tenantId).then((data) => ({ data }));
  }

  @Post()
  @RequiresPermission('accounting.budget.manage')
  create(@Body() body: BudgetCreateInput) {
    const { tenantId, userId } = getTenantContext();
    return this.budgeting.create(tenantId, body, userId).then((data) => ({ data }));
  }

  @Get(':id')
  @RequiresPermission('accounting.budget.view')
  read(@Param('id') id: string) {
    return this.budgeting.read(getTenantContext().tenantId, id).then((data) => ({ data }));
  }

  @Patch(':id')
  @RequiresPermission('accounting.budget.manage')
  update(@Param('id') id: string, @Body() body: BudgetUpdateInput) {
    const { tenantId, userId } = getTenantContext();
    return this.budgeting.update(tenantId, id, body, userId).then((data) => ({ data }));
  }

  @Delete(':id')
  @RequiresPermission('accounting.budget.manage')
  remove(@Param('id') id: string) {
    const { tenantId, userId } = getTenantContext();
    return this.budgeting.remove(tenantId, id, userId).then((data) => ({ data }));
  }

  /**
   * الموازنة مقابل الفعلي — `to` (YYYY-MM-DD) افتراضيه نهاية السنة، ولا يتجاوزها:
   * تقريرُ «حتى تاريخ كذا» يُقارن سطور الفترات المنقضية كاملةً بحركة القيود المُرحَّلة.
   */
  @Get(':id/variance')
  @RequiresPermission('accounting.budget.view')
  variance(@Param('id') id: string, @Query('to') to?: string) {
    return this.budgeting
      .variance(getTenantContext().tenantId, id, to ? { to } : {})
      .then((data) => ({ data }));
  }
}
