import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { accounts, costCenters, fiscalPeriods, journalEntries } from './accounting.js';
import { branches, cashLocations } from './organization.js';
import { memberships } from './tenancy.js';
import { vouchers } from './treasury.js';
import { tenants, users } from './platform.js';

const cashValue = { precision: 20, scale: 4, mode: 'string' as const };

/**
 * 🏢 الإدارات والأقسام — `Form_WPF/frmManagement.xaml` («الإدارات») and
 * `frmDepartments.xaml` («إدخال بيانات الإدارات والأقسام») are two windows over one
 * parent/child pair: `Managements(id, name)` is the parent of
 * `Departments(id, manag_id, name)`. One self-referencing table carries both: a row with
 * no parent *is* an إدارة, a row with one is a قسم, and `الإدارة` on the employee card
 * is the assigned row's parent rather than a second column that could disagree with it.
 */
export const departments = pgTable('departments', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }), code: text('code').notNull(), name: text('name').notNull(), parentId: uuid('parent_id').references((): AnyPgColumn => departments.id, { onDelete: 'restrict' }), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ codeKey: uniqueIndex('departments_tenant_code_key').on(table.tenantId, table.code).where(sql`deleted_at IS NULL`), branchIdx: index('departments_branch_idx').on(table.tenantId, table.branchId), parentIdx: index('departments_parent_idx').on(table.tenantId, table.parentId) }));

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), code: text('code').notNull(), name: text('name').notNull(), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ codeKey: uniqueIndex('jobs_tenant_code_key').on(table.tenantId, table.code).where(sql`deleted_at IS NULL`) }));

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), employeeNo: text('employee_no').notNull(), name: text('name').notNull(), branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }), departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }), jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }), membershipId: uuid('membership_id').references(() => memberships.id, { onDelete: 'set null' }), status: text('status').notNull().default('active'), hireDate: date('hire_date'), birthDate: date('birth_date'), insuranceNo: text('insurance_no'), nationalId: text('national_id'), /** إقامة — used by the HR dashboard expiry alert. */ iqamaExpiresOn: date('iqama_expires_on'), /** تأمين طبي/تأمينات — expiry watched beside the iqama. */ insuranceExpiresOn: date('insurance_expires_on'), /** `old` = registered before 2024-07-03; `new` = the post-reform annuity schedule. Null follows hire date. */ gosiScheme: text('gosi_scheme'), maritalStatus: text('marital_status'), nationality: text('nationality'), gender: text('gender'), phone: text('phone'), mobile: text('mobile'), email: text('email'), address: text('address'), notes: text('notes'), /** 👤 رقم الحساب — the account `frmEmployees.xaml.cs` L600 writes for the employee. */ employeeAccountId: uuid('employee_account_id').references(() => accounts.id, { onDelete: 'set null' }), salaryComponents: jsonb('salary_components').$type<Record<string, string>>().notNull().default({}), bank: jsonb('bank').$type<Record<string, string | undefined>>().notNull().default({}), salaryExpenseAccountId: uuid('salary_expense_account_id').references(() => accounts.id, { onDelete: 'restrict' }), salaryPayableAccountId: uuid('salary_payable_account_id').references(() => accounts.id, { onDelete: 'restrict' }), costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }),
  /** 🖼️ صورة الموظف — `frmEmployees.xaml` L195 `imgPersonal` + `btnImgAdd` / `btnImgDelete`. The desktop stores the image as a file path in `Employees.PhotoPath`; the cloud stores it as a file row (`files`) and keeps the id here, so the same upload flow (`/files/presign` → PUT → `/finalize`) works for employees as for company logos. */
  photoFileId: uuid('photo_file_id'),
  ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (table) => ({ noKey: uniqueIndex('employees_tenant_no_key').on(table.tenantId, table.employeeNo).where(sql`deleted_at IS NULL`), branchIdx: index('employees_branch_idx').on(table.tenantId, table.branchId), memberIdx: index('employees_membership_idx').on(table.tenantId, table.membershipId), accountIdx: index('employees_account_idx').on(table.tenantId, table.employeeAccountId) }));

export const attendanceLogs = pgTable('attendance_logs', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'cascade' }), machine: text('machine').notNull(), enroll: text('enroll').notNull(), punchAt: timestamp('punch_at', { withTimezone: true }).notNull(), direction: text('direction').notNull(), fingerprint: text('fingerprint').notNull(), payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ fingerprintKey: uniqueIndex('attendance_logs_fingerprint_key').on(table.tenantId, table.fingerprint), employeeIdx: index('attendance_logs_employee_idx').on(table.tenantId, table.employeeId, table.punchAt), enrollIdx: index('attendance_logs_enroll_idx').on(table.tenantId, table.enroll, table.punchAt) }));

/**
 * 🎁 أنواع الحوافز والجزاءات — the desktop's `SalaryAddSubTypes` lookup
 * (`frmEmpSalaryAddSub.xaml.cs` L173). Its rows are not in the repository, but the
 * code-behind fixes three of them by id: 1 = مكافأة, 2 = خصم, 3 = سلفة — and it is the
 * type that decides whether the checkbox says «✅ تضاف على الراتب» or
 * «✂️ تخصم من الراتب» (`CmbType_EditValueChanged` L540).
 */
export const salaryAdjustmentTypes = pgTable(
  'salary_adjustment_types',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** `addition` | `deduction` — the sign the payroll run gives the amount. */
    kind: text('kind').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (table) => ({
    codeKey: uniqueIndex('salary_adjustment_types_tenant_code_key').on(table.tenantId, table.code).where(sql`deleted_at IS NULL`),
    tenantIdx: index('salary_adjustment_types_tenant_idx').on(table.tenantId, table.sortOrder),
  }),
);

export const salaryAdjustments = pgTable('salary_adjustments', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }), kind: text('kind').notNull(), componentCode: text('component_code').notNull(), valueText: numeric('value_text', cashValue).notNull(), startsOn: date('starts_on').notNull(), endsOn: date('ends_on'), recurring: boolean('recurring').notNull().default(false), subFromSalary: boolean('sub_from_salary').notNull().default(false), status: text('status').notNull().default('draft'), cashLocationId: uuid('cash_location_id').references(() => cashLocations.id, { onDelete: 'set null' }), journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'set null' }), reason: text('reason'),
  /** 🎁 رقم السند — `frmEmpSalaryAddSub.xaml.cs` L225 `LoadNextNumber`: `MAX(id)+1`. */
  number: text('number'),
  /** 🎁 النوع — `cmbType` over `SalaryAddSubTypes`. */
  typeId: uuid('type_id').references(() => salaryAdjustmentTypes.id, { onDelete: 'restrict' }),
  /** 🎁 طريقة الدفع — `rdCash` (نقدي) | `rdCheck` (بنكي); the صندوق or البنك is `cashLocationId`. */
  paymentMethod: text('payment_method'),
  ...baseAuditColumns(),
  ...baseSoftDeleteColumns(),
  ...baseLegacyColumns(),
}, (table) => ({ employeeIdx: index('salary_adjustments_employee_idx').on(table.tenantId, table.employeeId, table.startsOn), statusIdx: index('salary_adjustments_status_idx').on(table.tenantId, table.status), numberKey: uniqueIndex('salary_adjustments_tenant_number_key').on(table.tenantId, table.number).where(sql`deleted_at IS NULL AND number IS NOT NULL`), typeIdx: index('salary_adjustments_type_idx').on(table.tenantId, table.typeId) }));

/**
 * 💵 إذن صرف راتب — `Form_WPF/frmSalaryPay.xaml` («دفع الرواتب»).
 *
 * `SalaryPay` is one row per employee per month — «لقد تم دفع راتب الموظف سابقاً»
 * (`btnSave_Click` L470) is a unique `(emp, month, year)` in disguise — carrying the
 * amounts the window shows and the صندوق/بنك the money left through. The cloud could
 * only pay a whole month at once (`POST /hrm/payroll/runs/:id/pay`), with no document to
 * show an employee, no رقم إذن and no way to find one again; this is that document.
 *
 * `الشهر` and `السنة` are two combo boxes in the desktop and one `YYYY-MM` key here —
 * the key a payroll run is filed under, and the one the duplicate guard needs. The seven
 * allowances on the employee card are stored as three boxes the window has
 * (`basic` · `housing` · `transport`) plus `otherAllowances` for the four it does not, so
 * `الصافي` here is the same number the month's مسيّر line carries.
 */
export const salaryPayments = pgTable('salary_payments', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  /** 💵 رقم الإذن — `frmSalaryPay.xaml.cs` L120 `LoadNxtNo`: `MAX(id) + 1`. */
  number: text('number').notNull(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'restrict' }),
  branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
  /** 📊 عرض الراتب — the month's مسيّر this إذن pays, when it pays one. */
  runId: uuid('run_id').references(() => payrollRuns.id, { onDelete: 'set null' }),
  yearMonth: text('year_month').notNull(),
  paymentDate: date('payment_date').notNull(),
  method: text('method').notNull(),
  cashLocationId: uuid('cash_location_id').references(() => cashLocations.id, { onDelete: 'restrict' }),
  /** 👤 اسم الموظف المسؤول — `LoadEmp(MainClass.EmpNo)`: whoever signs the إذن. */
  responsibleEmployeeId: uuid('responsible_employee_id').references(() => employees.id, { onDelete: 'set null' }),
  components: jsonb('components').$type<Record<string, string>>().notNull().default({}),
  basic: numeric('basic', cashValue).notNull().default('0'),
  housing: numeric('housing', cashValue).notNull().default('0'),
  transport: numeric('transport', cashValue).notNull().default('0'),
  otherAllowances: numeric('other_allowances', cashValue).notNull().default('0'),
  additions: numeric('additions', cashValue).notNull().default('0'),
  deductions: numeric('deductions', cashValue).notNull().default('0'),
  net: numeric('net', cashValue).notNull().default('0'),
  notes: text('notes'),
  voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'set null' }),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'set null' }),
  ...baseAuditColumns(),
  ...baseSoftDeleteColumns(),
}, (table) => ({
  numberKey: uniqueIndex('salary_payments_tenant_number_key').on(table.tenantId, table.number).where(sql`deleted_at IS NULL`),
  employeeMonthKey: uniqueIndex('salary_payments_employee_month_key').on(table.tenantId, table.employeeId, table.yearMonth).where(sql`deleted_at IS NULL`),
  dateIdx: index('salary_payments_tenant_date_idx').on(table.tenantId, table.paymentDate),
  employeeIdx: index('salary_payments_tenant_employee_idx').on(table.tenantId, table.employeeId),
}));

export const payrollRuns = pgTable('payroll_runs', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), periodId: uuid('period_id').references(() => fiscalPeriods.id, { onDelete: 'restrict' }), yearMonth: text('year_month').notNull(), status: text('status').notNull().default('draft'), currency: text('currency').notNull().default('SAR'), summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}), journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'set null' }), voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'set null' }), postedAt: timestamp('posted_at', { withTimezone: true }), paidAt: timestamp('paid_at', { withTimezone: true }), reversedAt: timestamp('reversed_at', { withTimezone: true }), reversalReason: text('reversal_reason'), ...baseAuditColumns(), ...baseLegacyColumns(),
}, (table) => ({ monthKey: uniqueIndex('payroll_runs_month_key').on(table.tenantId, table.yearMonth).where(sql`status <> 'reversed'`), statusIdx: index('payroll_runs_status_idx').on(table.tenantId, table.status) }));

export const payrollRunLines = pgTable('payroll_run_lines', {
  runId: uuid('run_id').notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'restrict' }), components: jsonb('components').$type<Record<string, string>>().notNull().default({}), additions: numeric('additions', cashValue).notNull().default('0'), deductions: numeric('deductions', cashValue).notNull().default('0'), gross: numeric('gross', cashValue).notNull(), net: numeric('net', cashValue).notNull(), costCenterId: uuid('cost_center_id').references(() => costCenters.id, { onDelete: 'set null' }), status: text('status').notNull().default('draft'), payslipHtml: text('payslip_html'),
}, (table) => ({ pk: primaryKey({ columns: [table.runId, table.lineNo] }), employeeIdx: index('payroll_run_lines_employee_idx').on(table.tenantId, table.employeeId) }));

/**
 * 🏢 فروع الموظف — `frmEmployees.xaml` L172 `EmpBranches`: an employee can be assigned to
 * several branches besides the primary one on `employees.branch_id`. The desktop keeps it
 * as a separate table `EmpBranches(emp_id, branch_id)`; the cloud mirrors it so a screen
 * that assigns an employee to three branches writes three rows here and does not overwrite
 * the primary branch that other screens rely on.
 */
export const employeeBranches = pgTable('employee_branches', {
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
}, (table) => ({
  pk: primaryKey({ columns: [table.employeeId, table.branchId] }),
  branchIdx: index('employee_branches_tenant_branch_idx').on(table.tenantId, table.branchId),
  employeeIdx: index('employee_branches_employee_idx').on(table.tenantId, table.employeeId),
}));

/** Defaults used by WPS/GOSI export when the request does not repeat them. */
export const payrollComplianceSettings = pgTable('payroll_compliance_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  establishmentId: text('establishment_id').notNull().default(''),
  bankCode: text('bank_code').notNull().default(''),
  gosiEstablishmentNo: text('gosi_establishment_no').notNull().default(''),
  defaultCashLocationId: uuid('default_cash_location_id').references(() => cashLocations.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Generated Mudad/bank wage file. `csv_text` is the download; status is updated after the manual upload. */
export const payrollWpsFiles = pgTable('payroll_wps_files', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  payrollRunId: uuid('payroll_run_id').notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull(),
  bankCode: text('bank_code').notNull(),
  establishmentId: text('establishment_id').notNull().default(''),
  status: text('status').notNull().default('generated'),
  bankResponse: text('bank_response'),
  fileName: text('file_name').notNull(),
  csvText: text('csv_text').notNull(),
  employeeCount: integer('employee_count').notNull(),
  totalNet: numeric('total_net', cashValue).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdx: index('payroll_wps_files_run_idx').on(table.tenantId, table.payrollRunId, table.createdAt),
}));

export const payrollGosiFiles = pgTable('payroll_gosi_files', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  payrollRunId: uuid('payroll_run_id').notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull(),
  establishmentNo: text('establishment_no').notNull().default(''),
  status: text('status').notNull().default('generated'),
  fileName: text('file_name').notNull(),
  csvText: text('csv_text').notNull(),
  employeeCount: integer('employee_count').notNull(),
  totalContribution: numeric('total_contribution', cashValue).notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdx: index('payroll_gosi_files_run_idx').on(table.tenantId, table.payrollRunId, table.createdAt),
}));

export type Employee = typeof employees.$inferSelect;
export type SalaryPayment = typeof salaryPayments.$inferSelect;
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type EmployeeBranch = typeof employeeBranches.$inferSelect;
export type PayrollWpsFile = typeof payrollWpsFiles.$inferSelect;
export type PayrollGosiFile = typeof payrollGosiFiles.$inferSelect;
