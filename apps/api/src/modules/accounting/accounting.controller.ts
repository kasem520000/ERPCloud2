import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { getTenantContext, tryGetAuthContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  AccountingService,
  type AccountInput,
  type AccountPatch,
  type CostCenterInput,
  type CostCenterPatch,
  type FiscalPeriodInput,
  type FiscalPeriodPatch,
  type FiscalYearInput,
  type JournalLineInput,
} from './accounting.service.js';

/** The desktops sends `1`, `true` and `on` for the same checkbox; accept all three. */
function on(value?: string): boolean {
  return value === '1' || value === 'true' || value === 'on';
}

@ApiTags('accounting')
@Controller()
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  /**
   * 📂 شجرة الحسابات و 📋 تفاصيل الحسابات — `frmAccountsDirectory.xaml`. `q` searches
   * كود/اسم الحساب (the window's 🔍 → `frmAccountSrch`), `type` and `branchId` narrow the
   * directory, and `withBalances=1` adds the الرصيد each node shows (`trBalance` in the
   * desktop's tree) — rolled up from **posted** entries only, because a balance that
   * counts drafts is a number that disappears.
   */
  @Get('accounts')
  @RequiresPermission('accounting.account.view')
  async listAccounts(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('branch_id') branchId?: string,
    @Query('with_balances') withBalances?: string,
  ) {
    return {
      data: await this.accounting.listAccounts(getTenantContext().tenantId, {
        q,
        type,
        branchId,
        withBalances: withBalances === '1' || withBalances === 'true',
      }),
    };
  }

  @Post('accounts')
  @RequiresPermission('accounting.account.manage')
  async createAccount(@Body() body: AccountInput) {
    return { data: await this.accounting.createAccount(getTenantContext().tenantId, body) };
  }

  @Patch('accounts/:id')
  @RequiresPermission('accounting.account.manage')
  @ApiOperation({ summary: 'Edit an account card' })
  async updateAccount(@Param('id') id: string, @Body() body: AccountPatch) {
    return { data: await this.accounting.updateAccount(getTenantContext().tenantId, id, body) };
  }

  @Delete('accounts/:id')
  @RequiresPermission('accounting.account.manage')
  @ApiOperation({ summary: 'Delete an unused account' })
  async deleteAccount(@Param('id') id: string) {
    return { data: await this.accounting.deleteAccount(getTenantContext().tenantId, id) };
  }

  @Get('accounts/:id')
  @RequiresPermission('accounting.account.view')
  async readAccount(@Param('id') id: string) {
    return { data: await this.accounting.readAccount(getTenantContext().tenantId, id) };
  }

  /**
   * 🗂️ إدارة الفترات المحاسبية — the grid of `Form_WPF/FrmAccountingPeriods.xaml`
   * (`الرقم · اسم الفترة · تاريخ البداية · تاريخ النهاية · نشطة · مغلقة · أغلقت بواسطة ·
   * تاريخ الإغلاق · ملاحظات`), newest period first, as `GetAllPeriods` orders it.
   */
  @Get('fiscal-periods')
  @RequiresPermission('accounting.period.view')
  @ApiOperation({ summary: 'List fiscal periods with their card fields' })
  async listPeriods() {
    return { data: await this.accounting.listPeriods(getTenantContext().tenantId) };
  }

  /** ➕ إضافة — the period card of `FrmAccountingPeriods`. */
  @Post('fiscal-periods')
  @RequiresPermission('accounting.period.close')
  @ApiOperation({ summary: 'Add an accounting period (اسم الفترة · تاريخ من · تاريخ إلى · نشطة · ملاحظات)' })
  async createPeriod(@Body() body: FiscalPeriodInput) {
    return { data: await this.accounting.createPeriod(getTenantContext().tenantId, body, tryGetAuthContext()?.userId) };
  }

  /** ✏️ تعديل — a closed period is refused with «لا يمكن تعديل فترة مغلقة…». */
  @Patch('fiscal-periods/:id')
  @RequiresPermission('accounting.period.close')
  @ApiOperation({ summary: 'Edit an open accounting period' })
  async updatePeriod(@Param('id') id: string, @Body() body: FiscalPeriodPatch) {
    return { data: await this.accounting.updatePeriod(getTenantContext().tenantId, id, body, tryGetAuthContext()?.userId) };
  }

  /** 🗑️ حذف — a closed period, or one with entries on it, is refused. */
  @Delete('fiscal-periods/:id')
  @RequiresPermission('accounting.period.close')
  @ApiOperation({ summary: 'Delete an open accounting period that has no journal entries' })
  async deletePeriod(@Param('id') id: string) {
    return { data: await this.accounting.deletePeriod(getTenantContext().tenantId, id) };
  }

  /** ⚡ تفعيل — one active period per tenant; a closed one is refused. */
  @Post('fiscal-periods/:id/activate')
  @RequiresPermission('accounting.period.close')
  @ApiOperation({ summary: 'Make a period the active one (فترة نشطة حالياً)' })
  async activatePeriod(@Param('id') id: string) {
    return { data: await this.accounting.activatePeriod(getTenantContext().tenantId, id) };
  }

  @Post('fiscal-periods/:id/close')
  @RequiresPermission('accounting.period.close')
  async closePeriod(@Param('id') id: string) {
    await this.accounting.closePeriod(getTenantContext().tenantId, id, tryGetAuthContext()?.userId);
    return { data: { id, status: 'closed' } };
  }

  @Post('fiscal-periods/:id/reopen')
  @RequiresPermission('accounting.period.reopen')
  async reopenPeriod(@Param('id') id: string, @Body() body: { reason: string }) {
    await this.accounting.reopenPeriod(getTenantContext().tenantId, id, body.reason);
    return { data: { id, status: 'open' } };
  }

  @Post('fiscal-periods/:id/modules/:module/lock')
  @RequiresPermission('accounting.period.close')
  async lockModule(@Param('id') id: string, @Param('module') module: string) {
    return { data: await this.accounting.lockModule(getTenantContext().tenantId, id, module) };
  }

  @Post('fiscal-periods/:id/modules/:module/unlock')
  @RequiresPermission('accounting.period.reopen')
  async unlockModule(@Param('id') id: string, @Param('module') module: string) {
    return { data: await this.accounting.unlockModule(getTenantContext().tenantId, id, module) };
  }

  /**
   * ⚖️ ميزان المراجعة — `Form_WPF/frmRptBalances.xaml` («أرصدة الحسابات») printing
   * `Reports/rptAccountBalance.repx`. The window's filter panel is
   * `الفروع (كل الفروع) · الحساب الرئيسي · المندوب · الفترة (كل الفترة / من / إلى)` with
   * `عرض`, and the report's columns are
   * `رقم الحساب · اسم الحساب · افتتاحي (مدين/دائن) · خلال الفترة المحددة (مدين/دائن) ·
   * ختامي (مدين/دائن) · الحالة`.
   *
   * With no `from` there is no `افتتاحي` and the whole ledger is the period — which is
   * what this endpoint returned before it took a period at all, and every row still
   * carries its `accountId` / `debit` / `credit` / `balance`.
   */
  @Get('statements/trial-balance')
  @RequiresPermission('accounting.reports.view')
  @ApiOperation({ summary: 'Trial balance (ميزان المراجعة) with opening, movement and closing columns' })
  async trialBalance(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branch_id') branchId?: string,
    @Query('fiscal_period_id') fiscalPeriodId?: string,
    @Query('salesman_id') salesmanId?: string,
    @Query('parent_id') parentId?: string,
  ) {
    const mizan = await this.accounting.trialBalance(getTenantContext().tenantId, {
      from,
      to,
      branchId,
      fiscalPeriodId,
      salesmanId,
      parentId,
    });
    return { data: mizan.rows, totals: mizan.totals };
  }

  /**
   * 📊 أرباح وخسائر حسابات رئيسية — `Form_WPF/frmRptIncomeStatement.xaml` over
   * `Reports/RptIncomeStatement.repx`: the revenue and expense accounts
   * (`Accounts_Index.FinalAcc = 2`, i.e. codes beginning `3` or `4`), each carried up to
   * its parent account, then `قيمة مخزون بضاعة آخر المدة حتى هذا التاريخ` and
   * `صافي أرباح العام` / `صافي خسائر العام` under them.
   *
   * `summary=0` keeps one row per account instead of one per parent, and
   * `with_stock=0` drops the stock row.
   */
  @Get('statements/income-statement')
  @RequiresPermission('accounting.reports.view')
  @ApiOperation({ summary: 'Income statement (أرباح وخسائر حسابات رئيسية)' })
  async incomeStatement(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branch_id') branchId?: string,
    @Query('summary') summary?: string,
    @Query('with_stock') withStock?: string,
  ) {
    const statement = await this.accounting.incomeStatement(getTenantContext().tenantId, {
      from,
      to,
      branchId,
      summary: summary === undefined ? undefined : on(summary),
      withStock: withStock === undefined ? undefined : on(withStock),
    });
    return { data: statement.rows, totals: statement.totals };
  }

  /**
   * 📄 كشف الحساب — `Form_WPF/frmAccountBalance.xaml` («كشف حساب تفصيلي») with the
   * account-hierarchy option of `frmAccountsStatement.xaml` («كشف حساب رئيسي»).
   *
   * `from`/`to` bound the period (`من تاريخ` / `إلى تاريخ`), `branch_id` is `الفرع`
   * (absent = `كل الفروع`), `with_descendants=1` reports the account *and* its branch,
   * `summary=1` is `تجميعي (ملخص)` and the default is `تفصيلي (كامل)`,
   * `full_period=1` is `فترة كاملة (من البداية)` and `hide_previous_balance=1` is
   * `عدم إظهار الرصيد السابق`.
   *
   * The row list under `data` is unchanged for a caller that sends nothing; `totals` and
   * `account` are additions beside it.
   */
  @Get('statements/general-ledger/:accountId')
  @RequiresPermission('accounting.reports.view')
  async generalLedger(
    @Param('accountId') accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    /** ⏰ الوقت — `frmAccountBalance`'s two time boxes, one at each end of the period. */
    @Query('from_time') fromTime?: string,
    @Query('to_time') toTime?: string,
    @Query('branch_id') branchId?: string,
    @Query('with_descendants') withDescendants?: string,
    @Query('summary') summary?: string,
    @Query('full_period') fullPeriod?: string,
    @Query('hide_previous_balance') hidePreviousBalance?: string,
    /** 📋 نوع القيد — one of `STATEMENT_KINDS`, as `cmbEntryType` lists them. */
    @Query('kind') kind?: string,
  ) {
    const statement = await this.accounting.accountStatement(getTenantContext().tenantId, accountId, {
      from,
      to,
      fromTime,
      toTime,
      branchId,
      kind,
      withDescendants: on(withDescendants),
      summary: on(summary),
      // `فترة كاملة (من البداية)` is on until someone names a date.
      fullPeriod: on(fullPeriod) || !(from || to),
      hidePreviousBalance: on(hidePreviousBalance),
    });
    return { data: statement.rows, totals: statement.totals, account: statement.account };
  }

  // ------------------------------------------------------------- cost centres

  /**
   * 🌳 شجرة مراكز التكلفة — `Form_WPF/frmCostCenter.xaml`. `q` searches الرقم or الاسم,
   * `branch_id` narrows it, and `with_balances=1` adds to every centre the figure the
   * tree shows on its node: its own posted movement plus its children's. A caller that
   * sends nothing gets exactly the list this endpoint always returned.
   */
  @Get('cost-centers')
  @RequiresPermission('accounting.account.view')
  @ApiOperation({ summary: 'List cost centres, optionally as a tree with balances' })
  async listCostCenters(
    @Query('q') q?: string,
    @Query('branch_id') branchId?: string,
    @Query('with_balances') withBalances?: string,
  ) {
    return {
      data: await this.accounting.listCostCenters(getTenantContext().tenantId, {
        q,
        branchId,
        withBalances: on(withBalances),
      }),
    };
  }

  /**
   * 📊 كشف مركز الكلفة — `Form_WPF/frmCostCenterBalance.xaml` («تقرير مركز كلفة»), the
   * account statement pointed at a cost centre: the same `رصيد سابق` row, the same
   * `تجميعي`/`تفصيلي` choice and the same running الرصيد with `📌 الحالة`, plus the
   * window's own `اسم الحساب` and `🌿 الفرع` filters.
   */
  @Get('statements/cost-center/:costCenterId')
  @RequiresPermission('accounting.reports.view')
  @ApiOperation({ summary: 'Cost-centre statement (كشف مركز الكلفة)' })
  async costCenterStatement(
    @Param('costCenterId') costCenterId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    /** ⏰ الوقت — نفس صندوقي الوقت في `frmCostCenterBalance` و `frmAccountBalance`. */
    @Query('from_time') fromTime?: string,
    @Query('to_time') toTime?: string,
    @Query('branch_id') branchId?: string,
    @Query('account_id') accountId?: string,
    @Query('summary') summary?: string,
    @Query('full_period') fullPeriod?: string,
    @Query('hide_previous_balance') hidePreviousBalance?: string,
    /** 📋 نوع القيد — one of `STATEMENT_KINDS`, as `cmbEntryType` lists them. */
    @Query('kind') kind?: string,
  ) {
    const statement = await this.accounting.costCenterStatement(getTenantContext().tenantId, costCenterId, {
      from,
      to,
      fromTime,
      toTime,
      branchId,
      accountId,
      kind,
      summary: on(summary),
      fullPeriod: on(fullPeriod) || !(from || to),
      hidePreviousBalance: on(hidePreviousBalance),
    });
    return { data: statement.rows, totals: statement.totals, costCenter: statement.costCenter };
  }

  @Post('cost-centers')
  @RequiresPermission('accounting.account.manage')
  @ApiOperation({ summary: 'Create a cost centre' })
  async createCostCenter(@Body() body: CostCenterInput) {
    return { data: await this.accounting.createCostCenter(getTenantContext().tenantId, body) };
  }

  @Patch('cost-centers/:id')
  @RequiresPermission('accounting.account.manage')
  @ApiOperation({ summary: 'Edit a cost centre' })
  async updateCostCenter(@Param('id') id: string, @Body() body: CostCenterPatch) {
    return { data: await this.accounting.updateCostCenter(getTenantContext().tenantId, id, body) };
  }

  @Delete('cost-centers/:id')
  @RequiresPermission('accounting.account.manage')
  @ApiOperation({ summary: 'Delete an unused cost centre' })
  async deleteCostCenter(@Param('id') id: string) {
    return { data: await this.accounting.deleteCostCenter(getTenantContext().tenantId, id) };
  }

  // ------------------------------------------------------------- fiscal calendar

  @Get('fiscal-years')
  @RequiresPermission('accounting.period.view')
  @ApiOperation({ summary: 'List fiscal years' })
  async listFiscalYears() {
    return { data: await this.accounting.listFiscalYears(getTenantContext().tenantId) };
  }

  @Post('fiscal-years')
  @RequiresPermission('accounting.period.close')
  @ApiOperation({ summary: 'Open a fiscal year and generate its monthly periods' })
  async createFiscalYear(@Body() body: FiscalYearInput) {
    return { data: await this.accounting.createFiscalYear(getTenantContext().tenantId, body) };
  }

  // ------------------------------------------------------------- journal register

  @Get('journal-entries')
  @RequiresPermission('accounting.reports.view')
  @ApiOperation({ summary: 'Journal register (القيود اليومية) with per-entry totals' })
  async listJournalEntries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('fiscalPeriodId') fiscalPeriodId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return {
      data: await this.accounting.listJournalEntries(getTenantContext().tenantId, {
        from,
        to,
        branchId,
        fiscalPeriodId,
        status,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  /**
   * R10 — ⏮ ◀ ▶ ⏭ من نافذة القيد (`FrmNewEntry.xaml` L427–431). النطاق هو نطاق السجل
   * نفسه (`from`/`to`/`branchId`/`fiscalPeriodId`/`status`)، فلا يقفز السهم إلى قيدٍ
   * خارج ما يراه المُدخِل.
   */
  @Get('journal-entries/:id/neighbours')
  @RequiresPermission('accounting.reports.view')
  @ApiOperation({ summary: 'The entries around this one inside the register scope (⏮ ◀ ▶ ⏭)' })
  async journalNeighbours(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('fiscalPeriodId') fiscalPeriodId?: string,
    @Query('status') status?: string,
  ) {
    return {
      data: await this.accounting.journalNeighbours(getTenantContext().tenantId, id, {
        from,
        to,
        branchId,
        fiscalPeriodId,
        status,
      }),
    };
  }

  @Get('journal-entries/:id')
  @RequiresPermission('accounting.reports.view')
  @ApiOperation({ summary: 'Read one journal entry with its lines' })
  async readJournalEntry(@Param('id') id: string) {
    return { data: await this.accounting.readJournalEntry(getTenantContext().tenantId, id) };
  }

  @Post('journal-entries')
  @RequiresPermission('accounting.journal.post')
  @ApiOperation({
    summary: 'Post a balanced journal entry (branch and fiscal period are derived from the date when omitted)',
  })
  async postJournal(
    @Body()
    body: {
      branchId?: string;
      fiscalPeriodId?: string;
      date: string;
      description?: string;
      lines: JournalLineInput[];
      sourceType?: string;
      sourceId?: string;
      idempotencyKey?: string;
      /** ⏰ الوقت — `FrmNewEntry.xaml` `txtTime`. */
      time?: string | null;
      /** ✅ قيد ضريبي — `FrmNewEntry.xaml` `chkIsVAT`. */
      isVat?: boolean;
    },
  ) {
    return { data: await this.accounting.postJournal(getTenantContext().tenantId, body) };
  }

  @Post('journal-entries/:id/reverse')
  @RequiresPermission('accounting.journal.reverse')
  async reverseJournal(@Param('id') id: string, @Body() body: { branchId: string; fiscalPeriodId: string; date: string; reason: string }) {
    return { data: await this.accounting.reverseJournal(getTenantContext().tenantId, id, body) };
  }
}
