/**
 * Report runner plumbing.
 *
 * The API describes every report (title, filters, columns, which columns get a total),
 * so the admin ships one screen that can render all of them instead of forty near-identical
 * pages. This module holds the wire types, the fetchers and the cell formatting.
 */
import { apiData, apiDelete, apiFetch, apiPatch, apiPost, apiPut } from './api';
import { money, quantity, shortDate } from './lookups';

/** 🔢 الرقم التسلسلي — the free text box of the two serial windows; everything else is a lookup. */
export type ReportParamKind =
  | 'date'
  | 'time'
  | 'branch'
  | 'warehouse'
  | 'party'
  | 'item'
  | 'category'
  | 'salesman'
  | 'costCenter'
  | 'account'
  | 'select'
  | 'serial'
  | 'entryNo'
  | 'docNo'
  | 'cashLocation'
  | 'vesselGroup'
  | 'year';
export type ReportColumnType = 'text' | 'money' | 'qty' | 'int' | 'date' | 'percent';

export type ReportParam = { name: string; labelAr: string; kind: ReportParamKind; options?: Array<{ value: string; labelAr: string }> };
export type ReportColumn = { key: string; labelAr: string; type: ReportColumnType; hidden?: boolean };

export type ReportEntry = {
  key: string;
  titleAr: string;
  group: string;
  hintAr?: string | null;
  params: ReportParam[];
  columns: ReportColumn[];
  totals: string[];
  chart: 'bar' | 'line' | null;
};

export type ReportResult = {
  key: string;
  titleAr: string;
  group: string;
  hintAr: string | null;
  chart: 'bar' | 'line' | null;
  params: Record<string, string>;
  columns: ReportColumn[];
  rows: Array<Record<string, string>>;
  totals: Record<string, string>;
  /** 💰 The summary cards under the grid — the 🔢 · 💵 · 📦 · 💰 cards of the `frmRpt*`. */
  grandTotal: Array<{ key: string; labelAr: string; amount: string }>;
  rowCount: number;
  generatedAt: string;
};

export const REPORT_GROUP_LABELS: Record<string, string> = {
  sales: 'المبيعات',
  purchases: 'المشتريات',
  inventory: 'المستودعات',
  accounting: 'المحاسبة',
  pos: 'نقطة البيع',
  hrm: 'الموظفين والرواتب',
  marina: 'إدارة المراسي',
  projects: 'إدارة المشاريع',
  zatca: 'الفواتير الإلكترونية',
};

export const REPORT_GROUP_ORDER = ['sales', 'purchases', 'inventory', 'accounting', 'pos', 'hrm', 'marina', 'projects', 'zatca'];

export const fetchReportCatalog = () => apiFetch<ReportEntry[]>('/reports');

/**
 * A saved layout (مصمم التقارير) — presentation only. The report's query lives on the
 * server, so a layout can rename, reorder and hide columns and preload filters, and can
 * never change what the numbers mean.
 */
export type ReportLayoutColumn = { key: string; labelAr?: string; visible: boolean };
export type ReportLayout = {
  id: string;
  reportKey: string;
  name: string;
  titleAr: string | null;
  columns: ReportLayoutColumn[];
  filters: Record<string, string>;
  isDefault: boolean;
};

export const fetchReportLayouts = (reportKey?: string) =>
  apiData<ReportLayout[]>(`/reports/layouts${reportKey ? `?report_key=${encodeURIComponent(reportKey)}` : ''}`);

export const saveReportLayout = (input: Partial<ReportLayout> & { reportKey: string; name: string }) =>
  apiPost<ReportLayout>('/reports/layouts', input);

export const updateReportLayout = (id: string, input: Partial<ReportLayout>) => apiPatch<ReportLayout>(`/reports/layouts/${id}`, input);

export const deleteReportLayout = (id: string) => apiData<unknown>(`/reports/layouts/${id}`, { method: 'DELETE' });

/**
 * 🖨️ إعدادات الطباعة — `SettingPrint` of `Desktop_ERP`.
 *
 * `frmSettings.xaml` «خيارات الطباعة» writes one row per scope, and its radios
 * «🧩 تفعيل إعدادات الطباعة» («الإفتراضي» · «مشتريات» · «مبيعات» · «نقطة بيع» · «تأجير» ·
 * «عقود» · «تقارير») are `Inv_Id` 0 · 1 · 2 · 3 · 4 · 5 · 6 (`frmSettings.xaml.cs`
 * L2095-L2116). The cloud names them, and gives each report its own scope under
 * `report:<key>` on top of «تقارير» and «الإفتراضي».
 */
export const PRINT_SCOPES: Array<{ scope: string; labelAr: string }> = [
  { scope: 'default', labelAr: 'الإفتراضي' },
  { scope: 'purchases', labelAr: 'مشتريات' },
  { scope: 'sales', labelAr: 'مبيعات' },
  { scope: 'pos', labelAr: 'نقطة بيع' },
  { scope: 'rental', labelAr: 'تأجير' },
  { scope: 'contracts', labelAr: 'عقود' },
  { scope: 'reports', labelAr: 'تقارير' },
];

export type PrintSettings = {
  scope: string;
  /** 📄 1 «📄 ورقة A4» · 2 «🧾 ورق صغير» — the radios of `frmInvRptType.xaml`. */
  printType: 1 | 2;
  printHeader: boolean;
  printFooter: boolean;
  printStamp: boolean;
  printItemDetails: boolean;
  printItemGroups: boolean;
  printComponentsIndividually: boolean;
  printMakePay: boolean;
  printNo: number;
  printItemType: number;
  casherPrinter: string;
  kitchenPrinter: string;
  rptName: string;
  rptUrl: string;
  note: string;
  headerImageUrl: string;
  footerImageUrl: string;
  stampImageUrl: string;
  /** False when the row is still the desktop's default rather than a saved one. */
  saved: boolean;
};

export const fetchPrintSettings = () => apiData<PrintSettings[]>('/reports/print-settings');

export const savePrintSettings = (scope: string, input: Partial<PrintSettings>) =>
  apiPut<PrintSettings>(`/reports/print-settings/${encodeURIComponent(scope)}`, input);

export const resetPrintSettings = (scope: string) => apiDelete<PrintSettings>(`/reports/print-settings/${encodeURIComponent(scope)}`);

/** 📑 ربط الطابعات بالتقارير — `PrinterSettings` L2163-L2180 (`Inv_Id, PrintName, Printer, RptUrl, RptName`) */
export type PrinterLink = {
  id: string;
  scope: string;
  scopeLabelAr: string;
  printName: string;
  printerName: string;
  rptUrl: string;
  rptName: string;
  createdAt: string;
};

export const fetchPrinterLinks = () => apiData<PrinterLink[]>('/reports/printer-links');
export const createPrinterLink = (input: { scope: string; printName: string; printerName: string; rptUrl?: string; rptName?: string }) =>
  apiPost<PrinterLink>('/reports/printer-links', input);
export const updatePrinterLink = (id: string, input: Partial<{ scope: string; printName: string; printerName: string; rptUrl: string; rptName: string }>) =>
  apiPut<PrinterLink>(`/reports/printer-links/${encodeURIComponent(id)}`, input);
export const deletePrinterLink = (id: string) => apiDelete<unknown>(`/reports/printer-links/${encodeURIComponent(id)}`);

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export type ExportResult = {
  exportId: string;
  status: 'ready';
  format: ExportFormat;
  reportKey: string;
  titleAr: string;
  filename: string;
  mimeType: string;
  encoding: 'utf-8' | 'base64';
  content: string;
  rows: number;
};

/**
 * Exports are produced by the server, not by the browser.
 *
 * The client used to build its own CSV out of the rows already on screen, which quietly
 * dropped anything the table paged away, ignored the saved layout and could never produce a
 * real workbook. Now the report is re-run server-side with the same filters and comes back as
 * a finished file.
 */
export async function exportReport(key: string, filters: Record<string, string>, format: ExportFormat): Promise<ExportResult> {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '')).toString();
  return apiFetch<ExportResult>(`/reports/${encodeURIComponent(key)}/export${query ? `?${query}` : ''}`, { method: 'POST', body: JSON.stringify({ format }) });
}

/** Turns an export payload into a downloaded file without a round trip through the server. */
export function saveExport(result: ExportResult): void {
  const bytes =
    result.encoding === 'base64'
      ? Uint8Array.from(atob(result.content), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(result.content);
  const blob = new Blob([bytes], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Opens the print-ready page in its own window — 👁️ معاينة as it is, and 🖨️ طباعة with the
 * printer dialog raised once the document has settled.
 */
export function openPrintable(html: string, options: { print?: boolean } = {}): boolean {
  const printWindow = window.open('', '_blank', 'width=1100,height=800');
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  if (options.print) {
    printWindow.focus();
    printWindow.setTimeout(() => printWindow.print(), 400);
  }
  return true;
}

export function runReport(key: string, filters: Record<string, string>): Promise<ReportResult> {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '')).toString();
  return apiFetch<ReportResult>(`/reports/${encodeURIComponent(key)}${query ? `?${query}` : ''}`);
}

/** Formats a cell for display; the raw value stays untouched for CSV export. */
export function formatCell(value: string, type: ReportColumnType): string {
  if (value === '' || value === '—') return '—';
  switch (type) {
    case 'money':
      return money(value);
    case 'qty':
      return quantity(value);
    case 'int':
      return Number.isFinite(Number(value)) ? String(Number(value)) : value;
    case 'percent':
      return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : value;
    case 'date':
      return shortDate(value);
    default:
      return value;
  }
}

export function isNumericColumn(column: ReportColumn): boolean {
  return column.type === 'money' || column.type === 'qty' || column.type === 'int' || column.type === 'percent';
}

/** First and last day of the current month — the default window every report opens with. */
export function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const pad = (value: number) => String(value).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { from: `${year}-${pad(month + 1)}-01`, to: `${year}-${pad(month + 1)}-${pad(lastDay)}` };
}

/** Initial filter values for a report: dates prefilled, lookups left as "all". */
export function initialFilters(params: ReportParam[]): Record<string, string> {
  const range = currentMonthRange();
  const filters: Record<string, string> = {};
  for (const param of params) {
    if (param.kind === 'date') filters[param.name] = param.name === 'to' ? range.to : range.from;
    else filters[param.name] = '';
  }
  return filters;
}
