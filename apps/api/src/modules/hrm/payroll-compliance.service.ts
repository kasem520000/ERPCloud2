import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { DomainError, errorCodes, newId } from '@erp/contracts';
import {
  employees,
  payrollComplianceSettings,
  payrollGosiFiles,
  payrollRunLines,
  payrollRuns,
  payrollWpsFiles,
  tenantSettings,
  tenants,
  withTenantTx,
  type DatabaseHandle,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';

import {
  buildGosiRows,
  buildWpsRows,
  complianceAlerts,
  renderGosiCsv,
  renderWpsCsv,
  todayInRiyadh,
  todayInTimezone,
  type WpsEmployee,
} from './payroll-compliance.js';

const FILE_STATUSES = new Set(['generated', 'uploaded', 'accepted', 'rejected']);

export type ComplianceSettingsInput = {
  establishmentId?: string;
  bankCode?: string;
  gosiEstablishmentNo?: string;
  defaultCashLocationId?: string | null;
};

export type WpsExportInput = {
  bankCode?: string;
  establishmentId?: string;
  valueDate?: string;
};

@Injectable()
export class PayrollComplianceService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async settings(tenantId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(payrollComplianceSettings).where(eq(payrollComplianceSettings.tenantId, tenantId)).limit(1),
    );
    return {
      establishmentId: row?.establishmentId ?? '',
      bankCode: row?.bankCode ?? '',
      gosiEstablishmentNo: row?.gosiEstablishmentNo ?? '',
      defaultCashLocationId: row?.defaultCashLocationId ?? null,
    };
  }

  async saveSettings(tenantId: string, input: ComplianceSettingsInput) {
    const current = await this.settings(tenantId);
    const next = {
      establishmentId: input.establishmentId?.trim() ?? current.establishmentId,
      bankCode: (input.bankCode?.trim() ?? current.bankCode).toUpperCase(),
      gosiEstablishmentNo: input.gosiEstablishmentNo?.trim() ?? current.gosiEstablishmentNo,
      defaultCashLocationId: input.defaultCashLocationId === undefined ? current.defaultCashLocationId : input.defaultCashLocationId,
      updatedAt: new Date(),
    };
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(payrollComplianceSettings)
        .values({ tenantId, ...next })
        .onConflictDoUpdate({ target: payrollComplianceSettings.tenantId, set: next }),
    );
    return this.settings(tenantId);
  }

  async alerts(tenantId: string, withinDays = 30, today?: string) {
    const { resolvedToday, rows } = await withTenantTx(this.database.db, tenantId, async (tx) => {
      let effectiveToday = today;
      if (!effectiveToday) {
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
        effectiveToday = todayInTimezone(tz);
      }
      const employeeRows = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.tenantId, tenantId), eq(employees.status, 'active'), isNull(employees.deletedAt)));
      return { resolvedToday: effectiveToday ?? todayInRiyadh(), rows: employeeRows };
    });
    const data = complianceAlerts(rows.map((row) => toWageEmployee(row)), resolvedToday, withinDays);
    return { today: resolvedToday, withinDays, count: data.length, data };
  }

  async wpsPreview(tenantId: string, runId: string, input: WpsExportInput = {}) {
    const { run, rows, bankCode, establishmentId } = await this.wpsContext(tenantId, runId, input);
    return {
      payrollRunId: run.id,
      yearMonth: run.yearMonth,
      bankCode,
      establishmentId,
      employeeCount: rows.length,
      ready: rows.every((row) => row.errors.length === 0) && rows.length > 0,
      totalNet: rows.reduce((sum, row) => sum.plus(row.net), new Decimal(0)).toFixed(2),
      rows,
      csv: rows.length ? renderWpsCsv(rows) : '',
    };
  }

  async wpsExport(tenantId: string, runId: string, input: WpsExportInput = {}) {
    const preview = await this.wpsPreview(tenantId, runId, input);
    if (!preview.ready) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'ملف حماية الأجور غير مكتمل', 422, {
        rows: preview.rows.filter((row) => row.errors.length > 0),
      });
    }
    if (!preview.establishmentId) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'رقم المنشأة في مدد مطلوب قبل التصدير', 422, {
        field: 'establishmentId',
      });
    }
    const id = newId();
    const fileId = newId();
    const fileName = `WPS_${preview.establishmentId}_${preview.yearMonth.replace('-', '')}.csv`;
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(payrollWpsFiles)
        .values({
          id,
          tenantId,
          payrollRunId: runId,
          fileId,
          bankCode: preview.bankCode,
          establishmentId: preview.establishmentId,
          status: 'generated',
          fileName,
          csvText: preview.csv,
          employeeCount: preview.employeeCount,
          totalNet: preview.totalNet,
          createdBy: tryGetAuthContext()?.userId ?? null,
        })
        .returning(),
    );
    return toWpsFile(row!);
  }

  async listWps(tenantId: string, runId: string) {
    await this.requireRun(tenantId, runId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(payrollWpsFiles)
        .where(and(eq(payrollWpsFiles.tenantId, tenantId), eq(payrollWpsFiles.payrollRunId, runId)))
        .orderBy(desc(payrollWpsFiles.createdAt)),
    );
    return rows.map((row) => toWpsFile(row, false));
  }

  async readWps(tenantId: string, fileId: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(payrollWpsFiles)
        .where(and(eq(payrollWpsFiles.tenantId, tenantId), eq(payrollWpsFiles.id, fileId)))
        .limit(1),
    );
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'ملف حماية الأجور غير موجود', 404);
    return toWpsFile(row);
  }

  async updateWps(tenantId: string, fileId: string, input: { status?: string; bankResponse?: string | null }) {
    if (input.status && !FILE_STATUSES.has(input.status)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'حالة الملف غير معروفة', 422, { field: 'status' });
    }
    const current = await this.readWps(tenantId, fileId);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(payrollWpsFiles)
        .set({
          status: input.status ?? current.status,
          bankResponse: input.bankResponse === undefined ? current.bankResponse : input.bankResponse,
          updatedAt: new Date(),
        })
        .where(and(eq(payrollWpsFiles.tenantId, tenantId), eq(payrollWpsFiles.id, fileId)))
        .returning(),
    );
    return toWpsFile(row!);
  }

  async gosiPreview(tenantId: string, runId: string) {
    const { run, employees: staff } = await this.runEmployees(tenantId, runId);
    const settings = await this.settings(tenantId);
    const rows = buildGosiRows(staff, `${run.yearMonth}-01`);
    return {
      payrollRunId: run.id,
      yearMonth: run.yearMonth,
      establishmentNo: settings.gosiEstablishmentNo,
      employeeCount: rows.length,
      ready: rows.every((row) => row.errors.length === 0) && rows.length > 0,
      totalContribution: rows.reduce((sum, row) => sum.plus(row.totalContribution), new Decimal(0)).toFixed(2),
      rows,
      csv: rows.length ? renderGosiCsv(rows) : '',
    };
  }

  async gosiExport(tenantId: string, runId: string) {
    const preview = await this.gosiPreview(tenantId, runId);
    if (!preview.ready) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'ملف التأمينات غير مكتمل', 422, {
        rows: preview.rows.filter((row) => row.errors.length > 0),
      });
    }
    const id = newId();
    const fileName = `GOSI_${preview.establishmentNo || 'EST'}_${preview.yearMonth.replace('-', '')}.csv`;
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(payrollGosiFiles)
        .values({
          id,
          tenantId,
          payrollRunId: runId,
          fileId: newId(),
          establishmentNo: preview.establishmentNo,
          status: 'generated',
          fileName,
          csvText: preview.csv,
          employeeCount: preview.employeeCount,
          totalContribution: preview.totalContribution,
          createdBy: tryGetAuthContext()?.userId ?? null,
        })
        .returning(),
    );
    return toGosiFile(row!);
  }

  async listGosi(tenantId: string, runId: string) {
    await this.requireRun(tenantId, runId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(payrollGosiFiles)
        .where(and(eq(payrollGosiFiles.tenantId, tenantId), eq(payrollGosiFiles.payrollRunId, runId)))
        .orderBy(desc(payrollGosiFiles.createdAt)),
    );
    return rows.map((row) => toGosiFile(row, false));
  }

  private async wpsContext(tenantId: string, runId: string, input: WpsExportInput) {
    const { run, employees: staff } = await this.runEmployees(tenantId, runId);
    const settings = await this.settings(tenantId);
    const bankCode = (input.bankCode?.trim() || settings.bankCode).toUpperCase();
    const establishmentId = input.establishmentId?.trim() || settings.establishmentId;
    if (input.valueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'valueDate must be YYYY-MM-DD', 422, { field: 'valueDate' });
    }
    return { run, rows: buildWpsRows(staff), bankCode, establishmentId };
  }

  private async runEmployees(tenantId: string, runId: string) {
    const run = await this.requireRun(tenantId, runId);
    const lines = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(payrollRunLines).where(and(eq(payrollRunLines.tenantId, tenantId), eq(payrollRunLines.runId, runId))),
    );
    const ids = lines.map((line) => line.employeeId);
    const staff = ids.length
      ? await withTenantTx(this.database.db, tenantId, (tx) =>
          tx.select().from(employees).where(and(eq(employees.tenantId, tenantId), inArray(employees.id, ids))),
        )
      : [];
    const byId = new Map(staff.map((row) => [row.id, row]));
    const wageEmployees = lines.map((line) => {
      const employee = byId.get(line.employeeId);
      return toWageEmployee(employee, {
        additions: line.additions,
        deductions: line.deductions,
        gross: line.gross,
        net: line.net,
        components: { ...(employee?.salaryComponents ?? {}), ...(line.components ?? {}) },
      });
    });
    return { run, employees: wageEmployees };
  }

  private async requireRun(tenantId: string, runId: string) {
    const [run] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.select().from(payrollRuns).where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId))).limit(1),
    );
    if (!run) throw new DomainError(errorCodes.NOT_FOUND, 'مسيّر الرواتب غير موجود', 404);
    if (run.status === 'reversed') throw new DomainError(errorCodes.INVALID_STATE, 'لا يمكن تصدير مسيّر معكوس', 409);
    return run;
  }
}

function toWageEmployee(
  employee: typeof employees.$inferSelect | undefined,
  overlay: Partial<WpsEmployee> = {},
): WpsEmployee {
  return {
    employeeId: employee?.id ?? overlay.employeeId ?? '',
    employeeNo: employee?.employeeNo,
    name: employee?.name ?? '',
    nationalId: employee?.nationalId,
    nationality: employee?.nationality,
    insuranceNo: employee?.insuranceNo,
    hireDate: employee?.hireDate,
    gosiScheme: employee?.gosiScheme,
    status: employee?.status,
    iqamaExpiresOn: employee?.iqamaExpiresOn,
    insuranceExpiresOn: employee?.insuranceExpiresOn,
    components: employee?.salaryComponents ?? {},
    bank: employee?.bank ?? {},
    ...overlay,
  };
}

function toWpsFile(row: typeof payrollWpsFiles.$inferSelect, includeCsv = true) {
  return {
    id: row.id,
    fileId: row.fileId,
    payrollRunId: row.payrollRunId,
    bankCode: row.bankCode,
    establishmentId: row.establishmentId,
    status: row.status,
    bankResponse: row.bankResponse,
    fileName: row.fileName,
    employeeCount: row.employeeCount,
    totalNet: row.totalNet,
    createdAt: row.createdAt,
    ...(includeCsv ? { csv: row.csvText } : {}),
  };
}

function toGosiFile(row: typeof payrollGosiFiles.$inferSelect, includeCsv = true) {
  return {
    id: row.id,
    fileId: row.fileId,
    payrollRunId: row.payrollRunId,
    establishmentNo: row.establishmentNo,
    status: row.status,
    fileName: row.fileName,
    employeeCount: row.employeeCount,
    totalContribution: row.totalContribution,
    createdAt: row.createdAt,
    ...(includeCsv ? { csv: row.csvText } : {}),
  };
}
