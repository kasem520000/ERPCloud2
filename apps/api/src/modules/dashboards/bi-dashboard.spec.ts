import { describe, expect, it } from 'vitest';

import {
  WIDGET_CACHE_TTL_MS,
  WIDGET_CATALOG,
  applyLayout,
  assertWidgetRequest,
  catalogByKey,
  compareKpi,
  dashboardPdf,
  isCacheFresh,
  keepOneDefault,
  placeWidget,
  starterWidgets,
  visualOrder,
  widgetCacheKey,
} from './bi-dashboard.js';

describe('BI dashboard widgets', () => {
  it('offers a catalog of 20 widgets and never a SQL string', () => {
    expect(WIDGET_CATALOG).toHaveLength(20);
    expect(new Set(WIDGET_CATALOG.map((item) => item.key)).size).toBe(20);
    expect(JSON.stringify(WIDGET_CATALOG)).not.toMatch(/\bselect\b/i);
    expect(catalogByKey('sales-today')?.kind).toBe('kpi');
  });

  it('places three starter widgets without overlap and keeps a dragged order', () => {
    const starter = starterWidgets();
    expect(starter.map((item) => item.key)).toEqual(['sales-today', 'overdue-invoices', 'low-stock']);
    expect(starter[0]).toMatchObject({ positionX: 0, positionY: 0 });
    const next = placeWidget(starter, { width: 4, height: 3 });
    expect(starter.some((cell) => cell.positionX === next.positionX && cell.positionY === next.positionY)).toBe(false);

    const current = [
      { id: 'a', positionX: 0, positionY: 0, width: 4, height: 3 },
      { id: 'b', positionX: 4, positionY: 0, width: 4, height: 3 },
    ];
    const saved = applyLayout(current, [
      { widgetId: 'a', positionX: 4, positionY: 0, width: 4, height: 3 },
      { widgetId: 'b', positionX: 0, positionY: 0, width: 4, height: 3 },
    ]);
    expect(visualOrder(saved)).toEqual(['b', 'a']);
    expect(saved.find((item) => item.id === 'a')?.positionX).toBe(4);
  });

  it('rejects an unknown widget and any config that looks like SQL', () => {
    expect(() => assertWidgetRequest('drop-table', {})).toThrow('UNKNOWN_WIDGET');
    expect(() => assertWidgetRequest('sales-today', { query: 'select * from sales_invoices' })).toThrow('RAW_SQL');
    expect(assertWidgetRequest('sales-today', {}).key).toBe('sales-today');
  });

  it('computes a KPI comparison against the previous period', () => {
    expect(compareKpi('150', '100')).toEqual({ deltaPercent: '50.0', direction: 'up' });
    expect(compareKpi('80', '100').direction).toBe('down');
    expect(compareKpi('0', '0')).toEqual({ deltaPercent: '0.0', direction: 'flat' });
  });

  it('keeps a single default dashboard per user', () => {
    const result = keepOneDefault([
      { id: 'old', isDefault: true, updatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'new', isDefault: true, updatedAt: '2026-09-29T00:00:00.000Z' },
      { id: 'other', isDefault: false, updatedAt: '2026-09-28T00:00:00.000Z' },
    ]);
    expect(result).toEqual({ keepId: 'new', clearIds: ['old'] });
    expect(keepOneDefault([{ id: 'only', isDefault: false, updatedAt: '2026-09-29T00:00:00.000Z' }])).toEqual({ clearIds: [] });
  });

  it('caches a widget for five minutes under the dashboard key', () => {
    const key = widgetCacheKey('widget-1');
    expect(key).toBe('dashboard:widget:widget-1:data');
    expect(WIDGET_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    const storedAt = Date.parse('2026-09-29T10:00:00.000Z');
    expect(isCacheFresh(storedAt, storedAt + 4 * 60 * 1000)).toBe(true);
    expect(isCacheFresh(storedAt, storedAt + WIDGET_CACHE_TTL_MS)).toBe(false);
  });

  it('exports a PDF that starts with the PDF header and includes the figure', () => {
    const bytes = dashboardPdf({ title: 'ERP Cloud dashboard', lines: ['Sales today: 1250.00'] });
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString('latin1')).toContain('1250.00');
  });

  it('refuses a layout that names a widget the board does not have', () => {
    expect(() =>
      applyLayout([{ id: 'a' }], [{ widgetId: 'missing', positionX: 0, positionY: 0, width: 4, height: 3 }]),
    ).toThrow('UNKNOWN_WIDGET');
  });
});
