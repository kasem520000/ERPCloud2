import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { TreasuryService, type TransferInput, type VoucherInput, type VoucherPostInput, type ShiftCount } from './treasury.service.js';

@Controller()
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}
  @Get('vouchers')
  @RequiresPermission('treasury.view')
  vouchers(@Query('from') from?: string, @Query('to') to?: string, @Query('q') q?: string) {
    return this.treasury.vouchers(getTenantContext().tenantId, { from, to, q });
  }
  @Get('vouchers/:id') @RequiresPermission('treasury.view') getVoucher(@Param('id') id: string) { return this.treasury.getVoucher(getTenantContext().tenantId, id); }
  @Post('vouchers') @RequiresPermission('treasury.voucher.create') createVoucher(@Body() body: VoucherInput) { return this.treasury.createVoucher(getTenantContext().tenantId, body); }
  @Patch('vouchers/:id') @RequiresPermission('treasury.voucher.create') updateVoucher(@Param('id') id: string, @Body() body: Partial<VoucherInput>) { return this.treasury.updateDraftVoucher(getTenantContext().tenantId, id, body); }
  @Post('vouchers/:id/post') @RequiresPermission('treasury.voucher.post') postVoucher(@Param('id') id: string, @Body() body: VoucherPostInput) { return this.treasury.postVoucher(getTenantContext().tenantId, id, body); }
  @Post('vouchers/:id/void') @RequiresPermission('treasury.voucher.void') voidVoucher(@Param('id') id: string, @Body() body: { reason: string }) { return this.treasury.voidVoucher(getTenantContext().tenantId, id, body.reason); }
  @Post('vouchers/:id/cheque') @RequiresPermission('treasury.cheque.clear') cheque(@Param('id') id: string, @Body() body: { action: 'clear' | 'bounce' | 'collect' }) { return this.treasury.transitionCheque(getTenantContext().tenantId, id, body.action); }
  @Get('cash-transfers')
  @RequiresPermission('treasury.view')
  transfers(
    @Query('status') status?: string,
    @Query('number') number?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.treasury.transfers(getTenantContext().tenantId, { status, number, from, to });
  }
  @Post('cash-transfers') @RequiresPermission('treasury.transfer.manage') createTransfer(@Body() body: TransferInput) { return this.treasury.createTransfer(getTenantContext().tenantId, body); }
  @Post('cash-transfers/:id/send') @RequiresPermission('treasury.transfer.manage') sendTransfer(@Param('id') id: string) { return this.treasury.sendTransfer(getTenantContext().tenantId, id); }
  @Post('cash-transfers/:id/receive') @RequiresPermission('treasury.transfer.manage') receiveTransfer(@Param('id') id: string) { return this.treasury.receiveTransfer(getTenantContext().tenantId, id); }
  @Post('cash-transfers/:id/cancel') @RequiresPermission('treasury.transfer.manage') cancelTransfer(@Param('id') id: string) { return this.treasury.cancelTransfer(getTenantContext().tenantId, id); }
  @Get('expense-types') @RequiresPermission('treasury.view') expenseTypes() { return this.treasury.listExpenseTypes(getTenantContext().tenantId); }
  @Post('expense-types') @RequiresPermission('treasury.expensetype.manage') createExpenseType(@Body() body: { nameAr: string; nameEn?: string; accountId: string; costCenterId?: string }) { return this.treasury.createExpenseType(getTenantContext().tenantId, body); }
  @Patch('expense-types/:id') @RequiresPermission('treasury.expensetype.manage') updateExpenseType(@Param('id') id: string, @Body() body: { nameAr?: string; nameEn?: string | null; accountId?: string; costCenterId?: string | null }) { return this.treasury.updateExpenseType(getTenantContext().tenantId, id, body); }
  @Delete('expense-types/:id') @RequiresPermission('treasury.expensetype.manage') deleteExpenseType(@Param('id') id: string) { return this.treasury.deleteExpenseType(getTenantContext().tenantId, id); }
  @Post('shift-closes/open') @RequiresPermission('treasury.shift.close') openShift(@Body() body: { branchId: string; userId?: string }) { const ctx = getTenantContext(); return this.treasury.openShift(ctx.tenantId, body.branchId, body.userId ?? ctx.userId); }
  @Get('shift-closes/current') @RequiresPermission('treasury.view') currentShift(@Query('branch_id') branchId: string, @Query('user_id') userId?: string) { const ctx = getTenantContext(); return this.treasury.currentShift(ctx.tenantId, branchId, userId ?? ctx.userId); }
  @Get('shift-closes') @RequiresPermission('treasury.view') history(@Query('branch_id') branchId?: string) { return this.treasury.history(getTenantContext().tenantId, branchId); }
  @Post('shift-closes/:id/close') @RequiresPermission('treasury.shift.close') closeShift(@Param('id') id: string, @Body() body: { counts: ShiftCount[] }) { return this.treasury.closeShift(getTenantContext().tenantId, id, body.counts); }
  /**
   * 📊 إغلاقات اليومية — `frmCloseShift`. One row per close with the money the drawer
   * took (💵 النقدي · 🌐 الشبكة · 💰 مجموع الشبكة والنقدي · 📋 آجل · 🧾 الضريبة ·
   * 🏷️ الخصم · 💹 الصافي), the money that left it (📤 المصاريف · 🛒 المشتريات ·
   * 🚗 توصيل · ☕ الضيافة · 🛡️ تأمين), and the two an auditor reads first:
   * 🏦 رصيد الصندوق and 📉 الفرق. A closed row is read from its frozen summary; an
   * open one is computed live.
   */
  @Get('shift-closes/day-closes')
  @RequiresPermission('treasury.view')
  dayCloses(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('user_id') userId?: string,
    @Query('membership_id') membershipId?: string,
    @Query('branch_id') branchId?: string,
  ) {
    return this.treasury.dayCloses(getTenantContext().tenantId, { from, to, userId, membershipId, branchId });
  }

  /** One close with its counted notes and its summary lines — `frmCloseShiftDetails`. */
  @Get('shift-closes/:id')
  @RequiresPermission('treasury.view')
  shiftClose(@Param('id') id: string) {
    return this.treasury.shiftClose(getTenantContext().tenantId, id);
  }

  /**
   * 📒 قيد الإغلاق — `BindCloseShiftToEntry`. The close's entry carries the one number
   * no other document can know: 📉 الفرق between the drawer counted by hand and the
   * drawer the books expected. Everything else was posted when each invoice was posted.
   */
  @Post('shift-closes/:id/post')
  @RequiresPermission('treasury.shift.post')
  postShiftClose(@Param('id') id: string) {
    return this.treasury.postShiftClose(getTenantContext().tenantId, id);
  }

  @Get('shift-closes/:id/print-data') @RequiresPermission('treasury.view') printShift(@Param('id') id: string) { return this.treasury.printShiftData(getTenantContext().tenantId, id); }
  /**
   * 🏦 حركة الصندوق — `frmRptKhzna`. Reads the safe's **ledger** (not the voucher table),
   * so a sale, a salary and a transfer appear next to a receipt. `all=1` is ☑ كل الفترة;
   * otherwise `from`/`to` are required and a `رصيد سابق` line opens the statement.
   */
  @Get('cash-locations/:id/movements')
  @RequiresPermission('treasury.view')
  movements(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fromTime') fromTime?: string,
    @Query('toTime') toTime?: string,
    @Query('all') all?: string,
  ) {
    return this.treasury.movements(getTenantContext().tenantId, id, {
      from,
      to,
      fromTime,
      toTime,
      all: all === '1' || all === 'true',
    });
  }
  @Get('cash-locations/:id/balance') @RequiresPermission('treasury.view') cashLocationBalance(@Param('id') id: string, @Query('currency') currency?: string) { return this.treasury.getCashBalance(getTenantContext().tenantId, id, currency); }
  @Post('cash-locations/:id/recalc-balance') @RequiresPermission('treasury.transfer.manage') recalc(@Param('id') id: string, @Query('currency') currency?: string) { return this.treasury.recalcCashBalance(getTenantContext().tenantId, id, currency); }
}
