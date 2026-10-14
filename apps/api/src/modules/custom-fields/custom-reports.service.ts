import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  customReportBaseEntitySchema,
  customReportInputSchema,
  DomainError,
  errorCodes,
  newId,
  type CustomReportInput,
  type CustomReportColumn,
  type CustomReportFilter,
} from '@erp/contracts';
import {
  customReports,
  employees,
  items,
  parties,
  salesInvoiceLines,
  salesInvoices,
  withTenantTx,
  type CustomReport,
  type DatabaseHandle,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

import { CustomFieldsService } from './custom-fields.service.js';

const MAX_ROWS = 2000;

type Entity = 'party' | 'item' | 'invoice' | 'employee';
type ColumnSpec = { source: 'native' | 'custom' | 'relation'; key: string; label?: string; agg?: 'sum' | 'count' | 'avg' | 'min' | 'max' };
type FilterSpec = { source: 'native' | 'custom' | 'relation'; key: string; op: string; value: unknown };
type ReportRow = { id: string; [key: string]: unknown; customFields?: Record<string, unknown>; itemCustomFields?: Record<string, unknown> };

type FieldDefinition = { key: string; label: string; source: 'native' | 'custom' | 'relation'; type: string };

const nativeFields: Record<string, FieldDefinition[]> = {
  party: [
    { key: 'id', label: 'المعرّف', source: 'native', type: 'text' },
    { key: 'code', label: 'الرمز', source: 'native', type: 'text' },
    { key: 'name', label: 'الاسم', source: 'native', type: 'text' },
    { key: 'kind', label: 'النوع', source: 'native', type: 'text' },
    { key: 'phone', label: 'الهاتف', source: 'native', type: 'text' },
    { key: 'email', label: 'البريد', source: 'native', type: 'text' },
  ],
  item: [
    { key: 'id', label: 'المعرّف', source: 'native', type: 'text' },
    { key: 'sku', label: 'رمز الصنف', source: 'native', type: 'text' },
    { key: 'barcode', label: 'الباركود', source: 'native', type: 'text' },
    { key: 'name', label: 'الصنف', source: 'native', type: 'text' },
    { key: 'kind', label: 'النوع', source: 'native', type: 'text' },
    { key: 'salePrice', label: 'سعر البيع', source: 'native', type: 'number' },
    { key: 'purchasePrice', label: 'سعر الشراء', source: 'native', type: 'number' },
  ],
  employee: [
    { key: 'id', label: 'المعرّف', source: 'native', type: 'text' },
    { key: 'employeeNo', label: 'رقم الموظف', source: 'native', type: 'text' },
    { key: 'name', label: 'الاسم', source: 'native', type: 'text' },
    { key: 'status', label: 'الحالة', source: 'native', type: 'text' },
    { key: 'hireDate', label: 'تاريخ التعيين', source: 'native', type: 'date' },
  ],
  sales_invoice: [
    { key: 'id', label: 'المعرّف', source: 'native', type: 'text' },
    { key: 'number', label: 'رقم الفاتورة', source: 'native', type: 'text' },
    { key: 'kind', label: 'النوع', source: 'native', type: 'text' },
    { key: 'status', label: 'الحالة', source: 'native', type: 'text' },
    { key: 'paymentStatus', label: 'حالة الدفع', source: 'native', type: 'text' },
    { key: 'total', label: 'الإجمالي', source: 'native', type: 'number' },
    { key: 'subtotal', label: 'الصافي', source: 'native', type: 'number' },
    { key: 'taxTotal', label: 'الضريبة', source: 'native', type: 'number' },
    { key: 'paidTotal', label: 'المدفوع', source: 'native', type: 'number' },
    { key: 'profit', label: 'الربح', source: 'native', type: 'number' },
    { key: 'createdAt', label: 'تاريخ الإنشاء', source: 'native', type: 'date' },
    { key: 'date', label: 'التاريخ', source: 'native', type: 'date' },
    { key: 'postedAt', label: 'تاريخ الترحيل', source: 'native', type: 'date' },
    { key: 'partyId', label: 'معرّف العميل', source: 'relation', type: 'text' },
    { key: 'partyName', label: 'العميل', source: 'relation', type: 'text' },
    { key: 'party.name', label: 'العميل', source: 'relation', type: 'text' },
  ],
};

function reportEntity(baseEntity: string): Entity {
  return baseEntity === 'sales_invoice' || baseEntity === 'invoice' ? 'invoice' : baseEntity as Entity;
}

function printable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function comparable(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const numeric = Number(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(numeric) ? numeric : String(value);
}

@Injectable()
export class CustomReportsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly fields: CustomFieldsService,
  ) {}

  async fieldCatalog(tenantId: string, baseEntity: string) {
    const parsed = customReportBaseEntitySchema.safeParse(baseEntity);
    if (!parsed.success) throw this.validation('Unsupported report base entity');
    const entity = reportEntity(parsed.data);
    const custom = await this.fields.list(tenantId, entity);
    const relatedItems = parsed.data === 'sales_invoice' || parsed.data === 'invoice' ? await this.fields.list(tenantId, 'item') : [];
    const customKeys = new Set(custom.map((field) => field.key));
    return {
      baseEntity: parsed.data,
      fields: [
        ...(nativeFields[parsed.data] ?? nativeFields.sales_invoice!),
        ...custom.map((field) => ({ key: field.key, label: field.label, source: 'custom' as const, type: field.type, options: field.options })),
        ...relatedItems.filter((field) => !customKeys.has(field.key)).map((field) => ({ key: field.key, label: `${field.label} (الصنف)`, source: 'custom' as const, type: field.type, options: field.options })),
      ],
    };
  }

  async list(tenantId: string) {
    const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(customReports).where(and(
      eq(customReports.tenantId, tenantId),
      isNull(customReports.deletedAt),
    )).orderBy(asc(customReports.name)));
    return rows.map(this.publicReport);
  }

  async get(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(customReports).where(and(
      eq(customReports.tenantId, tenantId),
      eq(customReports.id, id),
      isNull(customReports.deletedAt),
    )));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Custom report was not found', 404);
    return this.publicReport(row);
  }

  async create(tenantId: string, raw: unknown, userId?: string) {
    const input = this.parseInput(raw);
    await this.validateDefinition(tenantId, input);
    const id = newId();
    try {
      const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(customReports).values({
        id,
        tenantId,
        name: input.name,
        baseEntity: input.baseEntity,
        columns: input.columns,
        filters: input.filters,
        chartType: input.chartType,
        isPublic: input.isPublic,
        createdBy: userId,
      }).returning());
      if (!row) throw new DomainError(errorCodes.INTERNAL, 'Custom report was not created', 500);
      return this.publicReport(row);
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new DomainError('CUSTOM_REPORT_NAME_TAKEN', 'A report with this name already exists', 409);
      throw error;
    }
  }

  async update(tenantId: string, id: string, raw: unknown, userId?: string) {
    const current = await this.getRaw(tenantId, id);
    const input = this.parseInput({ ...current, ...(raw as Record<string, unknown>), columns: (raw as Record<string, unknown>)?.columns ?? current.columns, filters: (raw as Record<string, unknown>)?.filters ?? current.filters });
    await this.validateDefinition(tenantId, input);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.update(customReports).set({
      name: input.name,
      baseEntity: input.baseEntity,
      columns: input.columns,
      filters: input.filters,
      chartType: input.chartType,
      isPublic: input.isPublic,
      updatedAt: new Date(),
      updatedBy: userId,
      version: current.version + 1,
    }).where(and(eq(customReports.tenantId, tenantId), eq(customReports.id, id), isNull(customReports.deletedAt))).returning());
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Custom report was not found', 404);
    return this.publicReport(row);
  }

  async remove(tenantId: string, id: string, userId?: string) {
    await this.get(tenantId, id);
    await withTenantTx(this.database.db, tenantId, (tx) => tx.update(customReports).set({ deletedAt: new Date(), deletedBy: userId, updatedAt: new Date(), updatedBy: userId }).where(and(eq(customReports.tenantId, tenantId), eq(customReports.id, id))));
    return { id, deleted: true };
  }

  async run(tenantId: string, id: string) {
    const stored = await this.getRaw(tenantId, id);
    const input = this.parseInput(stored);
    await this.validateDefinition(tenantId, input);
    const sourceRows = await this.loadRows(tenantId, input.baseEntity);
    const entity = reportEntity(input.baseEntity);
    const decoratedRows = await this.fields.decorate(tenantId, entity, sourceRows);
    const itemRows = decoratedRows
      .filter((row) => typeof row.itemId === 'string')
      .map((row) => ({ id: row.itemId as string }));
    const decoratedItems = itemRows.length ? await this.fields.decorate(tenantId, 'item', itemRows) : [];
    const itemFieldsById = new Map(decoratedItems.map((row) => [row.id, row.customFields]));
    const rows = decoratedRows.map((row) => ({ ...row, itemCustomFields: typeof row.itemId === 'string' ? itemFieldsById.get(row.itemId) ?? {} : {} }));
    const filtered = rows.filter((row) => input.filters.every((filter) => this.matches(row, this.normalizeFilter(filter, input.baseEntity)))).slice(0, MAX_ROWS);
    const columns = input.columns.map((column) => this.normalizeColumn(column, input.baseEntity));
    const outputRows = filtered.map((row) => Object.fromEntries(columns.map((column) => [column.key, this.valueFor(row, column)])));
    const totals = this.totals(columns, filtered);
    const chart = {
      type: input.chartType,
      labels: outputRows.slice(0, 100).map((row, index) => printable(row[columns[0]?.key ?? '']) || String(index + 1)),
      series: columns.filter((column) => column.agg || this.isNumeric(column)).map((column) => ({ key: column.key, label: column.label ?? column.key, values: outputRows.slice(0, 100).map((row) => row[column.key] ?? null) })),
    };
    return {
      report: this.publicReport(stored),
      columns: columns.map((column) => ({ key: column.key, label: column.label ?? column.key, source: column.source, agg: column.agg ?? null })),
      rows: outputRows,
      totals,
      chart,
      rowCount: filtered.length,
      generatedAt: new Date().toISOString(),
    };
  }

  async export(tenantId: string, id: string, format: string) {
    const normalized = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : null;
    if (!normalized) throw this.validation('Custom report exports support csv or pdf');
    const result = await this.run(tenantId, id);
    const stamp = result.generatedAt.slice(0, 10);
    if (normalized === 'csv') {
      const header = result.columns.map((column) => this.csvCell(column.label)).join(',');
      const body = result.rows.map((row) => result.columns.map((column) => this.csvCell(row[column.key])).join(',')).join('\n');
      return { format: 'csv', filename: `custom-report-${id}-${stamp}.csv`, mimeType: 'text/csv; charset=utf-8', encoding: 'utf-8', content: `\uFEFF${header}\n${body}` };
    }
    const head = result.columns.map((column) => `<th>${this.escapeHtml(column.label)}</th>`).join('');
    const body = result.rows.map((row) => `<tr>${result.columns.map((column) => `<td>${this.escapeHtml(printable(row[column.key]))}</td>`).join('')}</tr>`).join('');
    return {
      format: 'pdf',
      filename: `custom-report-${id}-${stamp}.html`,
      mimeType: 'text/html; charset=utf-8',
      encoding: 'utf-8',
      printable: true,
      content: `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>${this.escapeHtml(result.report.name)}</title><style>body{font-family:Arial;padding:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px;text-align:right}th{background:#eee}@media print{button{display:none}}</style></head><body><button onclick="print()">طباعة / حفظ PDF</button><h1>${this.escapeHtml(result.report.name)}</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`,
    };
  }

  private async loadRows(tenantId: string, baseEntity: string): Promise<ReportRow[]> {
    const rows = await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (baseEntity === 'party') {
        return tx.select({ id: parties.id, code: parties.code, name: parties.name, kind: parties.kind, phone: parties.phone, email: parties.email }).from(parties).where(and(eq(parties.tenantId, tenantId), isNull(parties.deletedAt))).limit(MAX_ROWS);
      }
      if (baseEntity === 'item') {
        return tx.select({ id: items.id, sku: items.sku, barcode: items.barcode, name: items.nameAr, kind: items.kind, salePrice: items.salePrice, purchasePrice: items.purchasePrice }).from(items).where(and(eq(items.tenantId, tenantId), isNull(items.deletedAt))).limit(MAX_ROWS);
      }
      if (baseEntity === 'employee') {
        return tx.select({ id: employees.id, employeeNo: employees.employeeNo, name: employees.name, status: employees.status, hireDate: employees.hireDate }).from(employees).where(and(eq(employees.tenantId, tenantId), isNull(employees.deletedAt))).limit(MAX_ROWS);
      }
      const invoiceRows = await tx.select({ id: salesInvoices.id, number: salesInvoices.number, kind: salesInvoices.kind, status: salesInvoices.status, paymentStatus: salesInvoices.paymentStatus, total: salesInvoices.total, subtotal: salesInvoices.subtotal, taxTotal: salesInvoices.taxTotal, paidTotal: salesInvoices.paidTotal, profit: salesInvoices.profit, createdAt: salesInvoices.createdAt, postedAt: salesInvoices.postedAt, partyId: salesInvoices.partyId, partyName: parties.name }).from(salesInvoices).leftJoin(parties, eq(parties.id, salesInvoices.partyId)).where(eq(salesInvoices.tenantId, tenantId)).limit(MAX_ROWS);
      const lineRows = await tx.select({ invoiceId: salesInvoiceLines.invoiceId, itemId: salesInvoiceLines.itemId }).from(salesInvoiceLines).where(eq(salesInvoiceLines.tenantId, tenantId));
      const firstItem = new Map<string, string>();
      for (const line of lineRows) if (line.itemId && !firstItem.has(line.invoiceId)) firstItem.set(line.invoiceId, line.itemId);
      return invoiceRows.map((row) => ({ ...row, itemId: firstItem.get(row.id) ?? null }));
    });
    return (rows as Array<{ id: string; createdAt?: unknown; partyName?: unknown }>).map((row) => ({ ...row, ...(baseEntity === 'sales_invoice' || baseEntity === 'invoice' ? { date: row.createdAt, 'party.name': row.partyName } : {}) } as ReportRow));
  }

  private normalizeColumn(raw: CustomReportColumn, _baseEntity: string): ColumnSpec {
    const source = raw.source ?? (raw.custom_field ? 'custom' : 'native');
    const key = raw.custom_field ?? raw.field ?? raw.key ?? '';
    return { source, key, label: raw.label, agg: raw.agg };
  }

  private normalizeFilter(raw: CustomReportFilter, _baseEntity: string): FilterSpec {
    const source = raw.source ?? (raw.custom_field ? 'custom' : 'native');
    return { source, key: raw.custom_field ?? raw.field ?? raw.key ?? '', op: raw.op, value: raw.value };
  }

  private valueFor(row: ReportRow, column: ColumnSpec): unknown {
    if (column.source === 'custom') return row.customFields?.[column.key] ?? row.itemCustomFields?.[column.key] ?? null;
    return row[column.key] ?? null;
  }

  private matches(row: ReportRow, filter: FilterSpec): boolean {
    const current = this.valueFor(row, filter);
    const wanted = filter.value;
    const left = comparable(current);
    if (filter.op === 'contains') return printable(current).toLocaleLowerCase().includes(printable(wanted).toLocaleLowerCase());
    if (filter.op === 'startsWith') return printable(current).toLocaleLowerCase().startsWith(printable(wanted).toLocaleLowerCase());
    if (filter.op === 'in') return Array.isArray(wanted) && wanted.map(comparable).some((value) => value === left);
    if (filter.op === 'between') {
      if (!Array.isArray(wanted) || wanted.length !== 2) return false;
      return this.compare(left, comparable(wanted[0])) >= 0 && this.compare(left, comparable(wanted[1])) <= 0;
    }
    const right = comparable(wanted);
    switch (filter.op) {
      case 'neq': return left !== right;
      case 'gt': return this.compare(left, right) > 0;
      case 'gte': return this.compare(left, right) >= 0;
      case 'lt': return this.compare(left, right) < 0;
      case 'lte': return this.compare(left, right) <= 0;
      default: return left === right || printable(left) === printable(right);
    }
  }

  private compare(left: string | number | boolean | null, right: string | number | boolean | null): number {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    const a = typeof left === 'number' && typeof right === 'number' ? left : String(left);
    const b = typeof left === 'number' && typeof right === 'number' ? right : String(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private totals(columns: ColumnSpec[], rows: ReportRow[]) {
    const result: Record<string, number> = {};
    for (const column of columns) {
      if (!column.agg) continue;
      const values = rows.map((row) => Number(this.valueFor(row, column))).filter(Number.isFinite);
      if (column.agg === 'count') result[column.key] = rows.length;
      else if (column.agg === 'sum') result[column.key] = values.reduce((sum, value) => sum + value, 0);
      else if (column.agg === 'avg') result[column.key] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      else if (column.agg === 'min') result[column.key] = values.length ? Math.min(...values) : 0;
      else if (column.agg === 'max') result[column.key] = values.length ? Math.max(...values) : 0;
    }
    return result;
  }

  private isNumeric(column: ColumnSpec) {
    return Boolean(column.agg) || ['total', 'subtotal', 'taxTotal', 'paidTotal', 'profit', 'salePrice', 'purchasePrice'].includes(column.key);
  }

  private async validateDefinition(tenantId: string, input: CustomReportInput) {
    const catalog = await this.fieldCatalog(tenantId, input.baseEntity);
    const allowed = new Map(catalog.fields.map((field) => [`${field.source}:${field.key}`, field]));
    for (const raw of input.columns) {
      const column = this.normalizeColumn(raw, input.baseEntity);
      if (!allowed.has(`${column.source}:${column.key}`)) throw this.validation(`Report column is not allowed: ${column.key}`);
    }
    for (const raw of input.filters) {
      const filter = this.normalizeFilter(raw, input.baseEntity);
      if (!allowed.has(`${filter.source}:${filter.key}`)) throw this.validation(`Report filter is not allowed: ${filter.key}`);
      if (filter.source === 'custom') {
        const field = catalog.fields.find((candidate) => candidate.source === 'custom' && candidate.key === filter.key);
        if (!field) throw this.validation(`Custom report field is not allowed: ${filter.key}`);
      }
    }
  }

  private parseInput(raw: unknown): CustomReportInput {
    const value = (raw ?? {}) as Record<string, unknown>;
    const columns = Array.isArray(value.columns) ? value.columns.map((column) => {
      const item = (column ?? {}) as Record<string, unknown>;
      return {
        ...item,
        key: item.key ?? item.field ?? item.custom_field,
        label: item.label ?? item.label_ar,
        source: item.source ?? (item.custom_field ? 'custom' : undefined),
      };
    }) : value.columns;
    const filters = Array.isArray(value.filters) ? value.filters.map((filter) => {
      const item = (filter ?? {}) as Record<string, unknown>;
      return {
        ...item,
        key: item.key ?? item.field ?? item.custom_field,
        source: item.source ?? (item.custom_field ? 'custom' : undefined),
      };
    }) : value.filters;
    const parsed = customReportInputSchema.safeParse({
      ...value,
      baseEntity: value.baseEntity ?? value.base_entity,
      columns,
      filters,
      chartType: value.chartType ?? value.chart_type ?? 'table',
      isPublic: value.isPublic ?? value.is_public ?? false,
    });
    if (!parsed.success) throw this.validation('Invalid custom report definition', parsed.error.issues);
    return parsed.data;
  }

  private async getRaw(tenantId: string, id: string): Promise<CustomReport> {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(customReports).where(and(eq(customReports.tenantId, tenantId), eq(customReports.id, id), isNull(customReports.deletedAt))));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Custom report was not found', 404);
    return row;
  }

  private publicReport(row: CustomReport) {
    return { ...row, chartType: row.chartType, public: row.isPublic };
  }

  private validation(message: string, details?: unknown) {
    return new DomainError(errorCodes.VALIDATION_FAILED, message, 400, details);
  }

  private isUniqueViolation(error: unknown) {
    const seen = new Set<object>();
    let current: unknown = error;
    while (typeof current === 'object' && current !== null && !seen.has(current)) {
      seen.add(current);
      const candidate = current as { code?: unknown; cause?: unknown };
      if (candidate.code === '23505') return true;
      current = candidate.cause;
    }
    return false;
  }

  private csvCell(value: unknown) {
    const text = printable(value).replace(/"/g, '""');
    return `"${text}"`;
  }

  private escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
  }
}
