import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, newId } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

import { PrintSettingsService, reportScope } from './print-settings.service.js';
import { PrintTemplatesService } from './print-templates.service.js';
import {
  REPORT_DEFINITIONS,
  reportByKey,
  type ReportColumn,
  type ReportFilters,
  type ReportGrandTotal,
  type ReportParam,
} from './report-catalog.js';
import { ReportLayoutsService } from './report-layouts.service.js';
import { buildXlsx } from './xlsx.js';

export const REPORT_KEYS = REPORT_DEFINITIONS.map((definition) => definition.key);
export type ReportKey = string;

const uuidish = z.string().uuid().optional();
const dayish = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional();
// ⏰ الوقت (HH:mm:ss) — the time box beside each date box in `frmRptSalesInPeriod`.
// Hours 00–23 and minutes/seconds 00–59: a looser regex lets `99:99` through to Postgres,
// which answers with a 500 instead of the 422 a wrong filter deserves.
const timeish = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Expected HH:mm or HH:mm:ss').optional();
const invTypeish = z.enum(['pos', 'sale']).optional();
/** 🔄 نوع العملية · 💵 حالة الدفع · 💳 نوع الدفع · 🧾 الضريبة · 📄 نوع الإشعار · 📋 نوع التقرير — the radio and combo boxes of the فاتورة and تحليل windows. */
const procTypeish = z.enum(['sale', 'return']).optional();
const paymentStateish = z.enum(['paid', 'unpaid', 'partial']).optional();
const payMethodish = z.enum(['cash', 'credit', 'card', 'bank']).optional();
const vatish = z.enum(['with', 'without']).optional();
const notificationish = z.enum(['credit', 'debit']).optional();
const dimensionish = z
  .enum(['warehouse', 'customer', 'item', 'salesman', 'user', 'day', 'month', 'category'])
  .optional();

/** Only these filters reach SQL; anything else in the query string is ignored on purpose. */
const filtersSchema = z
  .object({
    from: dayish,
    to: dayish,
    fromTime: timeish,
    toTime: timeish,
    invType: invTypeish,
    procType: procTypeish,
    paymentStatus: paymentStateish,
    payType: payMethodish,
    vat: vatish,
    notificationType: notificationish,
    dimension: dimensionish,
    branchId: uuidish,
    warehouseId: uuidish,
    partyId: uuidish,
    itemId: uuidish,
    categoryId: uuidish,
    salesmanId: uuidish,
    costCenterId: uuidish,
    status: z.string().max(40).optional(),
    kind: z.string().max(40).optional(),
    /** 📄 نوع العملية — one of `frmRptInventory`'s eight inventory documents. */
    docType: z.string().max(40).optional(),
    /** 🔢 الرقم التسلسلي — the free text box of the two serial windows. */
    serial: z.string().max(60).optional(),
    /** 📊 الحساب / الحساب الرئيسي — `cmbAccounts` of `frmRptBalances` · `frmRptCostCenter`. */
    accountId: uuidish,
    /** 🔢 رقم القيد · 📄 رقم المستند — the two free boxes of `frmRptEntries` («🔍 البحث»). */
    entryNo: z.string().max(60).optional(),
    docNo: z.string().max(60).optional(),
    /** 📆 ربع سنة · شهري — the period presets of `frmTaxRptPeriod`, which overwrite من/إلى. */
    quarter: z.string().max(2).optional(),
    month: z.string().max(2).optional(),
    /** 🏦 الصندوق — `cmbSafe` of `frmRptKhzna`: the box whose ledger account is stated. */
    cashLocationId: uuidish,
    /** 📅 السنة — `txtYear` of `frmRptSalary`; it only filters together with الشهر. */
    year: z.string().max(4).optional(),
    /** 📁 الفئة — `cmbGroups` of `frmRptRentInvoices` (`GroupMarine`). */
    groupId: uuidish,
    /** 🏷️ نوع الحساب — «👤 عملاء» · «🏭 موردين» (the كشف حساب windows' own radios). */
    partyKind: z.enum(['all', 'customer', 'supplier']).optional(),
  })
  .partial();

/** A report declares one card or several; internally it is always a list. */
const grandTotalsOf = (definition: { grandTotal?: ReportGrandTotal | ReportGrandTotal[] }): ReportGrandTotal[] =>
  definition.grandTotal ? (Array.isArray(definition.grandTotal) ? definition.grandTotal : [definition.grandTotal]) : [];

const NUMERIC_TYPES = new Set(['money', 'qty', 'int', 'percent']);

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
const EXPORT_FORMATS = new Set<ExportFormat>(['csv', 'xlsx', 'pdf']);

/**
 * Which table holds the display name behind each id-shaped filter. A printed report has to say
 * "الفرع: الفرع الرئيسي", never a raw uuid, or nobody can tell two copies of the same report apart.
 */
const FILTER_SOURCES: Record<string, { table: string; column: string } | undefined> = {
  branch: { table: 'branches', column: 'name_ar' },
  warehouse: { table: 'warehouses', column: 'name' },
  party: { table: 'parties', column: 'name' },
  item: { table: 'items', column: 'name_ar' },
  category: { table: 'item_categories', column: 'name_ar' },
  salesman: { table: 'salesmen', column: 'name' },
  costCenter: { table: 'cost_centers', column: 'name_ar' },
  account: { table: 'accounts', column: 'name_ar' },
  cashLocation: { table: 'cash_locations', column: 'name' },
  vesselGroup: { table: 'vessel_groups', column: 'name' },
};

@Injectable()
export class ReportingService {
  // The handle is injected rather than read from the module-level singleton so a test
  // (or any second connection pool) runs reports against the database it was given.
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly layouts: ReportLayoutsService,
    private readonly print: PrintTemplatesService,
    private readonly printSettings: PrintSettingsService,
  ) {}

  /**
   * 🖨️ إعدادات الطباعة الفعلية لتقرير واحد — the `SettingPrint` row through the
   * `report:<key>` → «تقارير» → «الإفتراضي» chain, plus the one-print overrides of the
   * query string (`?copies=` · `?paper=`), which is what a cashier changing the number of
   * copies for a single print needs.
   */
  private async printOptionsFor(tenantId: string, key: string, params: Record<string, string | undefined>) {
    const settings = await this.printSettings.effective(tenantId, [reportScope(key), 'reports', 'default']);
    const requested = params.paper === 'small' || params.paper === 'a4' ? params.paper : undefined;
    return {
      settings,
      copies: clampPrintNo(params.copies ?? settings.printNo),
      paper: (requested ?? (settings.printType === 2 ? 'small' : 'a4')) as 'a4' | 'small',
    };
  }

  /** Everything a client needs to render every report without hard-coding any of them. */
  catalog() {
    return REPORT_DEFINITIONS.map((definition) => ({
      key: definition.key,
      titleAr: definition.titleAr,
      group: definition.group,
      hintAr: definition.hintAr,
      params: definition.params,
      // A hidden column carries a number the report *prints* but does not draw; the
      // catalogue is what the screen draws from, so it never sees it.
      columns: definition.columns.filter((column) => !column.hidden),
      totals: definition.totals ?? [],
      grandTotal: grandTotalsOf(definition).map((card) => card.labelAr),
      grandTotalCards: grandTotalsOf(definition).map((card) => ({ key: card.key, labelAr: card.labelAr })),
      chart: definition.chart ?? null,
      asyncExport: false,
    }));
  }

  async run(tenantId: string, key: string, params: Record<string, string | undefined> = {}) {
    const definition = reportByKey.get(key);
    if (!definition) throw new DomainError('REPORT_NOT_FOUND', 'Report key is not registered', 404);

    // A saved layout (مصمم التقارير) contributes default filters and a column presentation.
    // The caller's own filters always win: the layout is a starting point, not a cage.
    const { layout: layoutRef, ...rest } = params;
    const layout = await this.layouts.resolve(tenantId, key, layoutRef);
    const filters = parseFilters({ ...(layout?.filters ?? {}), ...rest });

    const database = this.database.db;
    const rows = await withTenantTx(database, tenantId, async (tx) => rowsOf(await tx.execute(definition.build(tenantId, filters))));
    const normalized = rows.map((row) => normalizeRow(row, definition.columns));
    const columns = applyLayoutColumns(definition.columns, layout?.columns);
    return {
      key,
      titleAr: layout?.titleAr || definition.titleAr,
      group: definition.group,
      hintAr: definition.hintAr ?? null,
      chart: definition.chart ?? null,
      params: filters,
      layout: layout ? { id: layout.id, name: layout.name } : null,
      columns,
      rows: normalized,
      totals: sumColumns(normalized, definition.totals ?? []),
      // 💰 The summary cards under the grid — «💵 إجمالي صافي البيع» · «📦 إجمالي
      // الكميات» · «💰 إجمالي الربح». Summed from the rows, never re-queried: a card has
      // to agree with the grid above it.
      grandTotal: grandTotalsOf(definition).map((card) => ({
        key: card.key,
        labelAr: card.labelAr,
        amount: sumColumns(normalized, [card.key])[card.key] ?? '0',
      })),
      rowCount: normalized.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 🖨️ طباعة — the print-ready page of one report, the way «👁️ معاينة» و«🖨️ طباعة»
   * open it at the desktop: المنشأة في الرأس (`header.repx`), then the report title, the
   * filters, the grid, «💰 إجمالي…» and the signature strip «أعده · راجعه · المدير»
   * (`footer.repx` inside `RptSalesInPeriod1/2.repx`).
   */
  async printable(tenantId: string, key: string, params: Record<string, string | undefined> = {}, userId?: string): Promise<{ html: string }> {
    const report = await this.run(tenantId, key, params);
    const definition = reportByKey.get(key)!;
    const captions = await this.filterCaptions(tenantId, definition.params, report.params as Record<string, string>);
    const html = await this.print.reportSheet(
      tenantId,
      {
        titleAr: report.titleAr,
        columns: report.columns.map((column) => ({ key: column.key, labelAr: column.labelAr, numeric: isNumericColumn(column) })),
        rows: report.rows,
        totals: report.totals,
        grandTotal: report.grandTotal,
        captions,
        generatedAt: report.generatedAt,
        emptyAr: definition.emptyAr,
        signature: definition.signature ?? false,
        // 🖨️ كيف تُطبع هذه الورقة — `Print.cs` `Printing()` reads the same fields.
        print: await this.printOptionsFor(tenantId, key, params),
      },
      userId,
    );
    return { html };
  }

  /**
   * Exports are produced inline — the dataset is already capped, so there is nothing to queue.
   *
   * Three formats, three real files:
   * - `csv`  — UTF-8 with a BOM so Excel on Windows reads Arabic instead of mojibake.
   * - `xlsx` — a genuine workbook (right-to-left sheet, frozen header, numeric cells that sum).
   * - `pdf`  — a print-ready A4 landscape page on the company letterhead; the browser turns it
   *   into a PDF. Rendering a PDF here would mean shipping a font with Arabic shaping, and the
   *   print dialog already produces a better-looking, selectable document.
   *
   * The payload is base64 for binary formats and plain text otherwise, so one endpoint can
   * serve all three without content negotiation.
   */
  async export(tenantId: string, key: string, params: Record<string, string | undefined> = {}, format: ExportFormat = 'csv') {
    if (!EXPORT_FORMATS.has(format)) throw new DomainError('VALIDATION_FAILED', `Unsupported export format: ${format}`, 422);
    const report = await this.run(tenantId, key, params);
    const definition = reportByKey.get(key)!;
    const stamp = report.generatedAt.slice(0, 10);
    const base = { exportId: newId(), status: 'ready' as const, format, reportKey: key, titleAr: report.titleAr, rows: report.rows.length };
    const captions = await this.filterCaptions(tenantId, definition.params, report.params);

    if (format === 'xlsx') {
      const workbook = buildXlsx({
        name: report.titleAr,
        titleAr: report.titleAr,
        captions: [...captions, `عدد السجلات: ${report.rows.length}`, `طُبع في: ${report.generatedAt.slice(0, 16).replace('T', ' ')}`],
        columns: report.columns.map((column) => ({
          header: column.labelAr,
          kind: isNumericColumn(column) ? (column.type === 'int' ? 'integer' : 'number') : 'text',
          width: column.type === 'text' ? 26 : 15,
        })),
        rows: report.rows.map((row) => report.columns.map((column) => row[column.key] ?? '')),
        totalsRow: Object.keys(report.totals).length
          ? report.columns.map((column, index) => (report.totals[column.key] ? report.totals[column.key]! : index === 0 ? 'الإجمالي' : ''))
          : undefined,
      });
      return {
        ...base,
        filename: `${key}-${stamp}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        encoding: 'base64' as const,
        content: workbook.toString('base64'),
      };
    }

    if (format === 'pdf') {
      const html = await this.print.reportSheet(tenantId, {
        titleAr: report.titleAr,
        columns: report.columns.map((column) => ({ key: column.key, labelAr: column.labelAr, numeric: isNumericColumn(column) })),
        rows: report.rows,
        totals: report.totals,
        grandTotal: report.grandTotal,
        captions,
        generatedAt: report.generatedAt,
        emptyAr: definition.emptyAr,
        signature: definition.signature ?? false,
        // 🖨️ «طباعة / PDF» and «👁️ معاينة الطباعة» print the same sheet, so both honor
        // `SettingPrint` — the desktop has one `Print.cs` for both buttons too.
        print: await this.printOptionsFor(tenantId, key, params),
      });
      return { ...base, filename: `${key}-${stamp}.html`, mimeType: 'text/html; charset=utf-8', encoding: 'utf-8' as const, content: html, printable: true as const };
    }

    const csv = toCsv(report.columns, report.rows);
    return { ...base, filename: `${key}-${stamp}.csv`, mimeType: 'text/csv; charset=utf-8', encoding: 'utf-8' as const, content: csv, csv };
  }


  /** Turns the applied filters into the caption lines printed under the report title. */
  private async filterCaptions(tenantId: string, params: ReportParam[], applied: Record<string, string>): Promise<string[]> {
    const captions: string[] = [];
    const period = [applied.from, applied.to].filter(Boolean);
    if (period.length === 2) captions.push(`الفترة: من ${applied.from} إلى ${applied.to}`);
    else if (applied.from) captions.push(`من تاريخ: ${applied.from}`);
    else if (applied.to) captions.push(`إلى تاريخ: ${applied.to}`);

    for (const param of params) {
      const value = applied[param.name];
      if (!value || param.kind === 'date') continue;
      if (param.options?.length) {
        captions.push(`${param.labelAr}: ${param.options.find((option) => option.value === value)?.labelAr ?? value}`);
        continue;
      }
      const source = FILTER_SOURCES[param.kind];
      if (!source) {
        captions.push(`${param.labelAr}: ${value}`);
        continue;
      }
      const name = await this.lookupName(tenantId, source, value);
      captions.push(`${param.labelAr}: ${name ?? value}`);
    }
    return captions;
  }

  private async lookupName(tenantId: string, source: { table: string; column: string }, id: string): Promise<string | null> {
    try {
      const found = await withTenantTx(this.database.db, tenantId, async (tx) =>
        rowsOf(await tx.execute(sql`SELECT ${sql.raw(source.column)} AS label FROM ${sql.raw(source.table)} WHERE tenant_id = ${tenantId} AND id = ${id} LIMIT 1`)),
      );
      const label = found[0]?.label;
      return typeof label === 'string' && label ? label : null;
    } catch {
      return null; // a caption is decoration; it must never fail an export
    }
  }
}

/**
 * Reorder, rename and hide columns per a saved layout. Hidden columns are dropped from the
 * response shape only — the rows still carry their values, so a totals row or an export
 * that a user re-enables later does not need the report to be run again.
 */
export function applyLayoutColumns(columns: ReportColumn[], layout?: Array<{ key: string; labelAr?: string; visible: boolean }> | null) {
  if (!layout?.length) return columns.filter((column) => !column.hidden);
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const chosen = layout
    .filter((entry) => entry.visible && byKey.has(entry.key))
    .map((entry) => ({ ...byKey.get(entry.key)!, labelAr: entry.labelAr || byKey.get(entry.key)!.labelAr }));
  return chosen.length ? chosen : columns;
}

export function parseFilters(params: Record<string, string | undefined>): ReportFilters {
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[name] = value.trim();
  }
  const parsed = filtersSchema.safeParse(cleaned);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Invalid report filter', 422);
  return parsed.data;
}

/** Postgres hands back `Date` objects and nulls; reports must be plain JSON strings. */
function normalizeRow(row: Record<string, unknown>, columns: ReportColumn[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const column of columns) {
    const raw = row[column.key];
    output[column.key] = raw === null || raw === undefined ? '' : raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw);
  }
  return output;
}

export function sumColumns(rows: Array<Record<string, string>>, keys: string[]): Record<string, string> {
  const totals: Record<string, string> = {};
  for (const key of keys) {
    let sum = new Decimal(0);
    for (const row of rows) {
      const raw = row[key];
      if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) continue;
      sum = sum.plus(raw);
    }
    totals[key] = sum.toFixed(sum.decimalPlaces() > 2 ? 4 : 2);
  }
  return totals;
}

export function toCsv(columns: ReportColumn[], rows: Array<Record<string, string>>): string {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const header = columns.map((column) => escape(column.labelAr)).join(',');
  const body = rows.map((row) => columns.map((column) => escape(row[column.key] ?? '')).join(','));
  return ['\uFEFF' + header, ...body].join('\n');
}

export function isNumericColumn(column: ReportColumn): boolean { return NUMERIC_TYPES.has(column.type); }

/** 🔢 عدد النسخ — `printNo` of `SettingPrint`, clamped the way the desktop's loop is (1..50). */
function clampPrintNo(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}
