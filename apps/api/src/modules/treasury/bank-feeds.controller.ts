import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  BankFeedsService,
  type BankAccountInput,
  type BankAccountUpdate,
  type BankLineMatchInput,
  type BankRuleInput,
  type BankStatementImportInput,
} from './bank-feeds.service.js';

/**
 * Future enhancement 01 — the bank-feed plane lives under `/treasury/*` so it does not
 * collide with the existing voucher endpoints. Every operation is explicitly protected
 * by the two new permission codes: read-only reconciliation can be separated from import
 * and matching.
 */
@Controller('treasury')
export class BankFeedsController {
  constructor(private readonly bankFeeds: BankFeedsService) {}

  @Get('bank-accounts')
  @RequiresPermission('treasury.bank.view')
  async bankAccounts() {
    return { data: await this.bankFeeds.listBankAccounts(getTenantContext().tenantId) };
  }

  @Get('bank-accounts/:id')
  @RequiresPermission('treasury.bank.view')
  async bankAccount(@Param('id') id: string) {
    return { data: await this.bankFeeds.getBankAccount(getTenantContext().tenantId, id) };
  }

  @Post('bank-accounts')
  @RequiresPermission('treasury.bank.manage')
  async createBankAccount(@Body() body: BankAccountInput) {
    return { data: await this.bankFeeds.createBankAccount(getTenantContext().tenantId, body) };
  }

  @Patch('bank-accounts/:id')
  @RequiresPermission('treasury.bank.manage')
  async updateBankAccount(@Param('id') id: string, @Body() body: BankAccountUpdate) {
    return { data: await this.bankFeeds.updateBankAccount(getTenantContext().tenantId, id, body) };
  }

  @Delete('bank-accounts/:id')
  @RequiresPermission('treasury.bank.manage')
  async deleteBankAccount(@Param('id') id: string) {
    return { data: await this.bankFeeds.deleteBankAccount(getTenantContext().tenantId, id) };
  }

  @Get('bank-statements')
  @RequiresPermission('treasury.bank.view')
  async statements(@Query('bank_account_id') bankAccountId?: string) {
    return { data: await this.bankFeeds.listStatements(getTenantContext().tenantId, bankAccountId) };
  }

  @Delete('bank-statements/:id')
  @RequiresPermission('treasury.bank.manage')
  async deleteStatement(@Param('id') id: string) {
    return { data: await this.bankFeeds.deleteStatement(getTenantContext().tenantId, id) };
  }

  @Get('bank-statements/:id')
  @RequiresPermission('treasury.bank.view')
  async statement(@Param('id') id: string) {
    return { data: await this.bankFeeds.getStatement(getTenantContext().tenantId, id) };
  }

  @Post('bank-statements/import')
  @RequiresPermission('treasury.bank.manage')
  async importStatement(@Body() body: BankStatementImportInput) {
    return { data: await this.bankFeeds.importStatement(getTenantContext().tenantId, body) };
  }

  @Get('bank-statements/:id/lines')
  @RequiresPermission('treasury.bank.view')
  async lines(@Param('id') id: string, @Query('filter[status]') status?: string, @Query('status') statusAlias?: string) {
    return { data: await this.bankFeeds.listLines(getTenantContext().tenantId, id, status ?? statusAlias) };
  }

  @Post('bank-statements/:id/match')
  @RequiresPermission('treasury.bank.manage')
  async match(@Param('id') id: string, @Body() body: BankLineMatchInput) {
    return { data: await this.bankFeeds.matchLine(getTenantContext().tenantId, id, body) };
  }

  @Post('bank-statements/:id/auto-match')
  @RequiresPermission('treasury.bank.manage')
  async autoMatch(@Param('id') id: string) {
    return { data: await this.bankFeeds.autoMatch(getTenantContext().tenantId, id) };
  }

  @Post('bank-statements/:id/lines/:lineId/ignore')
  @RequiresPermission('treasury.bank.manage')
  async ignore(@Param('id') id: string, @Param('lineId') lineId: string) {
    return { data: await this.bankFeeds.ignoreLine(getTenantContext().tenantId, id, lineId) };
  }

  @Delete('bank-statements/:id/lines/:lineId/match')
  @RequiresPermission('treasury.bank.manage')
  async unmatch(@Param('id') id: string, @Param('lineId') lineId: string) {
    return { data: await this.bankFeeds.unmatchLine(getTenantContext().tenantId, id, lineId) };
  }

  @Get('bank-reconciliation')
  @RequiresPermission('treasury.bank.view')
  async reconciliation(
    @Query('bank_account_id') bankAccountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return {
      data: await this.bankFeeds.reconciliation(getTenantContext().tenantId, {
        bankAccountId,
        from,
        to,
      }),
    };
  }

  @Get('bank-reconciliation-rules')
  @RequiresPermission('treasury.bank.view')
  async rules() {
    return { data: await this.bankFeeds.listRules(getTenantContext().tenantId) };
  }

  @Post('bank-reconciliation-rules')
  @RequiresPermission('treasury.bank.manage')
  async createRule(@Body() body: BankRuleInput) {
    return { data: await this.bankFeeds.createRule(getTenantContext().tenantId, body) };
  }

  @Patch('bank-reconciliation-rules/:id')
  @RequiresPermission('treasury.bank.manage')
  async updateRule(@Param('id') id: string, @Body() body: Partial<BankRuleInput> & { status?: 'active' | 'inactive' }) {
    return { data: await this.bankFeeds.updateRule(getTenantContext().tenantId, id, body) };
  }

  @Delete('bank-reconciliation-rules/:id')
  @RequiresPermission('treasury.bank.manage')
  async deleteRule(@Param('id') id: string) {
    return { data: await this.bankFeeds.deleteRule(getTenantContext().tenantId, id) };
  }
}
