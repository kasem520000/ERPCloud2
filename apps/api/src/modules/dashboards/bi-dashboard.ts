/**
 * لوحة المؤشرات — قواعد بلا قاعدة بيانات.
 *
 * المستخدم يختار من كتالوج ثابت. لا يُمرَّر SQL من الشاشة، والترتيب شبكة من 12 عموداً،
 * والكاش خمس دقائق بمفتاح `dashboard:widget:{id}:data`.
 */

export class DashboardRuleError extends Error {
  constructor(
    readonly code: 'UNKNOWN_WIDGET' | 'RAW_SQL' | 'LAYOUT_MISMATCH' | 'LAYOUT_BOUNDS' | 'LAYOUT_OVERLAP' | 'NO_SPACE',
  ) {
    super(code);
  }
}

export type WidgetKind = 'kpi' | 'chart' | 'table' | 'list';
export type WidgetUnit = 'money' | 'count' | 'text';

export type WidgetCatalogItem = {
  key: string;
  titleAr: string;
  titleEn: string;
  kind: WidgetKind;
  unit: WidgetUnit;
  width: number;
  height: number;
  /** مفتاح تقرير موجود — وصف للمصدر، وليس جملة SQL. */
  source: string;
  comparisonAr?: string;
};

export const GRID_COLUMNS = 12;
export const WIDGET_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_WIDGET_KEYS = ['sales-today', 'overdue-invoices', 'low-stock'] as const;

export const WIDGET_CATALOG: readonly WidgetCatalogItem[] = [
  { key: 'sales-today', titleAr: 'مبيعات اليوم', titleEn: 'Sales today', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'net-sales', comparisonAr: 'مقارنةً بالأمس' },
  { key: 'sales-month', titleAr: 'مبيعات الشهر', titleEn: 'Sales this month', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'net-sales', comparisonAr: 'مقارنةً بالشهر السابق' },
  { key: 'purchases-today', titleAr: 'مشتريات اليوم', titleEn: 'Purchases today', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'purchase-invoices', comparisonAr: 'مقارنةً بالأمس' },
  { key: 'receipts-today', titleAr: 'المقبوضات اليوم', titleEn: 'Receipts today', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'receipt-vouchers', comparisonAr: 'مقارنةً بالأمس' },
  { key: 'payments-today', titleAr: 'المدفوعات اليوم', titleEn: 'Payments today', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'payment-vouchers', comparisonAr: 'مقارنةً بالأمس' },
  { key: 'receivable', titleAr: 'الذمم المدينة', titleEn: 'Receivables', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'customer-balances' },
  { key: 'cash-position', titleAr: 'النقد في الصندوق', titleEn: 'Cash on hand', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'cash-balances' },
  { key: 'expense-month', titleAr: 'مصروف الشهر', titleEn: 'Expenses this month', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'payment-vouchers', comparisonAr: 'مقارنةً بالشهر السابق' },
  { key: 'inventory-value', titleAr: 'قيمة المخزون', titleEn: 'Inventory value', kind: 'kpi', unit: 'money', width: 4, height: 3, source: 'stock-balances' },
  { key: 'new-customers', titleAr: 'عملاء جدد', titleEn: 'New customers', kind: 'kpi', unit: 'count', width: 4, height: 3, source: 'parties', comparisonAr: 'مقارنةً بالشهر السابق' },
  { key: 'attendance-today', titleAr: 'حضور اليوم', titleEn: 'Attendance today', kind: 'kpi', unit: 'count', width: 4, height: 3, source: 'employee-attendance' },
  { key: 'open-quotations', titleAr: 'عروض مفتوحة', titleEn: 'Open quotations', kind: 'kpi', unit: 'count', width: 4, height: 3, source: 'sales-quotations' },
  { key: 'posted-journals', titleAr: 'قيود مرحّلة', titleEn: 'Posted journals', kind: 'kpi', unit: 'count', width: 4, height: 3, source: 'journal-entries', comparisonAr: 'مقارنةً بالشهر السابق' },
  { key: 'sales-week', titleAr: 'مبيعات الأسبوع', titleEn: 'Sales this week', kind: 'chart', unit: 'text', width: 6, height: 4, source: 'net-sales' },
  { key: 'sales-by-branch', titleAr: 'المبيعات حسب الفرع', titleEn: 'Sales by branch', kind: 'chart', unit: 'text', width: 6, height: 4, source: 'net-sales' },
  { key: 'overdue-invoices', titleAr: 'فواتير متأخرة', titleEn: 'Overdue invoices', kind: 'list', unit: 'text', width: 6, height: 4, source: 'sales-invoices' },
  { key: 'unpaid-invoices', titleAr: 'فواتير غير محصّلة', titleEn: 'Unpaid invoices', kind: 'list', unit: 'text', width: 6, height: 4, source: 'sales-invoices' },
  { key: 'low-stock', titleAr: 'نواقص المخزون', titleEn: 'Low stock', kind: 'table', unit: 'text', width: 6, height: 4, source: 'stock-balances' },
  { key: 'top-items', titleAr: 'أكثر الأصناف مبيعاً', titleEn: 'Top items', kind: 'table', unit: 'text', width: 6, height: 4, source: 'sales-by-item' },
  { key: 'near-expiry', titleAr: 'قرب انتهاء الصلاحية', titleEn: 'Near expiry', kind: 'table', unit: 'text', width: 6, height: 4, source: 'item-lots' },
];

export type Cell = { positionX: number; positionY: number; width: number; height: number };

export type WidgetPayload = {
  value?: string;
  previous?: string;
  deltaPercent?: string;
  direction?: 'up' | 'down' | 'flat';
  series?: { label: string; value: string }[];
  columns?: string[];
  rows?: string[][];
};

const SQL_WORD = /\b(select|insert|update|delete|drop|union|alter|truncate)\b/i;

export function catalogByKey(key: string): WidgetCatalogItem | undefined {
  return WIDGET_CATALOG.find((item) => item.key === key);
}

/** الكتالوج فقط. أي مفتاح مجهول أو نص يشبه SQL يُرفض قبل أن يقترب من قاعدة البيانات. */
export function assertWidgetRequest(key: string, config: Record<string, unknown>): WidgetCatalogItem {
  const item = catalogByKey(key);
  if (!item) throw new DashboardRuleError('UNKNOWN_WIDGET');
  const raw = JSON.stringify(config);
  if (SQL_WORD.test(raw) || raw.includes(';') || raw.includes('--') || raw.includes('/*')) {
    throw new DashboardRuleError('RAW_SQL');
  }
  for (const field of Object.keys(config)) {
    if (field !== 'period' && field !== 'limit') throw new DashboardRuleError('RAW_SQL');
  }
  if (config.period !== undefined && config.period !== 'day' && config.period !== 'month') {
    throw new DashboardRuleError('RAW_SQL');
  }
  if (config.limit !== undefined && (typeof config.limit !== 'number' || !Number.isInteger(config.limit) || config.limit < 1 || config.limit > 20)) {
    throw new DashboardRuleError('RAW_SQL');
  }
  return item;
}

export function overlaps(a: Cell, b: Cell): boolean {
  return a.positionX < b.positionX + b.width && b.positionX < a.positionX + a.width && a.positionY < b.positionY + b.height && b.positionY < a.positionY + a.height;
}

export function placeWidget(existing: Cell[], size: Pick<Cell, 'width' | 'height'>): Cell {
  for (let positionY = 0; positionY < 48; positionY += 1) {
    for (let positionX = 0; positionX <= GRID_COLUMNS - size.width; positionX += 1) {
      const cell = { positionX, positionY, width: size.width, height: size.height };
      if (!existing.some((other) => overlaps(cell, other))) return cell;
    }
  }
  throw new DashboardRuleError('NO_SPACE');
}

export function starterWidgets(): Array<Cell & { key: string }> {
  const placed: Cell[] = [];
  return DEFAULT_WIDGET_KEYS.map((key) => {
    const item = catalogByKey(key);
    if (!item) throw new DashboardRuleError('UNKNOWN_WIDGET');
    const cell = placeWidget(placed, item);
    placed.push(cell);
    return { key, ...cell };
  });
}

export function applyLayout(current: { id: string }[], layout: Array<{ widgetId: string } & Cell>): Array<{ id: string } & Cell> {
  if (layout.length !== current.length) throw new DashboardRuleError('LAYOUT_MISMATCH');
  const ids = new Set(current.map((widget) => widget.id));
  const seen = new Set<string>();
  const next: Array<{ id: string } & Cell> = [];
  for (const item of layout) {
    if (!ids.has(item.widgetId) || seen.has(item.widgetId)) throw new DashboardRuleError('UNKNOWN_WIDGET');
    seen.add(item.widgetId);
    const cell = { positionX: item.positionX, positionY: item.positionY, width: item.width, height: item.height };
    const integers = [cell.positionX, cell.positionY, cell.width, cell.height].every((value) => Number.isInteger(value));
    if (!integers || cell.positionX < 0 || cell.positionY < 0 || cell.width < 2 || cell.width > GRID_COLUMNS || cell.height < 2 || cell.height > 8 || cell.positionX + cell.width > GRID_COLUMNS) {
      throw new DashboardRuleError('LAYOUT_BOUNDS');
    }
    if (next.some((other) => overlaps(cell, other))) throw new DashboardRuleError('LAYOUT_OVERLAP');
    next.push({ id: item.widgetId, ...cell });
  }
  return next.sort((a, b) => a.positionY - b.positionY || a.positionX - b.positionX);
}

export function visualOrder(widgets: { id: string; positionX: number; positionY: number }[]): string[] {
  return [...widgets].sort((a, b) => a.positionY - b.positionY || a.positionX - b.positionX).map((widget) => widget.id);
}

export function compareKpi(current: string, previous: string): { deltaPercent: string; direction: 'up' | 'down' | 'flat' } {
  const now = Number(current);
  const then = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) {
    if (!Number.isFinite(now) || now === 0) return { deltaPercent: '0.0', direction: 'flat' };
    return { deltaPercent: '100.0', direction: now > 0 ? 'up' : 'down' };
  }
  const delta = ((now - then) / Math.abs(then)) * 100;
  const direction = Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down';
  return { deltaPercent: delta.toFixed(1), direction };
}

/** لو وُجد أكثر من افتراضي، يبقى الأحدث ويُمسح الباقي. المستخدم الواحد لا يملك إلا لوحة افتراضية واحدة. */
export function keepOneDefault(rows: { id: string; isDefault: boolean; updatedAt: string }[]): { keepId?: string; clearIds: string[] } {
  const marked = rows.filter((row) => row.isDefault).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  if (marked.length === 0) return { clearIds: [] };
  return { keepId: marked[0]?.id, clearIds: marked.slice(1).map((row) => row.id) };
}

export function widgetCacheKey(widgetId: string): string {
  return `dashboard:widget:${widgetId}:data`;
}

export function isCacheFresh(storedAt: number, now: number, ttl = WIDGET_CACHE_TTL_MS): boolean {
  return now - storedAt < ttl;
}

function pdfEscape(value: string): string {
  return value.replace(/[()\\]/g, (char) => `\\${char}`).replace(/[^\x20-\x7E]/g, '?');
}

/** ملف PDF بسيط بالأرقام. الخط المضمّن لا يرسم العربية، فالعناوين في الملف إنجليزية والأرقام كما هي. */
export function dashboardPdf(input: { title: string; lines: string[] }): Buffer {
  const lines = [input.title, ...input.lines].slice(0, 40).map(pdfEscape);
  const commands = lines.map((line, index) => `BT /F1 ${index === 0 ? 16 : 11} Tf 40 ${780 - index * 18} Td (${line}) Tj ET`).join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
    `4 0 obj << /Length ${Buffer.byteLength(commands)} >> stream\n${commands}\nendstream endobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}
