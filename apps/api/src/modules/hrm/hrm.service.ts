import { createHash } from 'node:crypto';

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  accounts,
  attendanceLogs,
  branches,
  cashLocations,
  departments,
  employees,
  employeeBranches,
  jobs,
  payrollRunLines,
  payrollRuns,
  salesInvoiceLines,
  salesInvoices,
  items,
  salaryAdjustments,
  salaryAdjustmentTypes,
  salaryPayments,
  vouchers,
  tenantSettings,
  tenants,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
  type Employee,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { AccountingService, defaultNormalBalance, type AccountType, type JournalLineInput } from '../accounting/accounting.service.js';
import { TreasuryService } from '../treasury/treasury.service.js';
import { FileAttachmentRegistry } from '../platform-services/files/file-attachments.js';

import { calculatePayrollLine } from './payroll-calculator.js';

export type DepartmentInput = { code: string; name: string; branchId?: string; parentId?: string | null };
export type JobInput = { code: string; name: string };
export type EmployeeInput = {
  employeeNo: string;
  name: string;
  branchId?: string | null;
  departmentId?: string | null;
  jobId?: string | null;
  membershipId?: string | null;
  hireDate?: string | null;
  status?: EmployeeStatus;
  /** 👤 بيانات الموظف الأساسية — `frmEmployees.xaml` «بيانات الموظف الأساسية». */
  birthDate?: string | null;
  insuranceNo?: string | null;
  nationalId?: string | null;
  iqamaExpiresOn?: string | null;
  insuranceExpiresOn?: string | null;
  gosiScheme?: 'old' | 'new' | null;
  maritalStatus?: string | null;
  nationality?: string | null;
  gender?: EmployeeGender | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  /** 👤 البيانات التكميلية — `frmEmployees.xaml` «البيانات التكميلية». */
  address?: string | null;
  notes?: string | null;
  salaryComponents?: Record<string, string>;
  bank?: Record<string, string | undefined>;
  salaryExpenseAccountId?: string | null;
  salaryPayableAccountId?: string | null;
  costCenterId?: string | null;
  /** رقم الحساب — taken from the card when the accountant typed one, allocated otherwise. */
  accountCode?: string | null;
  createAccount?: boolean;
  /** 🖼️ صورة الموظف — `frmEmployees.xaml` L195 `imgPersonal` + `btnImgAdd`/`btnImgDelete`. */
  photoFileId?: string | null;
  /** 🏢 فروع الموظف — `frmEmployees.xaml` L172 `EmpBranches`: extra branches besides primary. */
  branchIds?: string[];
};
export type EmployeeStatus = 'active' | 'suspended' | 'terminated';
export type EmployeeGender = 'male' | 'female';
export type EmployeeQuery = { q?: string; status?: string; branchId?: string; departmentId?: string; jobId?: string };
/** 📈 حركات الموظف — the filters of `frmEmpInvs` («مبيعات ومشتريات موظف خلال الفترة»). */
export type EmployeeMovementsQuery = {
  employeeId?: string;
  /** `الكل` — every employee who has movements, as `chkAll` does. */
  allEmployees?: boolean;
  from?: string;
  to?: string;
  /** `🔄 نوع الحركة` — `مبيعات` · `مرتجع` · `الكل` (the checked default, `ckAllproc`). */
  movementType?: 'all' | 'sales' | 'returns';
  branchId?: string;
};
export type EmployeeMovementRow = {
  seq: number;
  movementType: string;
  date: string;
  invoiceId: string;
  number: string | null;
  itemName: string;
  quantity: string;
  unitPrice: string;
  additions: string;
  lineTotal: string;
  branchName: string | null;
  isReturn: boolean;
};
/** 📊 تقرير الرواتب — the filters of `frmRptSalary` («💼 تقرير الرواتب»). */
export type SalaryReportQuery = { month?: string; year?: string; allPeriod?: boolean; branchId?: string };
export type SalaryReportRow = {
  seq: number;
  id: string;
  number: string;
  employeeId: string;
  employeeNo: string | null;
  employeeName: string;
  branchName: string | null;
  yearMonth: string;
  month: string;
  year: string;
  paymentDate: string;
  basic: string;
  housing: string;
  transport: string;
  otherAllowances: string;
  additions: string;
  gross: string;
  deductions: string;
  net: string;
  posted: boolean;
  voucherNumber: string | null;
};
export type DepartmentPatch = Partial<DepartmentInput>;
export type JobPatch = Partial<JobInput>;
export type EmployeePatch = Partial<EmployeeInput>;

/**
 * «الرواتب والمستحقات» — the seven rows of `frmEmployees.xaml`, in the window's own order.
 * `CalculateTotalSalary()` (L500) adds all seven for «إجمالي الرواتب والمستحقات», and
 * `calculatePayrollLine` sums the same map for the payroll run, so the card and the
 * مسير cannot disagree about what an employee earns.
 */
export const SALARY_COMPONENT_LABELS: Record<string, string> = {
  basic: 'الراتب الأساسي',
  housing: 'بدل سكن',
  transport: 'بدل مواصلات',
  food: 'طعام',
  medical: 'طبي',
  fixedBonus: 'مكافأة ثابتة',
  other: 'أخرى',
};
export type AdjustmentTypeInput = { code: string; name: string; kind: 'addition' | 'deduction'; sortOrder?: number; isActive?: boolean };
export type AdjustmentTypePatch = Partial<AdjustmentTypeInput>;
export type AdjustmentInput = {
  employeeId: string;
  /** 🎁 النوع — `cmbType` over `SalaryAddSubTypes`; `kind` follows it unless sent. */
  typeId?: string;
  typeCode?: string;
  kind?: 'addition' | 'deduction';
  componentCode?: string;
  valueText: string;
  startsOn: string;
  endsOn?: string;
  recurring?: boolean;
  /** ✅ تضاف على الراتب / ✂️ تخصم من الراتب — `ChkSubSalary`. */
  subFromSalary?: boolean;
  /** 🎁 طريقة الدفع — `rdCash` | `rdCheck`. */
  paymentMethod?: 'cash' | 'bank';
  cashLocationId?: string;
  reason?: string;
  /** Post the document's entry at once (the desktop always does); `false` for a draft. */
  postEntry?: boolean;
};
export type AdjustmentQuery = { employeeId?: string; typeCode?: string; status?: string; from?: string; to?: string };
export type RunInput = { yearMonth: string; periodId?: string; currency?: string; unpaidDaysByEmployee?: Record<string, number> };
export type PostRunInput = { journalEntryId?: string; branchId?: string; fiscalPeriodId?: string; journalLines?: JournalLineInput[] };
export type PayRunInput = { branchId: string; cashLocationId: string; method?: 'cash' | 'cheque' | 'bank_transfer' | 'card'; fiscalPeriodId?: string };

/**
 * 📄 كشف حساب موظف — `frmEmpAccountGet.xaml`. The window's own filters, in its own
 * words: «اسم الموظف» (required — «اختر موظف»), «🏢 الفرع» with «كل الفروع»,
 * «📅 الفترة الزمنية» with «فترة كاملة» and `من`/`إلى`.
 */
export type EmployeeStatementQuery = {
  employeeId?: string;
  from?: string;
  to?: string;
  branchId?: string;
  /** «فترة كاملة» — every posted entry, and therefore no رصيد سابق row. */
  fullPeriod?: boolean;
  /** «عدم إظهار الرصيد السابق» — the movements only. */
  hidePreviousBalance?: boolean;
  /** 📊 تفصيلي — one row per سطر قيد instead of one row per قيد, as the window groups. */
  detailed?: boolean;
};

/** 📄 كشف حساب موظف — one row of `GridControl1` (`م · مدين · دائن · الموظف · رقم القيد · تاريخ القيد · البيان`). */
export type EmployeeStatementRow = {
  seq: number;
  date: string;
  entryId: string | null;
  entryNumber: string | null;
  description: string | null;
  debit: string;
  credit: string;
  employee: string | null;
  branchName: string | null;
  entryType: string;
  runningBalance: string | null;
  balanceStatus: string | null;
};

/**
 * 💵 إذن صرف راتب — `frmSalaryPay.xaml` «💰 دفع الرواتب».
 *
 * `yearMonth` is the window's two combo boxes «الشهر» and «السنة» in one `YYYY-MM` key;
 * `method` is `rdCash` «نقدي» or `rdBank` «تحويل بنكي».
 */
export type SalaryPaymentInput = {
  employeeId: string;
  yearMonth: string;
  paymentDate: string;
  /** الفرع — «يجب اختيار الفرع.» */
  branchId?: string;
  /** 📊 عرض الراتب — the مسيّر this إذن pays, when it pays one. */
  runId?: string;
  method?: 'cash' | 'bank';
  cashLocationId?: string;
  /** 👤 اسم الموظف المسؤول — the employee record of whoever signs the إذن. */
  responsibleEmployeeId?: string;
  notes?: string;
  unpaidDays?: number;
  fiscalPeriodId?: string;
  /** Money moves at once unless this is `false` — the desktop always pays on save. */
  postVoucher?: boolean;
};
export type SalaryPaymentQuery = {
  employeeId?: string;
  yearMonth?: string;
  branchId?: string;
  method?: string;
  from?: string;
  to?: string;
  number?: string;
};

/** `Departments.manag_id` — the إدارة above a قسم, joined under a second name. */
const management = alias(departments, 'management');

/** What every employee read returns: the row plus the names the card and the grid print. */
const employeeCardSelect = {
  row: employees,
  departmentName: departments.name,
  departmentParentId: departments.parentId,
  managementName: management.name,
  jobName: jobs.name,
  accountCode: accounts.code,
};

/** «النوع» — `frmEmployees.xaml` rdMale / rdFemale. */
const GENDER_LABELS: Record<string, string> = { male: 'ذكر', female: 'أنثى' };
/** «الحالة» — `frmEmployees.xaml` cmbStatus; the desktop reads a `States` lookup. */
const STATUS_LABELS: Record<string, string> = { active: 'نشط', suspended: 'موقوف', terminated: 'منتهي الخدمة' };

/**
 * The card as `frmEmployees` reads it back. `managementId`/`managementName` are the
 * employee's إدارة — the parent of the assigned قسم, or the assigned row itself when the
 * employee belongs to the إدارة directly — which is why the card stores one department
 * and not two that could disagree.
 */
function toEmployeeCard(entry: { row: Employee; departmentName: string | null; departmentParentId: string | null; managementName: string | null; jobName: string | null; accountCode: string | null }) {
  const { row, departmentName, departmentParentId, managementName, jobName, accountCode } = entry;
  const components = row.salaryComponents ?? {};
  const totalSalary = Object.values(components).reduce((sum, valueText) => sum.plus(new Decimal(valueText || '0')), new Decimal(0)).toFixed(4);
  return {
    ...maskEmployee(row),
    departmentName: departmentName ?? null,
    departmentKind: row.departmentId ? (departmentParentId ? 'section' : 'management') : null,
    managementId: row.departmentId ? departmentParentId ?? row.departmentId : null,
    managementName: row.departmentId ? managementName ?? departmentName ?? null : null,
    sectionId: departmentParentId ? row.departmentId : null,
    sectionName: departmentParentId ? departmentName ?? null : null,
    jobName: jobName ?? null,
    accountCode: accountCode ?? null,
    totalSalary,
    genderLabel: GENDER_LABELS[row.gender ?? ''] ?? null,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
  };
}

@Injectable()
export class HrmService implements OnModuleInit {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle, private readonly accounting: AccountingService, private readonly treasury: TreasuryService, private readonly attachments: FileAttachmentRegistry, private readonly customFields: CustomFieldsService) {}

  onModuleInit(): void {
    this.attachments.register('employee', async (tx, tenantId, entityId) => {
      const [row] = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, entityId), isNull(employees.deletedAt))).limit(1);
      return row !== undefined;
    });
  }

  async ensureEnabled(tenantId: string) { const [flag] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.hrm'))).limit(1)); if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'HRM pack is disabled for this tenant', 404); }
  /**
   * 🏢 الإدارات والأقسام — `frmManagement.xaml` («الإدارات») and `frmDepartments.xaml`
   * («إدخال بيانات الإدارات والأقسام») print two grids: managements, and departments
   * with «اسم الإدارة التابع لها» beside each. One table carries both levels, so a row
   * with no parent is an إدارة and a row with a parent is a قسم — and `kind` says which.
   */
  async listDepartments(tenantId: string) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          row: departments,
          parentName: management.name,
          employeeCount: sql<number>`(SELECT COUNT(*)::int FROM employees e WHERE e.tenant_id = ${tenantId} AND e.department_id = ${departments.id} AND e.deleted_at IS NULL)`,
          sectionCount: sql<number>`(SELECT COUNT(*)::int FROM departments c WHERE c.tenant_id = ${tenantId} AND c.parent_id = ${departments.id} AND c.deleted_at IS NULL)`,
        })
        .from(departments)
        .leftJoin(management, eq(management.id, departments.parentId))
        .where(and(eq(departments.tenantId, tenantId), isNull(departments.deletedAt)))
        .orderBy(departments.code));
    return rows.map(({ row, parentName, employeeCount, sectionCount }) => ({
      ...row,
      kind: row.parentId ? 'section' : 'management',
      parentName: parentName ?? null,
      employeeCount,
      sectionCount,
    }));
  }

  async createDepartment(tenantId: string, input: DepartmentInput) {
    await this.ensureEnabled(tenantId);
    if (!input.name?.trim()) throw new DomainError('DEPARTMENT_NAME_REQUIRED', 'يجب إدخال اسم القسم', 422);
    if (input.parentId) await this.assertManagement(tenantId, input.parentId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(departments).values({ id: newId(), tenantId, code: input.code, name: input.name.trim(), branchId: input.branchId, parentId: input.parentId ?? null }).returning());
    return row;
  }

  async updateDepartment(tenantId: string, id: string, patch: DepartmentPatch) {
    await this.ensureEnabled(tenantId);
    if (patch.name !== undefined && !patch.name.trim()) throw new DomainError('DEPARTMENT_NAME_REQUIRED', 'يجب إدخال اسم القسم', 422);
    if (patch.parentId) await this.assertManagement(tenantId, patch.parentId, id);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.update(departments).set({ ...(patch.code === undefined ? {} : { code: patch.code }), ...(patch.name === undefined ? {} : { name: patch.name.trim() }), ...(patch.branchId === undefined ? {} : { branchId: patch.branchId }), ...(patch.parentId === undefined ? {} : { parentId: patch.parentId }), updatedAt: new Date() }).where(and(eq(departments.tenantId, tenantId), eq(departments.id, id), isNull(departments.deletedAt))).returning());
    if (!row) throw new DomainError('NOT_FOUND', 'Department not found', 404);
    return row;
  }

  /**
   * A department that still has staff — or أقسام — on it is kept: deleting it would
   * strip their org unit. «لا يمكن حذف إدارة لها أقسام» is the cloud's own wording; the
   * desktop deletes the row and leaves its departments pointing at nothing.
   */
  async deleteDepartment(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const used = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM employees WHERE tenant_id = ${tenantId} AND department_id = ${id} AND deleted_at IS NULL) AS used`);
      if ((rowsOf(used)[0] as { used: boolean }).used) throw new DomainError('DEPARTMENT_IN_USE', 'Move the employees to another department first', 409);
      const children = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM departments WHERE tenant_id = ${tenantId} AND parent_id = ${id} AND deleted_at IS NULL) AS used`);
      if ((rowsOf(children)[0] as { used: boolean }).used) throw new DomainError('DEPARTMENT_HAS_SECTIONS', 'لا يمكن حذف إدارة لها أقسام', 409);
      const result = await tx.update(departments).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(departments.tenantId, tenantId), eq(departments.id, id), isNull(departments.deletedAt)));
      if (!result.rowCount) throw new DomainError('NOT_FOUND', 'Department not found', 404);
      return { id, deleted: true };
    });
  }

  /** `frmDepartments.xaml.cs` L120 — a قسم is saved under an إدارة, never under another قسم. */
  private async assertManagement(tenantId: string, parentId: string, movingId?: string) {
    const [parent] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.id, parentId), isNull(departments.deletedAt))).limit(1));
    if (!parent) throw new DomainError('NOT_FOUND', 'Management not found', 404);
    if (parent.parentId) throw new DomainError('DEPARTMENT_LEVEL_INVALID', 'لا يمكن إضافة قسم تحت قسم آخر', 422);
    if (movingId && parent.id === movingId) throw new DomainError('DEPARTMENT_CYCLE', 'لا يمكن أن يكون القسم تابعاً لنفسه', 422);
    return parent;
  }
  /**
   * AUD-15 — الوظيفة المحذوفة لا تظهر: الحذف هنا **ناعم** (`deletedAt`، كما يفعل
   * `deleteDepartment` فوقه ونمط `baseSoftDeleteColumns`)، فالقائمة كانت تسرّب المحذوف.
   */
  async listJobs(tenantId: string) { await this.ensureEnabled(tenantId); return withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(jobs).where(and(eq(jobs.tenantId, tenantId), isNull(jobs.deletedAt))).orderBy(jobs.code)); }
  async createJob(tenantId: string, input: JobInput) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(jobs).values({ id: newId(), tenantId, code: input.code, name: input.name }).returning()); return row; }
  /** AUD-15 — تعديل محذوفٍ ليس تعديلاً: الشرط `deleted_at IS NULL` يجعله 404 كغيره. */
  async updateJob(tenantId: string, id: string, patch: JobPatch) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.update(jobs).set({ ...(patch.code === undefined ? {} : { code: patch.code }), ...(patch.name === undefined ? {} : { name: patch.name }), updatedAt: new Date() }).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), isNull(jobs.deletedAt))).returning()); if (!row) throw new DomainError('NOT_FOUND', 'Job not found', 404); return row; }
  /**
   * AUD-15 — الحذف ناعم لا صلب: `delete` كان يمحو الصف ويفقد أثره (من حذف ومتى) رغم أن
   * الجدول يحمل `deleted_at`/`deleted_by` وفهرساً فريداً جزئياً على `deleted_at IS NULL`
   * يقصد به السماح بإعادة استعمال الرمز لاحقاً. والوظيفة المستخدمة تبقى مرفوضة (409).
   * والحذف الثاني يعيد 404 لأن الشرط نفسه يمنع «حذف» صفٍّ محذوف.
   */
  async deleteJob(tenantId: string, id: string) { await this.ensureEnabled(tenantId); return withTenantTx(this.database.db, tenantId, async (tx) => { const used = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM employees WHERE tenant_id = ${tenantId} AND job_id = ${id} AND deleted_at IS NULL) AS used`); if ((rowsOf(used)[0] as { used: boolean }).used) throw new DomainError('JOB_IN_USE', 'Employees are still assigned to this job title', 409); const result = await tx.update(jobs).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), isNull(jobs.deletedAt))); if (!result.rowCount) throw new DomainError('NOT_FOUND', 'Job not found', 404); return { id, deleted: true }; }); }

  /**
   * 👤 قائمة الموظفين — `frmEmployees.xaml` «قائمة الموظفين» prints
   * `الرقم · الاسم · إجمالي المرتب` and `BtnSearch_Click` narrows it with
   * `name LIKE N'%…%'`. The cloud's list used to be bare rows; it now carries the names
   * the card shows (so the grid needs no second request per row) and the إجمالي of the
   * seven salary rows, which is the column the window actually prints.
   */
  async listEmployees(tenantId: string, query: EmployeeQuery = {}) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select(employeeCardSelect).from(employees)
      .leftJoin(departments, eq(departments.id, employees.departmentId))
      .leftJoin(management, eq(management.id, departments.parentId))
      .leftJoin(jobs, eq(jobs.id, employees.jobId))
      .leftJoin(accounts, eq(accounts.id, employees.employeeAccountId))
      .where(and(
        eq(employees.tenantId, tenantId),
        isNull(employees.deletedAt),
        query.q?.trim() ? or(ilike(employees.name, `%${query.q.trim()}%`), ilike(employees.employeeNo, `%${query.q.trim()}%`)) : undefined,
        query.status ? eq(employees.status, query.status) : undefined,
        query.branchId ? eq(employees.branchId, query.branchId) : undefined,
        // Filtering by إدارة means its أقسام too — the card's «الإدارة» holds both.
        query.departmentId ? or(eq(employees.departmentId, query.departmentId), eq(departments.parentId, query.departmentId)) : undefined,
        query.jobId ? eq(employees.jobId, query.jobId) : undefined,
      ))
      .orderBy(employees.employeeNo));
    return this.customFields.decorate(tenantId, 'employee', rows.map(toEmployeeCard));
  }

  /** 👤 تعريف موظف — the card behind `frmEmployees.xaml`, read back by id. */
  async readEmployee(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select(employeeCardSelect).from(employees)
      .leftJoin(departments, eq(departments.id, employees.departmentId))
      .leftJoin(management, eq(management.id, departments.parentId))
      .leftJoin(jobs, eq(jobs.id, employees.jobId))
      .leftJoin(accounts, eq(accounts.id, employees.employeeAccountId))
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, id), isNull(employees.deletedAt)))
      .limit(1));
    const [row] = rows;
    if (!row) throw new DomainError('NOT_FOUND', 'Employee not found', 404);
    const card = toEmployeeCard(row);
    const branchesList = await this.listEmployeeBranches(tenantId, id);
    const [decorated] = await this.customFields.decorate(tenantId, 'employee', [card]);
    return { ...(decorated ?? card), branches: branchesList, photoFileId: (row.row as Employee).photoFileId ?? null };
  }

  async createEmployee(tenantId: string, input: EmployeeInput) {
    await this.ensureEnabled(tenantId);
    const name = input.name?.trim();
    // `frmEmployees.xaml.cs` L520 — the one thing the window will not save without.
    if (!name) throw new DomainError('EMPLOYEE_NAME_REQUIRED', 'يجب إدخال اسم الموظف', 422);
    if (!input.employeeNo?.trim()) throw new DomainError('EMPLOYEE_NO_REQUIRED', 'يجب إدخال رقم الموظف', 422);
    validateComponents(input.salaryComponents ?? {});
    assertEmployeeDates(input);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(employees).values({ id: newId(), tenantId, employeeNo: input.employeeNo.trim(), name, branchId: input.branchId, departmentId: input.departmentId, jobId: input.jobId, membershipId: input.membershipId, status: input.status ?? 'active', hireDate: input.hireDate, birthDate: input.birthDate, insuranceNo: input.insuranceNo, nationalId: input.nationalId, maritalStatus: input.maritalStatus, nationality: input.nationality, gender: input.gender, phone: input.phone, mobile: input.mobile, email: input.email, address: input.address, notes: input.notes, salaryComponents: input.salaryComponents ?? {}, bank: input.bank ?? {}, salaryExpenseAccountId: input.salaryExpenseAccountId, salaryPayableAccountId: input.salaryPayableAccountId, costCenterId: input.costCenterId, photoFileId: input.photoFileId ?? null, iqamaExpiresOn: input.iqamaExpiresOn ?? null, insuranceExpiresOn: input.insuranceExpiresOn ?? null, gosiScheme: input.gosiScheme ?? null }).returning());
    if (!row) throw new DomainError('INTERNAL', 'Employee was not created', 500);
    if (input.branchIds?.length) {
      await this.syncEmployeeBranches(tenantId, row.id, input.branchIds);
    }
    if (input.createAccount !== false) await this.employeeAccount(tenantId, row.id, name, input.branchId, input.accountCode ?? undefined, undefined);
    return this.readEmployee(tenantId, row.id);
  }

  async updateEmployee(tenantId: string, id: string, patch: EmployeePatch) {
    await this.ensureEnabled(tenantId);
    if (patch.name !== undefined && !patch.name.trim()) throw new DomainError('EMPLOYEE_NAME_REQUIRED', 'يجب إدخال اسم الموظف', 422);
    if (patch.salaryComponents) validateComponents(patch.salaryComponents);
    assertEmployeeDates(patch);
    const [current] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, id), isNull(employees.deletedAt))).limit(1));
    if (!current) throw new DomainError('NOT_FOUND', 'Employee not found', 404);
    const nextName = patch.name?.trim();
    await withTenantTx(this.database.db, tenantId, (tx) => tx.update(employees).set({
      ...(patch.employeeNo === undefined ? {} : { employeeNo: patch.employeeNo.trim() }),
      ...(nextName === undefined ? {} : { name: nextName }),
      ...(patch.branchId === undefined ? {} : { branchId: patch.branchId }),
      ...(patch.departmentId === undefined ? {} : { departmentId: patch.departmentId }),
      ...(patch.jobId === undefined ? {} : { jobId: patch.jobId }),
      ...(patch.membershipId === undefined ? {} : { membershipId: patch.membershipId }),
      ...(patch.hireDate === undefined ? {} : { hireDate: patch.hireDate }),
      ...(patch.birthDate === undefined ? {} : { birthDate: patch.birthDate }),
      ...(patch.insuranceNo === undefined ? {} : { insuranceNo: patch.insuranceNo }),
      ...(patch.nationalId === undefined ? {} : { nationalId: patch.nationalId }),
      ...(patch.iqamaExpiresOn === undefined ? {} : { iqamaExpiresOn: patch.iqamaExpiresOn }),
      ...(patch.insuranceExpiresOn === undefined ? {} : { insuranceExpiresOn: patch.insuranceExpiresOn }),
      ...(patch.gosiScheme === undefined ? {} : { gosiScheme: patch.gosiScheme }),
      ...(patch.maritalStatus === undefined ? {} : { maritalStatus: patch.maritalStatus }),
      ...(patch.nationality === undefined ? {} : { nationality: patch.nationality }),
      ...(patch.gender === undefined ? {} : { gender: patch.gender }),
      ...(patch.phone === undefined ? {} : { phone: patch.phone }),
      ...(patch.mobile === undefined ? {} : { mobile: patch.mobile }),
      ...(patch.email === undefined ? {} : { email: patch.email }),
      ...(patch.address === undefined ? {} : { address: patch.address }),
      ...(patch.notes === undefined ? {} : { notes: patch.notes }),
      ...(patch.salaryComponents === undefined ? {} : { salaryComponents: patch.salaryComponents }),
      ...(patch.bank === undefined ? {} : { bank: patch.bank }),
      ...(patch.salaryExpenseAccountId === undefined ? {} : { salaryExpenseAccountId: patch.salaryExpenseAccountId }),
      ...(patch.salaryPayableAccountId === undefined ? {} : { salaryPayableAccountId: patch.salaryPayableAccountId }),
      ...(patch.costCenterId === undefined ? {} : { costCenterId: patch.costCenterId }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.photoFileId === undefined ? {} : { photoFileId: patch.photoFileId }),
      updatedAt: new Date(),
    }).where(and(eq(employees.tenantId, tenantId), eq(employees.id, id), isNull(employees.deletedAt))));
    if (patch.branchIds !== undefined) {
      await this.syncEmployeeBranches(tenantId, id, patch.branchIds ?? []);
    }
    // `frmEmployees.xaml.cs` L600 `SaveAccounts` renames the row when the code already
    // exists: the account *is* the employee inside the ledger, so a renamed employee
    // whose account kept the old name prints two different people.
    if (nextName !== undefined && nextName !== current.name && current.employeeAccountId) {
      await this.employeeAccount(tenantId, id, nextName, patch.branchId ?? current.branchId, patch.accountCode ?? undefined, current.employeeAccountId);
    }
    return this.readEmployee(tenantId, id);
  }

  /**
   * 🏢 فروع الموظف — `EmpBranches`: sync extra branches for an employee.
   * The primary branch stays on `employees.branch_id`; this table carries the rest.
   */
  async syncEmployeeBranches(tenantId: string, employeeId: string, branchIds: string[]) {
    const unique = [...new Set(branchIds.filter(Boolean))];
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      // remove old
      await tx.delete(employeeBranches).where(and(eq(employeeBranches.tenantId, tenantId), eq(employeeBranches.employeeId, employeeId)));
      if (unique.length === 0) return;
      // validate branches belong to tenant
      const existing = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), inArray(branches.id, unique)));
      const existingIds = new Set(existing.map((b) => b.id));
      const toInsert = unique.filter((id) => existingIds.has(id)).map((branchId) => ({
        employeeId,
        branchId,
        tenantId,
        createdAt: new Date(),
      }));
      if (toInsert.length) await tx.insert(employeeBranches).values(toInsert);
    });
  }

  async listEmployeeBranches(tenantId: string, employeeId: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ branchId: employeeBranches.branchId, branchName: branches.nameAr, branchCode: branches.code }).from(employeeBranches).leftJoin(branches, eq(branches.id, employeeBranches.branchId)).where(and(eq(employeeBranches.tenantId, tenantId), eq(employeeBranches.employeeId, employeeId))),
    );
  }

  /**
   * `frmEmployees.xaml.cs` L730 refuses twice before it deletes: an employee with a
   * user account («لا يمكن حذف موظف مرتبط بمستخدم») and one who sold anything
   * («لا يمكن حذف موظف مرتبط بفواتير»). The cloud adds a third — an employee who has
   * appeared on a مسير رواتب — because the desktop's salary tables carry the employee
   * id with no constraint at all, and a run's lines would outlive their name.
   *
   * What "deleted" means is unchanged: the row is soft-deleted and marked terminated,
   * so the ledger keeps every figure it already posted.
   */
  async deleteEmployee(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [current] = await tx.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, id), isNull(employees.deletedAt))).limit(1);
      if (!current) throw new DomainError('NOT_FOUND', 'Employee not found', 404);
      const hasUser = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = ${tenantId} AND id = ${current.membershipId}) AS used`);
      if ((rowsOf(hasUser)[0] as { used: boolean }).used) throw new DomainError('EMPLOYEE_HAS_USER', 'لا يمكن حذف موظف مرتبط بمستخدم', 409);
      const hasInvoices = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM sales_invoices WHERE tenant_id = ${tenantId} AND salesman_id = ${id}) AS used`);
      if ((rowsOf(hasInvoices)[0] as { used: boolean }).used) throw new DomainError('EMPLOYEE_HAS_INVOICES', 'لا يمكن حذف موظف مرتبط بفواتير', 409);
      const onPayroll = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM payroll_run_lines WHERE tenant_id = ${tenantId} AND employee_id = ${id}) AS used`);
      if ((rowsOf(onPayroll)[0] as { used: boolean }).used) throw new DomainError('EMPLOYEE_ON_PAYROLL', 'لا يمكن حذف موظف له مسير رواتب', 409);
      const result = await tx.update(employees).set({ status: 'terminated', deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(employees.tenantId, tenantId), eq(employees.id, id), isNull(employees.deletedAt)));
      if (!result.rowCount) throw new DomainError('NOT_FOUND', 'Employee not found', 404);
      return { id, archived: true, deleted: false };
    });
  }

  /**
   * 👤 رقم الحساب — `frmEmployees.xaml.cs` L600 `SaveAccounts` writes a `TreeAccount`
   * row named after the employee under the branch's employee account
   * (`ParentCode = Common.CurrentBranch.EmployeeAcc`, default 2241 per
   * `Class/Common.cs` L998) and renames it when the code is already there.
   *
   * If the tenant's chart has no account at that code there is nothing to hang the
   * employee on, and the card is still saved — exactly as the desktop behaves, where
   * `SaveAccounts`' failure is caught and ignored.
   */
  private async employeeAccount(tenantId: string, employeeId: string, employeeName: string, branchId: string | null | undefined, requestedCode: string | undefined, existingAccountId: string | undefined) {
    const root = await this.employeeAccountRoot(tenantId);
    if (!root) return undefined;
    if (existingAccountId) {
      try {
        await this.accounting.updateAccount(tenantId, existingAccountId, { nameAr: employeeName });
      } catch {
        // An account that cannot be renamed (posted, or already gone) still carries the
        // employee's money; the card must not fail because of it.
      }
      return this.accounting.readAccount(tenantId, existingAccountId);
    }
    const code = requestedCode?.trim() || (await this.nextEmployeeAccountCode(tenantId, root.code));
    const [taken] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, code), isNull(accounts.deletedAt))).limit(1));
    if (taken) throw new DomainError('EMPLOYEE_ACCOUNT_CODE_TAKEN', `رقم الحساب ${code} مستخدم بالفعل`, 409);
    // The employee hangs under the root's own branch of the tree, so it inherits the
    // root's nature rather than choosing one: the desktop writes `Nature = 1` for every
    // employee account, and the seeded root («موظفين الفرع الرئيسي») is a liability.
    const account = await this.accounting.createAccount(tenantId, { code, nameAr: employeeName, type: root.type as AccountType, normalBalance: (root.normalBalance ?? defaultNormalBalance(root.type as AccountType)) as 'debit' | 'credit', parentId: root.id, isPostable: true });
    await withTenantTx(this.database.db, tenantId, (tx) => tx.update(employees).set({ employeeAccountId: account.id, updatedAt: new Date() }).where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId))));
    return account;
  }

  /** The chart account employees hang under: `2241` («موظفين الفرع الرئيسي»), overridable. */
  private async employeeAccountRoot(tenantId: string) {
    const [setting] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'hrm.employee_account_code'))).limit(1));
    const code = typeof setting?.value === 'string' ? setting.value : (setting?.value as { value?: string } | undefined)?.value ?? '2241';
    const [root] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, code), isNull(accounts.deletedAt))).limit(1));
    return root;
  }

  /** `MaxId("Code", "Accounts_Index", parent)` — the next free child code under the root. */
  private async nextEmployeeAccountCode(tenantId: string, rootCode: string) {
    const children = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [root] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, rootCode), isNull(accounts.deletedAt))).limit(1);
      if (!root) return [];
      return tx.select({ code: accounts.code }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.parentId, root.id), isNull(accounts.deletedAt)));
    });
    let highest = 0;
    let width = 4;
    for (const child of children) {
      const suffix = child.code.startsWith(rootCode) ? child.code.slice(rootCode.length) : '';
      if (!/^\d+$/.test(suffix)) continue;
      highest = Math.max(highest, Number(suffix));
      width = Math.max(width, suffix.length);
    }
    return `${rootCode}${String(highest + 1).padStart(width, '0')}`;
  }

  async importAttendanceCsv(tenantId: string, csv: string) { await this.ensureEnabled(tenantId); const rows = parseAttendance(csv); let inserted = 0; let skipped = 0; await withTenantTx(this.database.db, tenantId, async (tx) => { for (const row of rows) { const fingerprint = attendanceFingerprint(row); const result = await tx.execute(sql`INSERT INTO attendance_logs (id, tenant_id, machine, enroll, punch_at, direction, fingerprint, payload) VALUES (${newId()}, ${tenantId}, ${row.machine}, ${row.enroll}, ${new Date(row.datetime)}, ${row.inout}, ${fingerprint}, ${JSON.stringify(row)}::jsonb) ON CONFLICT (tenant_id, fingerprint) DO NOTHING RETURNING id`); if (rowsOf(result).length) inserted += 1; else skipped += 1; } }); return { data: { inserted, skipped, parsed: rows.length } }; }

  async attendanceSummary(tenantId: string, enroll: string, from: string, to: string) { await this.ensureEnabled(tenantId); const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(attendanceLogs).where(and(eq(attendanceLogs.tenantId, tenantId), eq(attendanceLogs.enroll, enroll), gte(attendanceLogs.punchAt, new Date(from)), lte(attendanceLogs.punchAt, new Date(to)))).orderBy(attendanceLogs.punchAt)); let minutes = new Decimal(0); let open: Date | undefined; for (const row of rows) { if (row.direction === 'in') open = row.punchAt; else if (row.direction === 'out' && open) { minutes = minutes.plus(new Decimal(row.punchAt.getTime() - open.getTime()).div(60_000)); open = undefined; } } return { data: { enroll, punches: rows.length, workingHours: minutes.div(60).toFixed(2), method: 'naive in/out pairing; no RC-10 evaluation engine' } }; }

  // ---------------------------------------------------------------------------
  // 🎁 الحوافز والجزاءات — `Form_WPF/frmEmpSalaryAddSub.xaml`
  // ---------------------------------------------------------------------------

  async listAdjustmentTypes(tenantId: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(salaryAdjustmentTypes).where(and(eq(salaryAdjustmentTypes.tenantId, tenantId), isNull(salaryAdjustmentTypes.deletedAt))).orderBy(asc(salaryAdjustmentTypes.sortOrder), asc(salaryAdjustmentTypes.code)));
  }

  async createAdjustmentType(tenantId: string, input: AdjustmentTypeInput) {
    await this.ensureEnabled(tenantId);
    const name = input.name?.trim();
    if (!name) throw new DomainError('ADJUSTMENT_TYPE_NAME_REQUIRED', 'يجب إدخال اسم النوع', 422);
    if (input.kind !== 'addition' && input.kind !== 'deduction') throw new DomainError('ADJUSTMENT_TYPE_KIND_INVALID', 'نوع الإجراء إضافة أو خصم فقط', 422);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(salaryAdjustmentTypes).values({ id: newId(), tenantId, code: input.code.trim(), name, kind: input.kind, sortOrder: input.sortOrder ?? 0, isActive: input.isActive ?? true }).returning());
    return row;
  }

  async updateAdjustmentType(tenantId: string, id: string, patch: AdjustmentTypePatch) {
    await this.ensureEnabled(tenantId);
    if (patch.name !== undefined && !patch.name.trim()) throw new DomainError('ADJUSTMENT_TYPE_NAME_REQUIRED', 'يجب إدخال اسم النوع', 422);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.update(salaryAdjustmentTypes).set({
      ...(patch.code === undefined ? {} : { code: patch.code.trim() }),
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
      ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
      updatedAt: new Date(),
    }).where(and(eq(salaryAdjustmentTypes.tenantId, tenantId), eq(salaryAdjustmentTypes.id, id), isNull(salaryAdjustmentTypes.deletedAt))).returning());
    if (!row) throw new DomainError('NOT_FOUND', 'Adjustment type not found', 404);
    return row;
  }

  async deleteAdjustmentType(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const used = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM salary_adjustments WHERE tenant_id = ${tenantId} AND type_id = ${id} AND deleted_at IS NULL) AS used`);
      if ((rowsOf(used)[0] as { used: boolean }).used) throw new DomainError('ADJUSTMENT_TYPE_IN_USE', 'لا يمكن حذف نوع مستخدم في حركات', 409);
      const result = await tx.update(salaryAdjustmentTypes).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(salaryAdjustmentTypes.tenantId, tenantId), eq(salaryAdjustmentTypes.id, id), isNull(salaryAdjustmentTypes.deletedAt)));
      if (!result.rowCount) throw new DomainError('NOT_FOUND', 'Adjustment type not found', 404);
      return { id, deleted: true };
    });
  }

  /**
   * 🎁 قائمة الحركات — `frmEmpSalaryAddSub` `LoadGrid` prints
   * `RecordId · EmpId · EmpName · Value · TypeName · RecordDate` and narrows it by
   * employee and by `من`/`إلى` date. The cloud's list was the last 200 rows with none of
   * that, and no name on any row.
   */
  async listAdjustments(tenantId: string, query: AdjustmentQuery = {}) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          row: salaryAdjustments,
          employeeName: employees.name,
          employeeNo: employees.employeeNo,
          typeName: salaryAdjustmentTypes.name,
          typeCode: salaryAdjustmentTypes.code,
          typeKind: salaryAdjustmentTypes.kind,
          cashLocationName: cashLocations.name,
        })
        .from(salaryAdjustments)
        .leftJoin(employees, eq(employees.id, salaryAdjustments.employeeId))
        .leftJoin(salaryAdjustmentTypes, eq(salaryAdjustmentTypes.id, salaryAdjustments.typeId))
        .leftJoin(cashLocations, eq(cashLocations.id, salaryAdjustments.cashLocationId))
        .where(
          and(
            eq(salaryAdjustments.tenantId, tenantId),
            isNull(salaryAdjustments.deletedAt),
            query.employeeId ? eq(salaryAdjustments.employeeId, query.employeeId) : undefined,
            query.status ? eq(salaryAdjustments.status, query.status) : undefined,
            query.from ? gte(salaryAdjustments.startsOn, query.from) : undefined,
            query.to ? lte(salaryAdjustments.startsOn, query.to) : undefined,
            query.typeCode ? eq(salaryAdjustmentTypes.code, query.typeCode) : undefined,
          ),
        )
        .orderBy(desc(salaryAdjustments.startsOn), desc(salaryAdjustments.createdAt))
        .limit(200));
    return { data: rows.map((entry) => ({ ...entry.row, employeeName: entry.employeeName ?? null, employeeNo: entry.employeeNo ?? null, typeName: entry.typeName ?? null, typeCode: entry.typeCode ?? null, typeKind: entry.typeKind ?? null, cashLocationName: entry.cashLocationName ?? null })) };
  }

  async readAdjustment(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    const { data } = await this.listAdjustments(tenantId);
    const row = data.find((entry) => entry.id === id);
    if (!row) throw new DomainError('NOT_FOUND', 'Adjustment not found', 404);
    return row;
  }

  /**
   * 🎁 إدخال الحوافز والخصومات للموظفين.
   *
   * `frmEmpSalaryAddSub.xaml.cs` L566 refuses four things in its own words —
   * «يجب اختيار موظف» · «يجب اختيار نوع الإجراء» · «يجب إدخال مبلغ» ·
   * «يجب اختيار الصندوق أو البنك» — writes «رقم السند» as `MAX(id)+1` (L225), fills the
   * note itself when the clerk leaves it empty («مكافأة للموظف …», L665), and posts one
   * journal entry per document (L718) that puts the employee's own account — the account
   * Part One creates — on one side and the صندوق or البنك on the other.
   */
  async createAdjustment(tenantId: string, input: AdjustmentInput) {
    await this.ensureEnabled(tenantId);
    const [employee] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, input.employeeId), isNull(employees.deletedAt))).limit(1));
    if (!employee) throw new DomainError('ADJUSTMENT_EMPLOYEE_REQUIRED', 'يجب اختيار موظف', 422);

    const type = await this.resolveAdjustmentType(tenantId, input);
    if (!type) throw new DomainError('ADJUSTMENT_TYPE_REQUIRED', 'يجب اختيار نوع الإجراء', 422);

    const value = new Decimal(input.valueText || '0');
    if (!value.isFinite() || value.lte(0)) throw new DomainError('ADJUSTMENT_VALUE_REQUIRED', 'يجب إدخال مبلغ', 422);

    const kind = input.kind ?? (type.kind === 'deduction' ? 'deduction' : 'addition');
    const subFromSalary = input.subFromSalary ?? kind === 'deduction';

    // ✂️ تخصم من الراتب means the payroll run carries it; anything else is money moving
    // through a صندوق or a بنك today, and the desktop asks which one (`PopulateParameters`
    // L846 writes `Cash` or `Bank`, never both).
    let cashLocation: { id: string; name: string; branchId: string; accountId: string | null; kind: string } | undefined;
    if (!subFromSalary) {
      if (!input.cashLocationId) throw new DomainError('ADJUSTMENT_CASH_LOCATION_REQUIRED', 'يجب اختيار الصندوق أو البنك', 422);
      const [location] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(cashLocations).where(and(eq(cashLocations.tenantId, tenantId), eq(cashLocations.id, input.cashLocationId!))).limit(1));
      if (!location) throw new DomainError('ADJUSTMENT_CASH_LOCATION_REQUIRED', 'يجب اختيار الصندوق أو البنك', 422);
      cashLocation = location;
      const expected = input.paymentMethod ?? (cashLocation.kind === 'bank' ? 'bank' : 'cash');
      const actual = cashLocation.kind === 'bank' ? 'bank' : 'cash';
      if (expected !== actual) throw new DomainError('ADJUSTMENT_PAYMENT_METHOD_MISMATCH', 'طريقة الدفع لا تطابق الصندوق أو البنك المختار', 422);
    }

    const number = await withTenantTx(this.database.db, tenantId, (tx) => this.nextAdjustmentNumber(tx, tenantId));
    const reason = input.reason?.trim() || `${type.name} للموظف ${employee.name}`;

    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(salaryAdjustments).values({
      id: newId(),
      tenantId,
      employeeId: employee.id,
      kind,
      componentCode: input.componentCode ?? type.code,
      valueText: value.toFixed(4),
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      recurring: input.recurring ?? false,
      subFromSalary,
      cashLocationId: cashLocation?.id,
      paymentMethod: cashLocation ? (cashLocation.kind === 'bank' ? 'bank' : 'cash') : undefined,
      number,
      typeId: type.id,
      reason,
    }).returning());
    if (!row) throw new DomainError('INTERNAL', 'Adjustment was not created', 500);

    if (subFromSalary || input.postEntry === false || !cashLocation) return this.readAdjustment(tenantId, row.id);

    try {
      const entry = await this.postAdjustmentEntry(tenantId, row.id, value.toFixed(4), kind, employee, cashLocation, reason, input.startsOn);
      await withTenantTx(this.database.db, tenantId, (tx) => tx.update(salaryAdjustments).set({ journalEntryId: entry.id, status: 'approved', updatedAt: new Date() }).where(and(eq(salaryAdjustments.tenantId, tenantId), eq(salaryAdjustments.id, row.id))));
      return this.readAdjustment(tenantId, row.id);
    } catch (error) {
      // Nothing half-done: a document whose money did not move is not a document.
      await withTenantTx(this.database.db, tenantId, (tx) => tx.delete(salaryAdjustments).where(and(eq(salaryAdjustments.tenantId, tenantId), eq(salaryAdjustments.id, row.id))));
      throw error;
    }
  }

  /**
   * `BindReceiptToEntry` L718 — one entry, two lines. A مكافأة debits the salary expense
   * and credits the صندوق (money out for work done); a خصم or سلفة debits the employee's
   * own account and credits the صندوق, which is what the window writes for every type
   * other than 1: the employee now owes what the till handed over.
   *
   * A deliberate difference from the desktop: a مكافأة there debits the صندوق and
   * credits the employee — cash growing where a bonus spends it. And an adjustment that
   * rides the salary (`subFromSalary`) posts **no** entry here: the payroll run posts it
   * once, instead of the desktop's immediate debit to «راتب أساسي» that the payroll then
   * counts a second time.
   */
  private async postAdjustmentEntry(tenantId: string, adjustmentId: string, value: string, kind: 'addition' | 'deduction', employee: Employee, cashLocation: { id: string; name: string; branchId: string; accountId: string | null }, reason: string, date: string) {
    if (!cashLocation.accountId) throw new DomainError('ADJUSTMENT_CASH_ACCOUNT_REQUIRED', 'الصندوق أو البنك بلا حساب في دليل الحسابات', 422);
    const employeeAccountId = employee.employeeAccountId ?? (await this.employeeAccount(tenantId, employee.id, employee.name, employee.branchId, undefined, undefined))?.id;
    if (!employeeAccountId) throw new DomainError('ADJUSTMENT_EMPLOYEE_ACCOUNT_REQUIRED', 'لا يوجد حساب للموظف في دليل الحسابات', 422);
    const expenseAccountId = employee.salaryExpenseAccountId ?? (await this.accountByCode(tenantId, '3122001'))?.id;
    if (kind === 'addition' && !expenseAccountId) throw new DomainError('ADJUSTMENT_EXPENSE_ACCOUNT_REQUIRED', 'لا يوجد حساب راتب أساسي في دليل الحسابات', 422);
    const entry = await this.accounting.postJournal(tenantId, {
      branchId: cashLocation.branchId,
      date,
      description: reason,
      sourceType: 'salary_adjustment',
      sourceId: adjustmentId,
      lines: kind === 'addition'
        ? [
            { accountId: expenseAccountId!, debit: value, credit: '0' },
            { accountId: cashLocation.accountId, debit: '0', credit: value },
          ]
        : [
            { accountId: employeeAccountId, debit: value, credit: '0' },
            { accountId: cashLocation.accountId, debit: '0', credit: value },
          ],
    });
    if (!entry?.id) throw new DomainError('INTERNAL', 'Adjustment entry was not posted', 500);
    return entry;
  }

  private async resolveAdjustmentType(tenantId: string, input: AdjustmentInput) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      if (input.typeId) {
        const [row] = await tx.select().from(salaryAdjustmentTypes).where(and(eq(salaryAdjustmentTypes.tenantId, tenantId), eq(salaryAdjustmentTypes.id, input.typeId), isNull(salaryAdjustmentTypes.deletedAt))).limit(1);
        return row;
      }
      if (input.typeCode) {
        const [row] = await tx.select().from(salaryAdjustmentTypes).where(and(eq(salaryAdjustmentTypes.tenantId, tenantId), eq(salaryAdjustmentTypes.code, input.typeCode), isNull(salaryAdjustmentTypes.deletedAt))).limit(1);
        return row;
      }
      return undefined;
    });
  }

  private async accountByCode(tenantId: string, code: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, code), isNull(accounts.deletedAt))).limit(1));
    return row;
  }

  /** «رقم السند» — `LoadNextNumber` L225: the highest number on the books, plus one. */
  private async nextAdjustmentNumber(tx: DrizzleTx, tenantId: string) {
    const rows = await tx.select({ number: salaryAdjustments.number }).from(salaryAdjustments).where(and(eq(salaryAdjustments.tenantId, tenantId), isNotNull(salaryAdjustments.number)));
    let highest = 0;
    for (const row of rows) {
      const parsed = Number(row.number);
      if (Number.isFinite(parsed) && parsed > highest) highest = parsed;
    }
    return String(highest + 1);
  }

  /**
   * `IconButton9_Click` L449 deletes with «⚠️ هل أنت متأكد من الحذف؟» and sets
   * `IS_Deleted = 1`. The cloud refuses two cases the desktop does not consider: a
   * document whose entry is already posted (deleting a document is not how a ledger is
   * corrected — `POST /journal-entries/:id/reverse` is), and one a posted payroll run has
   * already counted.
   */
  async deleteAdjustment(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    const [current] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(salaryAdjustments).where(and(eq(salaryAdjustments.tenantId, tenantId), eq(salaryAdjustments.id, id), isNull(salaryAdjustments.deletedAt))).limit(1));
    if (!current) throw new DomainError('NOT_FOUND', 'Adjustment not found', 404);
    if (current.journalEntryId) throw new DomainError('ADJUSTMENT_POSTED', 'لا يمكن حذف حركة مرحَّلة — يُعكس قيدها أولاً', 409);
    if (current.status === 'approved') {
      const counted = await withTenantTx(this.database.db, tenantId, (tx) => tx.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.yearMonth, current.startsOn.slice(0, 7)), or(eq(payrollRuns.status, 'posted'), eq(payrollRuns.status, 'paid')))).limit(1));
      if (counted.length) throw new DomainError('ADJUSTMENT_IN_PAYROLL', 'لا يمكن حذف حركة دخلت مسير رواتب مُرحَّل', 409);
    }
    await withTenantTx(this.database.db, tenantId, (tx) => tx.update(salaryAdjustments).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(salaryAdjustments.tenantId, tenantId), eq(salaryAdjustments.id, id))));
    return { id, deleted: true };
  }

  /**
   * 💵 «🔍 البحث» — `LoadDG` prints `رقم الإذن · 👤 الموظف · 💰 المبلغ · الشهر · السنة ·
   * 📅 التاريخ · المستخدم` and narrows it by «رقم الإذن», by «الموظف», and by
   * `من تاريخ`/`إلى تاريخ` unless «كل الفترة» (`chkall`) is on.
   */
  async listSalaryPayments(tenantId: string, query: SalaryPaymentQuery = {}) {
    await this.ensureEnabled(tenantId);
    const responsible = alias(employees, 'responsible');
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          row: salaryPayments,
          employeeName: employees.name,
          employeeNo: employees.employeeNo,
          branchName: branches.nameAr,
          cashLocationName: cashLocations.name,
          responsibleName: responsible.name,
          voucherNumber: vouchers.number,
          voucherStatus: vouchers.status,
        })
        .from(salaryPayments)
        .leftJoin(employees, eq(employees.id, salaryPayments.employeeId))
        .leftJoin(branches, eq(branches.id, salaryPayments.branchId))
        .leftJoin(cashLocations, eq(cashLocations.id, salaryPayments.cashLocationId))
        .leftJoin(responsible, eq(responsible.id, salaryPayments.responsibleEmployeeId))
        .leftJoin(vouchers, eq(vouchers.id, salaryPayments.voucherId))
        .where(
          and(
            eq(salaryPayments.tenantId, tenantId),
            isNull(salaryPayments.deletedAt),
            query.employeeId ? eq(salaryPayments.employeeId, query.employeeId) : undefined,
            query.yearMonth ? eq(salaryPayments.yearMonth, query.yearMonth) : undefined,
            query.branchId ? eq(salaryPayments.branchId, query.branchId) : undefined,
            query.method ? eq(salaryPayments.method, query.method) : undefined,
            query.number ? eq(salaryPayments.number, query.number) : undefined,
            query.from ? gte(salaryPayments.paymentDate, query.from) : undefined,
            query.to ? lte(salaryPayments.paymentDate, query.to) : undefined,
          ),
        )
        .orderBy(desc(salaryPayments.paymentDate), desc(salaryPayments.createdAt))
        .limit(200));
    return {
      data: rows.map((entry) => {
        const [year, month] = entry.row.yearMonth.split('-');
        return {
          ...entry.row,
          month: month ?? '',
          year: year ?? '',
          employeeName: entry.employeeName ?? null,
          employeeNo: entry.employeeNo ?? null,
          branchName: entry.branchName ?? null,
          cashLocationName: entry.cashLocationName ?? null,
          responsibleName: entry.responsibleName ?? null,
          voucherNumber: entry.voucherNumber ?? null,
          voucherStatus: entry.voucherStatus ?? null,
        };
      }),
    };
  }

  async readSalaryPayment(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    const { data } = await this.listSalaryPayments(tenantId);
    const row = data.find((entry) => entry.id === id);
    if (!row) throw new DomainError('NOT_FOUND', 'Salary payment not found', 404);
    return row;
  }

  /**
   * 📄 كشف حساب موظف — `Form_WPF/frmEmpAccountGet.xaml` («كشف حساب موظف»).
   *
   * The window refuses an empty «اسم الموظف» with **«اختر موظف»** (`ShowAccount`), then
   * reads the employee's own account — `Employees.AccCode`, the account Part One writes
   * under «موظفين الفرع الرئيسي» — out of `Entry ⋈ Entry_sub ⋈ Accounts_Index`, grouped
   * by قيد (`GROUP BY Entry.GlobalID, Entry.date, Entry_sub.notes, Entry_sub.acc_no`)
   * and restricted to `Entry.IS_Deleted=0 AND Entry.state=1` — posted entries only. The
   * grid is `م · مدين · دائن · الموظف · رقم القيد · تاريخ القيد · البيان`, and
   * `UpdateSummary` prints «💳 إجمالي المدين» · «💵 إجمالي الدائن» · «⚖️ الرصيد المدين» ·
   * «⚖️ الرصيد الدائن» — the balance sitting on one side only, never both.
   *
   * The cloud already had the statement itself (`GET
   * /accounting/statements/general-ledger/:accountId`, Phase 07 part two) with the same
   * رصيد سابق row and the same running balance; what it did not have was the employee
   * half of the window — pick a موظف, get their حساب — so this is that half, and the
   * arithmetic is not recomputed twice.
   */
  async employeeStatement(tenantId: string, query: EmployeeStatementQuery = {}) {
    await this.ensureEnabled(tenantId);
    const employeeId = query.employeeId;
    if (!employeeId) throw new DomainError('EMPLOYEE_STATEMENT_EMPLOYEE_REQUIRED', 'اختر موظف', 422);
    const [employee] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId), isNull(employees.deletedAt))).limit(1));
    if (!employee) throw new DomainError('EMPLOYEE_STATEMENT_EMPLOYEE_REQUIRED', 'اختر موظف', 422);

    // «اسم الموظف» carries `AccCode`, not the id: the statement is the account's, and an
    // employee without one has nothing to show. Part One creates it on the card.
    const accountId = employee.employeeAccountId ?? employee.salaryPayableAccountId;
    if (!accountId) throw new DomainError('EMPLOYEE_STATEMENT_ACCOUNT_REQUIRED', 'لا يوجد حساب للموظف في دليل الحسابات', 422);

    const statement = await this.accounting.accountStatement(tenantId, accountId, {
      from: query.from,
      to: query.to,
      branchId: query.branchId,
      // «فترة كاملة» is the checked box; with no `من` there is no «before» to carry.
      fullPeriod: query.fullPeriod ?? !query.from,
      hidePreviousBalance: query.hidePreviousBalance,
      // The window groups by قيد, so one row per قيد unless تفصيلي is asked for.
      summary: !query.detailed,
    });

    const rows: EmployeeStatementRow[] = statement.rows.map((row, index) => ({
      seq: index + 1,
      date: row.date,
      entryId: row.entryId,
      entryNumber: row.number,
      description: row.description,
      debit: row.debit,
      credit: row.credit,
      employee: row.accountName,
      branchName: row.branchName,
      entryType: row.entryType,
      runningBalance: row.runningBalance,
      balanceStatus: row.balanceStatus,
    }));

    return {
      data: {
        employee: {
          id: employee.id,
          employeeNo: employee.employeeNo,
          name: employee.name,
          accountId,
          accountCode: statement.account.code,
          accountName: statement.account.nameAr,
        },
        branchId: query.branchId ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        fullPeriod: Boolean(query.fullPeriod ?? !query.from),
        summary: {
          totalDebit: statement.totals.debit,
          totalCredit: statement.totals.credit,
          balanceDebit: statement.totals.periodDebit,
          balanceCredit: statement.totals.periodCredit,
        },
        rows,
      },
    };
  }

  /**
   * 📈 حركات الموظف — `Form_WPF/frmEmpInvs.xaml` («مبيعات ومشتريات موظف خلال الفترة»).
   *
   * `ShowResult` (L226) reads `Inv ⋈ Inv_Sub` on `Inv.sales_emp` — the employee who made
   * the sale — over `date >= @date1 AND date <= @date2` where `@date2` is
   * `txtDateTo.AddHours(24)`, so the last day is inside, with `Inv.IS_Deleted=0` and
   * `inv_type` 1 (مشتريات) or 2|3 (مبيعات ونقطة بيع), and one row per **line**
   * (`نوع الحركة · التاريخ · رقم الفاتورة · الصنف · الكمية · السعر · إضافات · الإجمالي`).
   *
   * The cloud carries the same link as `sales_invoices.salesman_id` (the field the
   * accounting journal lines also point at `employees.id`), and its نقطة بيع sales are
   * `sales_invoices` with an `orderType`/`shiftId` — which is exactly how the desktop's
   * `inv_type 2` and `inv_type 3` differ. The مشتريات half of the window has no cloud
   * counterpart: a purchase invoice carries no employee at all, so it is not invented
   * here (§9 of `PHASE_08_HRM.md`).
   *
   * One correction, named because it changes the footer: the desktop's `_Sum += tot_net`
   * runs **per line**, so an invoice with three lines counts its total three times. The
   * footer here adds each invoice once, sales positive and returns negative.
   */
  /**
   * AUD-17 — تاريخ الأعمال لليوم في المنطقة الزمنية المحددة للمنشأة
   * (`tenant_settings['locale.timezone']` ← `tenants.timezone` ← `'Asia/Riyadh'`).
   * يمنع انزلاق التاريخ حول منتصف الليل بين UTC والتوقيت المحلي للمنشأة.
   */
  private async resolveBusinessTimezoneInTx(tx: DrizzleTx, tenantId: string): Promise<string> {
    const [setting] = await tx
      .select({ value: tenantSettings.value })
      .from(tenantSettings)
      .where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'locale.timezone')))
      .limit(1);
    const [tenant] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const tz =
      typeof setting?.value === 'string' && setting.value.trim()
        ? setting.value.trim()
        : (tenant?.timezone?.trim() || 'Asia/Riyadh');
    try {
      // Validates the zone name through Intl before it ever reaches SQL, so an invalid
      // tenant setting cannot turn the report query into a database error.
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      return tz;
    } catch {
      return 'Asia/Riyadh';
    }
  }

  private async resolveBusinessTodayInTx(
    tx: DrizzleTx,
    tenantId: string,
    now = new Date(),
  ): Promise<string> {
    const tz = await this.resolveBusinessTimezoneInTx(tx, tenantId);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  }

  async employeeMovements(tenantId: string, query: EmployeeMovementsQuery = {}) {
    await this.ensureEnabled(tenantId);
    const employeeId = query.employeeId;
    // «اختر موظف» (L232) — the window refuses to run without one unless «الكل» is on.
    if (!employeeId && !query.allEmployees) throw new DomainError('EMPLOYEE_MOVEMENTS_EMPLOYEE_REQUIRED', 'اختر موظف', 422);
    if (employeeId) {
      const [employee] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.select({ id: employees.id }).from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId), isNull(employees.deletedAt))).limit(1));
      if (!employee) throw new DomainError('EMPLOYEE_MOVEMENTS_EMPLOYEE_REQUIRED', 'اختر موظف', 422);
    }

    // «من تاريخ»/«إلى تاريخ» open on today (`FrmEmpInvs_Loaded` L72) and «إلى» is inside.
    const tz = await withTenantTx(this.database.db, tenantId, (tx) =>
      this.resolveBusinessTimezoneInTx(tx, tenantId),
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const from = query.from ?? today;
    const to = query.to ?? today;
    const movementType = query.movementType ?? 'all';

    /**
     * R-20 — the window above is the tenant's *business* day (AUD-17), so the date the
     * documents are compared by must be read in the same timezone. `${postedAt}::date`
     * alone casts in the database session's zone (UTC on the test server), which made the
     * default window and the rows disagree for three hours every day: after 21:00 UTC the
     * Riyadh day has already rolled over, so invoices posted moments earlier fell outside
     * their own default window. `timestamptz AT TIME ZONE <tz>` renders the wall-clock
     * timestamp in the tenant's zone first; casting that to a date keeps window and rows
     * in one calendar.
     */
    const businessDate = sql`((${salesInvoices.postedAt} AT TIME ZONE ${tz})::date)`;

    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          invoiceId: salesInvoices.id,
          number: salesInvoices.number,
          kind: salesInvoices.kind,
          date: sql<string>`${businessDate}`,
          total: salesInvoices.total,
          isPos: sql<boolean>`(${salesInvoices.orderType} IS NOT NULL OR ${salesInvoices.shiftId} IS NOT NULL)`,
          orderType: salesInvoices.orderType,
          branchName: branches.nameAr,
          itemName: items.nameAr,
          lineDescription: salesInvoiceLines.description,
          quantity: salesInvoiceLines.quantity,
          unitPrice: salesInvoiceLines.unitPrice,
          modifiers: salesInvoiceLines.modifiers,
        })
        .from(salesInvoiceLines)
        .innerJoin(salesInvoices, eq(salesInvoices.id, salesInvoiceLines.invoiceId))
        .leftJoin(items, eq(items.id, salesInvoiceLines.itemId))
        .leftJoin(branches, eq(branches.id, salesInvoices.branchId))
        .where(
          and(
            eq(salesInvoiceLines.tenantId, tenantId),
            eq(salesInvoices.tenantId, tenantId),
            // المرحَّل وحده — `Inv.IS_Deleted=0` plus the cloud's own «مُلغى».
            eq(salesInvoices.status, 'posted'),
            isNull(salesInvoices.voidedAt),
            // «🔄 نوع الحركة» — `Inv.Proc_type`: 1 فاتورة، 2 مرتجع، و«الكل» يجمعهما.
            movementType === 'sales'
              ? eq(salesInvoices.kind, 'sale')
              : movementType === 'returns'
                ? eq(salesInvoices.kind, 'sale_return')
                : inArray(salesInvoices.kind, ['sale', 'sale_return']),
            gte(sql`${businessDate}`, from),
            lte(sql`${businessDate}`, to),
            employeeId ? eq(salesInvoices.salesmanId, employeeId) : isNotNull(salesInvoices.salesmanId),
            query.branchId ? eq(salesInvoices.branchId, query.branchId) : undefined,
          ),
        )
        .orderBy(asc(sql`${businessDate}`), asc(salesInvoices.number), asc(salesInvoiceLines.lineNo)));

    const movements: EmployeeMovementRow[] = [];
    const seen = new Set<string>();
    const signed = { sales: new Decimal(0), returns: new Decimal(0) };
    for (const row of rows) {
      if (!seen.has(row.invoiceId)) {
        seen.add(row.invoiceId);
        if (row.kind === 'sale') signed.sales = signed.sales.plus(row.total);
        else signed.returns = signed.returns.plus(row.total);
      }
      const quantity = new Decimal(row.quantity ?? '0');
      const unitPrice = new Decimal(row.unitPrice ?? '0');
      movements.push({
        seq: movements.length + 1,
        movementType: movementTypeOf(row.kind, row.isPos),
        date: row.date,
        invoiceId: row.invoiceId,
        number: row.number,
        itemName: row.itemName ?? row.lineDescription ?? '—',
        quantity: quantity.toFixed(4),
        unitPrice: unitPrice.toFixed(4),
        additions: modifiersTotal(row.modifiers).toFixed(4),
        lineTotal: quantity.times(unitPrice).toFixed(4),
        branchName: row.branchName ?? null,
        isReturn: row.kind !== 'sale',
      });
    }

    return {
      data: {
        employeeId: employeeId ?? null,
        allEmployees: Boolean(query.allEmployees),
        branchId: query.branchId ?? null,
        from,
        to,
        movementType,
        summary: {
          total: signed.sales.minus(signed.returns).toFixed(4),
          salesTotal: signed.sales.toFixed(4),
          returnsTotal: signed.returns.toFixed(4),
          invoices: seen.size,
          lines: movements.length,
        },
        rows: movements,
      },
    };
  }

  /**
   * 📊 تقرير الرواتب — `Form_WPF/frmRptSalary.xaml` («💼 تقرير الرواتب»).
   *
   * `btnShow_Click` (L58) reads `SalaryPay` with `IS_Deleted=0`, narrowed by
   * `الشهر:`/`السنة:` unless «كل الفترة» is on (`ckWholePeriod`, checked — and it
   * disables both boxes), and prints one row per إذن:
   * `م · SalId · رقم السند · 👤 الموظف · الراتب الأساسي · بدل سكن · بدل مواصلات ·
   * الحوافز · 💰 الإجمالي · الخصومات · 💵 صافي الراتب · 👁️ عرض`, with
   * `💰 إجمالي الرواتب` = the sum of the nets (L113).
   *
   * `gross = tot_salary + Houses + Travel + salary_add` (L104) — but the cloud's إذن also
   * carries four allowances the window has no box for (`other_allowances`, part three's
   * decision 2), so الإجمالي here is `الصافي + الخصومات`: a report whose gross does not
   * add up to the net printed on the very same payment would be a lie.
   */
  async salaryReport(tenantId: string, query: SalaryReportQuery = {}) {
    await this.ensureEnabled(tenantId);
    // «كل الفترة» is checked by default; both boxes are disabled until it is off, and the
    // window only filters when it could parse *both* of them.
    const allPeriod = query.allPeriod ?? true;
    const yearMonth = !allPeriod && query.year && query.month ? `${query.year}-${String(query.month).padStart(2, '0')}` : undefined;

    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          row: salaryPayments,
          employeeName: employees.name,
          employeeNo: employees.employeeNo,
          branchName: branches.nameAr,
          voucherNumber: vouchers.number,
        })
        .from(salaryPayments)
        .leftJoin(employees, eq(employees.id, salaryPayments.employeeId))
        .leftJoin(branches, eq(branches.id, salaryPayments.branchId))
        .leftJoin(vouchers, eq(vouchers.id, salaryPayments.voucherId))
        .where(
          and(
            eq(salaryPayments.tenantId, tenantId),
            isNull(salaryPayments.deletedAt),
            yearMonth ? eq(salaryPayments.yearMonth, yearMonth) : undefined,
            query.branchId ? eq(salaryPayments.branchId, query.branchId) : undefined,
          ),
        )
        .orderBy(asc(salaryPayments.paymentDate), asc(salaryPayments.number)));

    const data: SalaryReportRow[] = rows.map((entry, index) => {
      const net = new Decimal(entry.row.net ?? '0');
      const deductions = new Decimal(entry.row.deductions ?? '0');
      return {
        seq: index + 1,
        id: entry.row.id,
        number: entry.row.number,
        employeeId: entry.row.employeeId,
        employeeNo: entry.employeeNo,
        employeeName: entry.employeeName ?? '—',
        branchName: entry.branchName ?? null,
        yearMonth: entry.row.yearMonth,
        month: entry.row.yearMonth.slice(5),
        year: entry.row.yearMonth.slice(0, 4),
        paymentDate: entry.row.paymentDate,
        basic: entry.row.basic,
        housing: entry.row.housing,
        transport: entry.row.transport,
        otherAllowances: entry.row.otherAllowances,
        additions: entry.row.additions,
        gross: net.plus(deductions).toFixed(4),
        deductions: entry.row.deductions,
        net: entry.row.net,
        posted: Boolean(entry.row.voucherId),
        voucherNumber: entry.voucherNumber ?? null,
      };
    });

    return {
      data: {
        allPeriod,
        month: query.month ?? null,
        year: query.year ?? null,
        branchId: query.branchId ?? null,
        summary: {
          total: data.reduce((sum, row) => sum.plus(row.net), new Decimal(0)).toFixed(4),
          gross: data.reduce((sum, row) => sum.plus(row.gross), new Decimal(0)).toFixed(4),
          deductions: data.reduce((sum, row) => sum.plus(row.deductions), new Decimal(0)).toFixed(4),
          count: data.length,
        },
        rows: data,
      },
    };
  }

  /**
   * 💵 «💾 حفظ» — `btnSave_Click`.
   *
   * The window refuses three things before it writes («يجب اختيار الفرع.» ·
   * «يجب اختيار الموظف.» · «يجب اختيار الصندوق.»), refuses a second إذن for the same
   * employee and month («لقد تم دفع راتب الموظف سابقاً.» L470), refuses a صندوق with no
   * account behind it («لم يتم العثور على الحساب المقابل للصندوق.» L486), and «📊 عرض
   * الراتب» refuses an employee with nothing due («لا يوجد رواتب مستحقة للموظف.» L321).
   *
   * What it pays is the month's مسيّر: the run line when `runId` is given, otherwise the
   * employee's own components plus every approved حركة of that month — the same
   * arithmetic `POST /hrm/payroll/preview` prints, so an إذن cannot pay a number the
   * مسيّر disagrees with. `الصافي` is `RecalcNet` L340:
   * `الراتب الأساسي + بدل سكن + بدل مواصلات + الحوافز − الخصومات`, and the four
   * allowances the window has no box for ride in `otherAllowances`.
   */
  async createSalaryPayment(tenantId: string, input: SalaryPaymentInput) {
    await this.ensureEnabled(tenantId);
    const [employee] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, input.employeeId), isNull(employees.deletedAt))).limit(1));
    if (!employee) throw new DomainError('SALARY_PAYMENT_EMPLOYEE_REQUIRED', 'يجب اختيار الموظف.', 422);

    if (!input.branchId) throw new DomainError('SALARY_PAYMENT_BRANCH_REQUIRED', 'يجب اختيار الفرع.', 422);
    const [branch] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, input.branchId!))).limit(1));
    if (!branch) throw new DomainError('SALARY_PAYMENT_BRANCH_REQUIRED', 'يجب اختيار الفرع.', 422);

    if (!input.cashLocationId) throw new DomainError('SALARY_PAYMENT_CASH_LOCATION_REQUIRED', 'يجب اختيار الصندوق.', 422);
    const [location] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(cashLocations).where(and(eq(cashLocations.tenantId, tenantId), eq(cashLocations.id, input.cashLocationId!))).limit(1));
    if (!location) throw new DomainError('SALARY_PAYMENT_CASH_LOCATION_REQUIRED', 'يجب اختيار الصندوق.', 422);
    // «لم يتم العثور على الحساب المقابل للصندوق.» — money cannot leave what has no account.
    if (!location.accountId) throw new DomainError('SALARY_PAYMENT_CASH_ACCOUNT_REQUIRED', 'لم يتم العثور على الحساب المقابل للصندوق.', 422);

    const method = input.method ?? (location.kind === 'bank' ? 'bank' : 'cash');
    if ((location.kind === 'bank') !== (method === 'bank')) {
      throw new DomainError('SALARY_PAYMENT_METHOD_MISMATCH', 'طريقة الدفع لا تطابق الصندوق أو البنك المختار', 422);
    }

    const [duplicate] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select({ id: salaryPayments.id }).from(salaryPayments).where(and(eq(salaryPayments.tenantId, tenantId), eq(salaryPayments.employeeId, employee.id), eq(salaryPayments.yearMonth, input.yearMonth), isNull(salaryPayments.deletedAt))).limit(1));
    if (duplicate) throw new DomainError('SALARY_PAYMENT_DUPLICATE', 'لقد تم دفع راتب الموظف سابقاً.', 409);

    const amounts = await this.salaryForMonth(tenantId, employee, input.yearMonth, { runId: input.runId, unpaidDays: input.unpaidDays });
    if (new Decimal(amounts.net).lte(0)) throw new DomainError('SALARY_PAYMENT_NOTHING_DUE', 'لا يوجد رواتب مستحقة للموظف.', 422);

    /**
     * «يصرف من حساب» — the desktop debits the employee's own account
     * (`Employees.AccCode`) and credits the صندوق; that account is what a سلفة debited
     * and what the مسيّر owes. An employee without one cannot be paid, and the refusal
     * belongs **before** the إذن is written: the `try` below deletes the row when the
     * money fails to leave the till, but a row written before this check had nothing to
     * delete it — a refused payment used to stay in the books as a draft.
     */
    const employeeAccountId = employee.employeeAccountId ?? employee.salaryPayableAccountId;
    if (!employeeAccountId) throw new DomainError('SALARY_PAYMENT_EMPLOYEE_ACCOUNT_REQUIRED', 'لا يوجد حساب للموظف في دليل الحسابات', 422);

    const number = await withTenantTx(this.database.db, tenantId, (tx) => this.nextSalaryPaymentNumber(tx, tenantId));
    const [month, year] = [input.yearMonth.slice(5), input.yearMonth.slice(0, 4)];
    const id = newId();
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.insert(salaryPayments).values({
        id,
        tenantId,
        number,
        employeeId: employee.id,
        branchId: branch.id,
        runId: input.runId,
        yearMonth: input.yearMonth,
        paymentDate: input.paymentDate,
        method: method === 'bank' ? 'bank_transfer' : 'cash',
        cashLocationId: location.id,
        responsibleEmployeeId: input.responsibleEmployeeId,
        components: amounts.components,
        basic: amounts.basic,
        housing: amounts.housing,
        transport: amounts.transport,
        otherAllowances: amounts.otherAllowances,
        additions: amounts.additions,
        deductions: amounts.deductions,
        net: amounts.net,
        notes: input.notes?.trim() || null,
      }));

    if (input.postVoucher === false) return this.readSalaryPayment(tenantId, id);

    try {
      const voucher = await this.treasury.createVoucher(tenantId, {
        branchId: branch.id,
        kind: 'payment',
        subtype: 'salary',
        date: input.paymentDate,
        cashLocationId: location.id,
        method: method === 'bank' ? 'bank_transfer' : 'cash',
        amount: amounts.net,
        netAmount: amounts.net,
        recipient: employee.name,
        counterAccountId: employeeAccountId,
        description: input.notes?.trim() || `صرف راتب ${month}/${year} للموظف ${employee.name}`,
        idempotencyKey: `salary-payment:${id}`,
      });
      if (!voucher) throw new DomainError('INTERNAL', 'Salary payment voucher was not created', 500);
      const posted = await this.treasury.postVoucher(tenantId, voucher.id, { fiscalPeriodId: input.fiscalPeriodId });
      await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.update(salaryPayments).set({ voucherId: posted.id, journalEntryId: posted.journalEntryId ?? null, updatedAt: new Date() }).where(and(eq(salaryPayments.tenantId, tenantId), eq(salaryPayments.id, id))));
      return this.readSalaryPayment(tenantId, id);
    } catch (error) {
      // Nothing half-done: an إذن whose money did not leave the till is not an إذن.
      await withTenantTx(this.database.db, tenantId, (tx) => tx.delete(salaryPayments).where(and(eq(salaryPayments.tenantId, tenantId), eq(salaryPayments.id, id))));
      throw error;
    }
  }

  /**
   * «🗑️ حذف» — `btnDelete_Click` L568 asks «اختر سنداً ليتم حذفه.» and then soft-deletes
   * the إذن *and* its receipt. The cloud deletes the إذن and refuses one whose سند صرف is
   * still posted: a voucher is a treasury document with an entry of its own, and
   * `POST /treasury/vouchers/:id/void` is how a document is corrected — not erasing the
   * إذن that pointed at it.
   */
  async deleteSalaryPayment(tenantId: string, id: string) {
    await this.ensureEnabled(tenantId);
    const [current] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(salaryPayments).where(and(eq(salaryPayments.tenantId, tenantId), eq(salaryPayments.id, id), isNull(salaryPayments.deletedAt))).limit(1));
    if (!current) throw new DomainError('SALARY_PAYMENT_NOT_FOUND', 'اختر سنداً ليتم حذفه.', 404);
    if (current.voucherId) {
      const [voucher] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.select({ status: vouchers.status }).from(vouchers).where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, current.voucherId!))).limit(1));
      if (voucher?.status === 'posted') throw new DomainError('SALARY_PAYMENT_POSTED', 'لا يمكن حذف إذن مرحَّل — يُلغى سند الصرف أولاً', 409);
    }
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.update(salaryPayments).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(salaryPayments.tenantId, tenantId), eq(salaryPayments.id, id))));
    return { id, deleted: true };
  }

  /**
   * The month's numbers, the way «📊 عرض الراتب» reads them: the مسيّر line when a run is
   * named (`Salary_Res ⋈ Salary_Res_Details`), otherwise the employee's own card plus
   * every approved حركة of that month — `calculatePayrollLine`, the same function the
   * مسيّر preview uses.
   */
  private async salaryForMonth(
    tenantId: string,
    employee: Employee,
    yearMonth: string,
    options: { runId?: string; unpaidDays?: number } = {},
  ) {
    if (options.runId) {
      const [line] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx.select().from(payrollRunLines).where(and(eq(payrollRunLines.tenantId, tenantId), eq(payrollRunLines.runId, options.runId!), eq(payrollRunLines.employeeId, employee.id))).limit(1));
      if (!line) throw new DomainError('SALARY_PAYMENT_RUN_LINE_MISSING', 'لا يوجد راتب مستحق للموظف في هذا المسير', 422);
      return salaryBreakdown(line.components, line.additions, line.deductions, line.gross, line.net);
    }
    const adjustments = await this.adjustmentsForMonth(tenantId, yearMonth);
    const line = calculatePayrollLine({
      id: employee.id,
      name: employee.name,
      components: employee.salaryComponents ?? {},
      unpaidDays: options.unpaidDays ?? 0,
      adjustments: adjustments
        .filter((entry) => entry.employeeId === employee.id)
        .map((entry) => ({ kind: entry.kind as 'addition' | 'deduction', valueText: entry.valueText })),
    });
    return salaryBreakdown(line.components, line.additions, line.deductions, line.gross, line.net);
  }

  /** «رقم الإذن» — `LoadNxtNo` L120: the highest number on the books, plus one. */
  private async nextSalaryPaymentNumber(tx: DrizzleTx, tenantId: string) {
    const rows = await tx.select({ number: salaryPayments.number }).from(salaryPayments).where(and(eq(salaryPayments.tenantId, tenantId), isNotNull(salaryPayments.number)));
    let highest = 0;
    for (const row of rows) {
      const parsed = Number(row.number);
      if (Number.isFinite(parsed) && parsed > highest) highest = parsed;
    }
    return String(highest + 1);
  }

  async approveAdjustment(tenantId: string, id: string) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.update(salaryAdjustments).set({ status: 'approved', updatedAt: new Date() }).where(and(eq(salaryAdjustments.tenantId, tenantId), eq(salaryAdjustments.id, id), eq(salaryAdjustments.status, 'draft'))).returning()); if (!row) throw new DomainError('NOT_FOUND', 'Draft adjustment not found', 404); return row; }

  async preview(tenantId: string, input: RunInput) { await this.ensureEnabled(tenantId); const staff = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.status, 'active'), isNull(employees.deletedAt)))); const activeAdjustments = await this.adjustmentsForMonth(tenantId, input.yearMonth); const lines = staff.map((employee) => calculatePayrollLine({ id: employee.id, name: employee.name, components: employee.salaryComponents, unpaidDays: input.unpaidDaysByEmployee?.[employee.id] ?? 0, adjustments: activeAdjustments.filter((entry) => entry.employeeId === employee.id).map((entry) => ({ kind: entry.kind as 'addition' | 'deduction', valueText: entry.valueText })) })); return { data: { yearMonth: input.yearMonth, employeeCount: lines.length, netPayable: sumLines(lines.map((line) => line.net)), lines } }; }

  async createRun(tenantId: string, input: RunInput) { const preview = await this.preview(tenantId, input); const id = newId(); await withTenantTx(this.database.db, tenantId, async (tx) => { await tx.insert(payrollRuns).values({ id, tenantId, yearMonth: input.yearMonth, periodId: input.periodId, currency: input.currency ?? 'SAR', summary: { preview: preview.data } }); if (preview.data.lines.length) await tx.insert(payrollRunLines).values(preview.data.lines.map((line, index) => ({ runId: id, lineNo: index + 1, tenantId, employeeId: line.employeeId, components: line.components, additions: line.additions, deductions: line.deductions, gross: line.gross, net: line.net, status: 'draft', payslipHtml: payslipHtml(input.yearMonth, line.employeeName, line.net) }))); }); return this.readRun(tenantId, id); }
  async readRun(tenantId: string, id: string) { await this.ensureEnabled(tenantId); const [run] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(payrollRuns).where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, id))).limit(1)); if (!run) throw new DomainError('NOT_FOUND', 'Payroll run not found', 404); const lines = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(payrollRunLines).where(and(eq(payrollRunLines.tenantId, tenantId), eq(payrollRunLines.runId, id))).orderBy(payrollRunLines.lineNo)); return { data: { ...run, lines } }; }
  async listRuns(tenantId: string) { await this.ensureEnabled(tenantId); return { data: await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(payrollRuns).where(eq(payrollRuns.tenantId, tenantId)).orderBy(payrollRuns.yearMonth)) }; }
  /**
   * AUD-10 — ترحيل المسيّر: القيد وحالة المسيّر في **معاملة واحدة**.
   *
   * كان المسار يقرأ المسيّر ثم يرحّل القيد بـ`accounting.postJournal` (معاملة مستقلّة)
   * ثم يحدّث الحالة (معاملة ثانية)، فانقطاعٌ بينهما يترك قيداً بلا مسيّر مرحّل أو العكس.
   * الآن:
   *
   *   • `SELECT … FOR UPDATE` على صفّ المسيّر — طلبان متزامنان يتسلسلان، والثاني يقرأ
   *     الحالة بعد الأول؛
   *   • القيد يُكتب بـ`postJournalInTx` داخل المعاملة نفسها؛
   *   • التحديث النهائي مشروط بـ`status = 'draft'`، فإن كان صفٌّ قد سُبق فالمعاملة تُلغى
   *     كاملة (بما فيها القيد) ويُعاد 409 — لا أثر جزئي إطلاقاً؛
   *   • `idempotencyKey` على القيد (`payroll-journal:<id>`) يبقى شبكة أمانٍ إضافية على
   *     الفهرس الفريد، فلا يتكرّر قيد المسيّر نفسه أبداً.
   */
  async postRun(tenantId: string, id: string, input: PostRunInput = {}) {
    await this.ensureEnabled(tenantId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [run] = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, id)))
        .limit(1)
        .for('update');
      if (!run) throw new DomainError('NOT_FOUND', 'Payroll run not found', 404);
      if (run.status !== 'draft')
        throw new DomainError('PAYROLL_RUN_IMMUTABLE', 'Only draft payroll runs can be posted', 409);

      let journalEntryId = input.journalEntryId;
      if (
        !journalEntryId &&
        input.journalLines?.length &&
        input.branchId &&
        (input.fiscalPeriodId ?? run.periodId)
      ) {
        const businessToday = await this.resolveBusinessTodayInTx(tx, tenantId);
        const journal = await this.accounting.postJournalInTx(tx, tenantId, {
          branchId: input.branchId,
          fiscalPeriodId: input.fiscalPeriodId ?? run.periodId!,
          date: businessToday,
          description: `Payroll ${run.yearMonth}`,
          lines: input.journalLines,
          sourceType: 'payroll_run',
          sourceId: id,
          idempotencyKey: `payroll-journal:${id}`,
        });
        if (!journal) throw new DomainError('INTERNAL', 'Payroll journal was not created', 500);
        journalEntryId = journal.id;
      }

      const claimed = await tx
        .update(payrollRuns)
        .set({ status: 'posted', journalEntryId, postedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, id), eq(payrollRuns.status, 'draft')))
        .returning({ id: payrollRuns.id });
      if (claimed.length === 0)
        throw new DomainError('PAYROLL_RUN_IMMUTABLE', 'Only draft payroll runs can be posted', 409);
    });
    return this.readRun(tenantId, id);
  }

  /**
   * AUD-10 — صرف المسيّر: إنشاء سند الخزينة + ترحيله + حالة المسيّر في **معاملة واحدة**.
   *
   * كانت المراحل الثلاث معاملات منفصلة؛ وفشلٌ بينها يترك سنداً مرحّلاً بلا مسيّر «مدفوع»،
   * وإعادة المحاولة قد تنشئ سنداً ثانياً. الآن القفل صفّ المسيّر (`FOR UPDATE`) والبحث عن
   * سندٍ سابق بالمفتاح `payroll:<id>` داخل المعاملة: إعادة المحاولة تربط **نفس** السند
   * ولا تنشئ أثراً ثانياً، وأي فشل يُلغي المعاملة كاملة.
   */
  async payRun(tenantId: string, id: string, input: PayRunInput) {
    await this.ensureEnabled(tenantId);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [run] = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, id)))
        .limit(1)
        .for('update');
      if (!run) throw new DomainError('NOT_FOUND', 'Payroll run not found', 404);
      if (run.status !== 'posted')
        throw new DomainError('PAYROLL_RUN_NOT_POSTED', 'Only posted payroll runs can be paid', 409);

      const lines = await tx
        .select()
        .from(payrollRunLines)
        .where(and(eq(payrollRunLines.tenantId, tenantId), eq(payrollRunLines.runId, id)));
      const payValue = sumLines(lines.map((line) => line.net));
      const idempotencyKey = `payroll:${id}`;

      const [existingVoucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.idempotencyKey, idempotencyKey)))
        .limit(1);

      const businessToday = await this.resolveBusinessTodayInTx(tx, tenantId);
      const voucher =
        existingVoucher ??
        (await this.treasury.createVoucherInTx(tx, tenantId, {
          branchId: input.branchId,
          kind: 'payment',
          subtype: 'salary',
          date: businessToday,
          cashLocationId: input.cashLocationId,
          method: input.method ?? 'cash',
          amount: payValue,
          netAmount: payValue,
          idempotencyKey,
        }));
      if (!voucher) throw new DomainError('INTERNAL', 'Payroll voucher was not created', 500);

      const posted =
        voucher.status === 'posted'
          ? voucher
          : await this.treasury.postVoucherInTx(tx, tenantId, voucher.id, { fiscalPeriodId: input.fiscalPeriodId });

      const claimed = await tx
        .update(payrollRuns)
        .set({ status: 'paid', voucherId: posted.id, paidAt: new Date(), updatedAt: new Date() })
        .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, id), eq(payrollRuns.status, 'posted')))
        .returning({ id: payrollRuns.id });
      if (claimed.length === 0)
        throw new DomainError('PAYROLL_RUN_NOT_POSTED', 'Only posted payroll runs can be paid', 409);
    });
    return this.readRun(tenantId, id);
  }

  async reverseRun(tenantId: string, id: string, reason: string) { await this.ensureEnabled(tenantId); if (!reason.trim()) throw new DomainError('VALIDATION_FAILED', 'Reversal reason is required', 422); const current = await this.readRun(tenantId, id); if (current.data.status !== 'posted' && current.data.status !== 'paid') throw new DomainError('PAYROLL_REVERSAL_INVALID', 'Only posted or paid runs can be reversed', 409); await withTenantTx(this.database.db, tenantId, (tx) => tx.update(payrollRuns).set({ status: 'reversed', reversedAt: new Date(), reversalReason: reason, updatedAt: new Date() }).where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, id)))); return this.readRun(tenantId, id); }

  /**
   * The حوافز والخصومات a month's مسيّر carries.
   *
   * `Form_WPF/FrmReseved.xaml.cs` L166 — «إستحقاق راتب شهر … لسنة …» — sums
   * `EmpSalaryAddSub` into `addSal`/`SubSal` under three conditions, and they are the
   * difference between a مسيّر and a mistake:
   *
   *   • `ESA.SubFromSalary = 1` — only what «✂️ تخصم من الراتب» / «✅ تضاف على الراتب»
   *     marked to ride the salary. A سلفة handed over in cash has already left the till
   *     and already been posted to the employee's account; taking it out of the salary as
   *     well takes it twice.
   *   • `ESA.[date] >= @StartDate AND ESA.[date] < @EndDate` — the document belongs to the
   *     month it is dated in. A window (`startsOn … endsOn`) would keep a one-off خصم in
   *     every salary that follows it.
   *   • `ESA.IS_Deleted = 0`.
   *
   * The cloud adds one condition the desktop has no column for: `status = 'approved'`.
   */
  private async adjustmentsForMonth(tenantId: string, yearMonth: string) {
    const start = `${yearMonth}-01`;
    const [yearText, monthText] = yearMonth.split('-');
    const next = new Date(Date.UTC(Number(yearText), Number(monthText), 1)).toISOString().slice(0, 10);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(salaryAdjustments)
        .where(
          and(
            eq(salaryAdjustments.tenantId, tenantId),
            eq(salaryAdjustments.status, 'approved'),
            isNull(salaryAdjustments.deletedAt),
            eq(salaryAdjustments.subFromSalary, true),
            gte(salaryAdjustments.startsOn, start),
            lt(salaryAdjustments.startsOn, next),
          ),
        ));
  }
}

/**
 * 💵 The six amounts the window prints. `الراتب الأساسي` · `بدل سكن` · `بدل مواصلات` are
 * their own boxes; the four allowances the window has no box for (طعام · طبي · مكافأة
 * ثابتة · أخرى) ride in `otherAllowances`, so `الصافي` here is the مسيّر's `net` exactly.
 * Days without pay shrink `gross` before the three named allowances are subtracted, so
 * `otherAllowances` floors at zero rather than going negative.
 */
function salaryBreakdown(components: Record<string, string>, additions: string, deductions: string, gross: string, net: string) {
  const basic = new Decimal(components.basic || '0');
  const housing = new Decimal(components.housing || '0');
  const transport = new Decimal(components.transport || '0');
  const other = Decimal.max(0, new Decimal(gross).minus(basic).minus(housing).minus(transport));
  return {
    components,
    basic: basic.toFixed(4),
    housing: housing.toFixed(4),
    transport: transport.toFixed(4),
    otherAllowances: other.toFixed(4),
    additions: new Decimal(additions).toFixed(4),
    deductions: new Decimal(deductions).toFixed(4),
    net: new Decimal(net).toFixed(4),
  };
}

function validateComponents(components: Record<string, string>) { for (const entry of Object.entries(components)) if (!new Decimal(entry[1] || '0').isFinite()) throw new DomainError('VALIDATION_FAILED', `Invalid salary component ${entry[0]}`, 422); }
function maskEmployee(employee: Employee) { const bank = employee.bank ?? {}; return { ...employee, bank: { ...bank, iban: maskIban(bank.iban) } }; }
function maskIban(value: string | undefined) { return value ? `${value.slice(0, 4)}********${value.slice(-4)}` : undefined; }
function parseAttendance(csv: string): Array<{ machine: string; enroll: string; datetime: string; inout: string }> { const lines = csv.trim().split(/\r?\n/).filter(Boolean); return lines.slice(lines[0]?.toLowerCase().includes('machine') ? 1 : 0).map((line) => { const [rawMachine, rawEnroll, rawDatetime, rawInout] = line.split(',').map((part) => part?.trim() ?? ''); const inout = rawInout === 'out' ? 'out' : rawInout === 'in' ? 'in' : 'unknown'; return { machine: rawMachine ?? '', enroll: rawEnroll ?? '', datetime: rawDatetime ?? '', inout }; }); }
function attendanceFingerprint(row: { machine: string; enroll: string; datetime: string; inout: string }) { return createHash('sha256').update(`${row.machine}|${row.enroll}|${row.datetime}|${row.inout}`).digest('hex'); }
function rowsOf(result: unknown): Array<Record<string, unknown>> { return Array.isArray(result) ? result as Array<Record<string, unknown>> : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []); }
/**
 * `نوع الحركة` — the labels `frmEmpInvs.xaml.cs` L322–L338 builds from `proc_type` and
 * the window's own `inv_type`: بيع، مرتجع بيع، نقطة بيع ومرتجعها.
 */
function movementTypeOf(kind: string, isPos: boolean) {
  if (kind === 'sale_return') return isPos ? 'فاتورة مرتجع نقطة بيع' : 'فاتورة مرتجع بيع';
  return isPos ? 'فاتورة نقطة بيع' : 'فاتورة بيع';
}

/**
 * «إضافات» — the column the desktop always writes as `0` (L350). The cloud's POS line
 * carries its additions as `modifiers`, so the column has something true to show.
 */
function modifiersTotal(modifiers: Array<Record<string, unknown>> | null | undefined) {
  return (modifiers ?? []).reduce((sum, entry) => sum.plus(new Decimal(String(entry.price ?? entry.amount ?? 0) || '0')), new Decimal(0));
}

function assertEmployeeDates(input: { iqamaExpiresOn?: string | null; insuranceExpiresOn?: string | null; gosiScheme?: string | null }) {
  for (const [field, value] of [
    ['iqamaExpiresOn', input.iqamaExpiresOn],
    ['insuranceExpiresOn', input.insuranceExpiresOn],
  ] as const) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new DomainError('VALIDATION_FAILED', `${field} must be YYYY-MM-DD`, 422, { field });
    }
  }
  if (input.gosiScheme && input.gosiScheme !== 'old' && input.gosiScheme !== 'new') {
    throw new DomainError('VALIDATION_FAILED', 'gosiScheme must be old or new', 422, { field: 'gosiScheme' });
  }
}

function sumLines(values: string[]): string { return values.reduce((sum, valueText) => sum.plus(new Decimal(valueText)), new Decimal(0)).toFixed(4); }
function payslipHtml(yearMonth: string, employeeName: string, netValue: string) { return `<!doctype html><html dir="rtl"><body><h1>قسيمة راتب ${escapeHtml(yearMonth)}</h1><p>${escapeHtml(employeeName)}: ${escapeHtml(netValue)}</p></body></html>`; }
function escapeHtml(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
