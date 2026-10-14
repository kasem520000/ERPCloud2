import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  HrmService,
  type AdjustmentInput,
  type AdjustmentTypeInput,
  type AdjustmentTypePatch,
  type DepartmentInput,
  type DepartmentPatch,
  type EmployeeInput,
  type EmployeePatch,
  type JobInput,
  type JobPatch,
  type PayRunInput,
  type PostRunInput,
  type RunInput,
  type SalaryPaymentInput,
} from './hrm.service.js';
import { PayrollComplianceService, type ComplianceSettingsInput, type WpsExportInput } from './payroll-compliance.service.js';

/**
 * The desktop sends `1`, `true` and `on` for the same checkbox (and the accounting
 * controller accepts all three); `undefined` has to stay `undefined` so the service can
 * tell «لم يُرسل شيء» from «أُرسل لا» — `فترة كاملة` defaults to whether a `من` was sent.
 */
function flag(value?: string): boolean | undefined {
  return value === undefined ? undefined : value === '1' || value === 'true' || value === 'on';
}

@Controller('hrm')
export class HrmController {
  constructor(
    private readonly hrm: HrmService,
    private readonly compliance: PayrollComplianceService,
  ) {}
  @Get('departments') @RequiresPermission('hrm.view') departments() { return this.hrm.listDepartments(getTenantContext().tenantId); }
  @Post('departments') @RequiresPermission('hrm.manage') createDepartment(@Body() body: DepartmentInput) { return this.hrm.createDepartment(getTenantContext().tenantId, body); }
  @Patch('departments/:id') @RequiresPermission('hrm.manage') updateDepartment(@Param('id') id: string, @Body() body: DepartmentPatch) { return this.hrm.updateDepartment(getTenantContext().tenantId, id, body); }
  @Delete('departments/:id') @RequiresPermission('hrm.manage') deleteDepartment(@Param('id') id: string) { return this.hrm.deleteDepartment(getTenantContext().tenantId, id); }
  @Get('jobs') @RequiresPermission('hrm.view') jobs() { return this.hrm.listJobs(getTenantContext().tenantId); }
  @Post('jobs') @RequiresPermission('hrm.manage') createJob(@Body() body: JobInput) { return this.hrm.createJob(getTenantContext().tenantId, body); }
  @Patch('jobs/:id') @RequiresPermission('hrm.manage') updateJob(@Param('id') id: string, @Body() body: JobPatch) { return this.hrm.updateJob(getTenantContext().tenantId, id, body); }
  @Delete('jobs/:id') @RequiresPermission('hrm.manage') deleteJob(@Param('id') id: string) { return this.hrm.deleteJob(getTenantContext().tenantId, id); }
  /** 👤 قائمة الموظفين — `frmEmployees.xaml` «قائمة الموظفين» + «اسم الموظف:» بحث. */
  @Get('employees') @RequiresPermission('hrm.view') employees(@Query('q') q?: string, @Query('status') status?: string, @Query('branch_id') branchId?: string, @Query('department_id') departmentId?: string, @Query('job_id') jobId?: string) { return this.hrm.listEmployees(getTenantContext().tenantId, { q, status, branchId, departmentId, jobId }); }
  @Get('employees/:id') @RequiresPermission('hrm.view') readEmployee(@Param('id') id: string) { return this.hrm.readEmployee(getTenantContext().tenantId, id); }
  @Post('employees') @RequiresPermission('hrm.manage') createEmployee(@Body() body: EmployeeInput) { return this.hrm.createEmployee(getTenantContext().tenantId, body); }
  @Patch('employees/:id') @RequiresPermission('hrm.manage') updateEmployee(@Param('id') id: string, @Body() body: EmployeePatch) { return this.hrm.updateEmployee(getTenantContext().tenantId, id, body); }
  @Delete('employees/:id') @RequiresPermission('hrm.manage') deleteEmployee(@Param('id') id: string) { return this.hrm.deleteEmployee(getTenantContext().tenantId, id); }
  @Post('attendance/import') @RequiresPermission('hrm.manage') importAttendance(@Body() body: { csv: string }) { return this.hrm.importAttendanceCsv(getTenantContext().tenantId, body.csv); }
  @Get('attendance/summary') @RequiresPermission('hrm.view') attendanceSummary(@Query('enroll') enroll: string, @Query('from') from: string, @Query('to') to: string) { return this.hrm.attendanceSummary(getTenantContext().tenantId, enroll, from, to); }
  /** 🎁 الحوافز والجزاءات — `frmEmpSalaryAddSub` «إدخال الحوافز والخصومات للموظفين». */
  @Get('adjustment-types') @RequiresPermission('hrm.view') adjustmentTypes() { return this.hrm.listAdjustmentTypes(getTenantContext().tenantId); }
  @Post('adjustment-types') @RequiresPermission('hrm.manage') createAdjustmentType(@Body() body: AdjustmentTypeInput) { return this.hrm.createAdjustmentType(getTenantContext().tenantId, body); }
  @Patch('adjustment-types/:id') @RequiresPermission('hrm.manage') updateAdjustmentType(@Param('id') id: string, @Body() body: AdjustmentTypePatch) { return this.hrm.updateAdjustmentType(getTenantContext().tenantId, id, body); }
  @Delete('adjustment-types/:id') @RequiresPermission('hrm.manage') deleteAdjustmentType(@Param('id') id: string) { return this.hrm.deleteAdjustmentType(getTenantContext().tenantId, id); }
  @Get('adjustments') @RequiresPermission('hrm.view') adjustments(@Query('employee_id') employeeId?: string, @Query('type_code') typeCode?: string, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) { return this.hrm.listAdjustments(getTenantContext().tenantId, { employeeId, typeCode, status, from, to }); }
  @Get('adjustments/:id') @RequiresPermission('hrm.view') readAdjustment(@Param('id') id: string) { return this.hrm.readAdjustment(getTenantContext().tenantId, id); }
  @Post('adjustments') @RequiresPermission('hrm.manage') createAdjustment(@Body() body: AdjustmentInput) { return this.hrm.createAdjustment(getTenantContext().tenantId, body); }
  @Post('adjustments/:id/approve') @RequiresPermission('hrm.adjust.approve') approveAdjustment(@Param('id') id: string) { return this.hrm.approveAdjustment(getTenantContext().tenantId, id); }
  @Delete('adjustments/:id') @RequiresPermission('hrm.manage') deleteAdjustment(@Param('id') id: string) { return this.hrm.deleteAdjustment(getTenantContext().tenantId, id); }
  @Post('payroll/preview') @RequiresPermission('hrm.view') preview(@Body() body: RunInput) { return this.hrm.preview(getTenantContext().tenantId, body); }
  @Get('payroll/runs') @RequiresPermission('hrm.view') runs() { return this.hrm.listRuns(getTenantContext().tenantId); }
  @Post('payroll/runs') @RequiresPermission('hrm.manage') createRun(@Body() body: RunInput) { return this.hrm.createRun(getTenantContext().tenantId, body); }
  @Get('payroll/runs/:id') @RequiresPermission('hrm.view') readRun(@Param('id') id: string) { return this.hrm.readRun(getTenantContext().tenantId, id); }
  @Post('payroll/runs/:id/post') @RequiresPermission('hrm.payroll.post') postRun(@Param('id') id: string, @Body() body: PostRunInput) { return this.hrm.postRun(getTenantContext().tenantId, id, body); }
  @Post('payroll/runs/:id/pay') @RequiresPermission('hrm.payroll.post') payRun(@Param('id') id: string, @Body() body: PayRunInput) { return this.hrm.payRun(getTenantContext().tenantId, id, body); }
  /** 📄 كشف حساب موظف — `frmEmpAccountGet` «كشف حساب موظف»: the employee's own account, entry by entry. */
  @Get('employee-statement')
  @RequiresPermission('hrm.view')
  employeeStatement(
    @Query('employee_id') employeeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branch_id') branchId?: string,
    @Query('full_period') fullPeriod?: string,
    @Query('hide_previous_balance') hidePreviousBalance?: string,
    @Query('detailed') detailed?: string,
  ) {
    return this.hrm.employeeStatement(getTenantContext().tenantId, {
      employeeId,
      from,
      to,
      branchId,
      fullPeriod: flag(fullPeriod),
      hidePreviousBalance: flag(hidePreviousBalance),
      detailed: flag(detailed),
    });
  }

  /** 📈 حركات الموظف — `frmEmpInvs` «مبيعات ومشتريات موظف خلال الفترة»: what a salesman sold, line by line. */
  @Get('employee-movements')
  @RequiresPermission('hrm.view')
  employeeMovements(
    @Query('employee_id') employeeId?: string,
    @Query('all_employees') allEmployees?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('movement_type') movementType?: string,
    @Query('branch_id') branchId?: string,
  ) {
    const type = movementType === 'sales' || movementType === 'returns' ? movementType : 'all';
    return this.hrm.employeeMovements(getTenantContext().tenantId, {
      employeeId,
      allEmployees: flag(allEmployees),
      from,
      to,
      movementType: type,
      branchId,
    });
  }

  /** 📊 تقرير الرواتب — `frmRptSalary` «💼 تقرير الرواتب»: every إذن صرف, month by month. */
  @Get('reports/salary')
  @RequiresPermission('hrm.view')
  salaryReport(
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('all_period') allPeriod?: string,
    @Query('branch_id') branchId?: string,
  ) {
    return this.hrm.salaryReport(getTenantContext().tenantId, {
      month: month?.trim() || undefined,
      year: year?.trim() || undefined,
      allPeriod: flag(allPeriod),
      branchId,
    });
  }

  /** 💵 دفع الرواتب — `frmSalaryPay` «إذن صرف راتب»: one document per employee per month. */
  @Get('salary-payments') @RequiresPermission('hrm.view') salaryPayments(
    @Query('employee_id') employeeId?: string,
    @Query('year_month') yearMonth?: string,
    @Query('branch_id') branchId?: string,
    @Query('method') method?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('number') number?: string,
  ) { return this.hrm.listSalaryPayments(getTenantContext().tenantId, { employeeId, yearMonth, branchId, method, from, to, number }); }
  @Get('salary-payments/:id') @RequiresPermission('hrm.view') readSalaryPayment(@Param('id') id: string) { return this.hrm.readSalaryPayment(getTenantContext().tenantId, id); }
  @Post('salary-payments') @RequiresPermission('hrm.payroll.post') createSalaryPayment(@Body() body: SalaryPaymentInput) { return this.hrm.createSalaryPayment(getTenantContext().tenantId, body); }
  @Delete('salary-payments/:id') @RequiresPermission('hrm.payroll.post') deleteSalaryPayment(@Param('id') id: string) { return this.hrm.deleteSalaryPayment(getTenantContext().tenantId, id); }
  @Post('payroll/runs/:id/reverse') @RequiresPermission('hrm.payroll.post') reverseRun(@Param('id') id: string, @Body() body: { reason: string }) { return this.hrm.reverseRun(getTenantContext().tenantId, id, body.reason); }

  @Get('compliance/alerts')
  @RequiresPermission('hrm.view')
  alerts(@Query('within_days') withinDays?: string) {
    const days = Number(withinDays ?? 30);
    return this.compliance.alerts(getTenantContext().tenantId, Number.isFinite(days) ? days : 30);
  }

  @Get('payroll/compliance-settings')
  @RequiresPermission('hrm.view')
  complianceSettings() {
    return this.compliance.settings(getTenantContext().tenantId);
  }

  @Post('payroll/compliance-settings')
  @RequiresPermission('payroll.wps.export')
  saveComplianceSettings(@Body() body: ComplianceSettingsInput) {
    return this.compliance.saveSettings(getTenantContext().tenantId, body ?? {});
  }

  @Get('payroll/runs/:id/wps-preview')
  @RequiresPermission('payroll.wps.export')
  wpsPreview(@Param('id') id: string, @Query('bank_code') bankCode?: string, @Query('establishment_id') establishmentId?: string) {
    return this.compliance.wpsPreview(getTenantContext().tenantId, id, { bankCode, establishmentId });
  }

  @Post('payroll/runs/:id/wps-export')
  @RequiresPermission('payroll.wps.export')
  wpsExport(@Param('id') id: string, @Body() body: WpsExportInput) {
    return this.compliance.wpsExport(getTenantContext().tenantId, id, body ?? {});
  }

  @Get('payroll/runs/:id/wps')
  @RequiresPermission('payroll.wps.export')
  wpsFiles(@Param('id') id: string) {
    return this.compliance.listWps(getTenantContext().tenantId, id);
  }

  @Get('payroll/wps/:fileId')
  @RequiresPermission('payroll.wps.export')
  wpsFile(@Param('fileId') fileId: string) {
    return this.compliance.readWps(getTenantContext().tenantId, fileId);
  }

  @Post('payroll/wps/:fileId/status')
  @RequiresPermission('payroll.wps.export')
  wpsStatus(@Param('fileId') fileId: string, @Body() body: { status?: string; bankResponse?: string | null }) {
    return this.compliance.updateWps(getTenantContext().tenantId, fileId, body ?? {});
  }

  @Get('payroll/runs/:id/gosi-preview')
  @RequiresPermission('payroll.wps.export')
  gosiPreview(@Param('id') id: string) {
    return this.compliance.gosiPreview(getTenantContext().tenantId, id);
  }

  @Post('payroll/runs/:id/gosi-export')
  @RequiresPermission('payroll.wps.export')
  gosiExport(@Param('id') id: string) {
    return this.compliance.gosiExport(getTenantContext().tenantId, id);
  }

  @Get('payroll/runs/:id/gosi')
  @RequiresPermission('payroll.wps.export')
  gosiFiles(@Param('id') id: string) {
    return this.compliance.listGosi(getTenantContext().tenantId, id);
  }
}
