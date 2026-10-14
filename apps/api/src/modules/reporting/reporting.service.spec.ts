import { describe, expect, it } from 'vitest';

import { escapeHtml } from './print-templates.service.js';
import { REPORT_DEFINITIONS, reportByKey } from './report-catalog.js';
import { REPORT_KEYS, ReportingService, parseFilters, sumColumns, toCsv } from './reporting.service.js';

/** The catalogue and the print helpers never touch the database, so neither does this. */
const makeService = () => new ReportingService(undefined as never, undefined as never);

describe('reporting catalog', () => {
  it('keeps the long-lived report keys registered', () => {
    expect(REPORT_KEYS).toContain('sales-by-day');
    expect(REPORT_KEYS).toContain('inventory-valuation');
    expect(REPORT_KEYS).toContain('cashier-shift');
    expect(REPORT_KEYS.length).toBeGreaterThanOrEqual(20);
  });

  it('registers the detailed analysis reports the desktop menus expose', () => {
    for (const key of ['sales-detail', 'item-profit', 'invoice-profit', 'inventory-turnover', 'net-sales', 'net-purchases', 'purchases-detail', 'supplier-balances', 'customer-balances', 'vat-return']) {
      expect(REPORT_KEYS, key).toContain(key);
    }
  });

  it('describes every report well enough for a generic screen to render it', () => {
    for (const definition of REPORT_DEFINITIONS) {
      expect(definition.titleAr.length, definition.key).toBeGreaterThan(2);
      expect(definition.columns.length, definition.key).toBeGreaterThan(0);
      const columnKeys = new Set(definition.columns.map((column) => column.key));
      for (const totalKey of definition.totals ?? []) expect(columnKeys.has(totalKey), `${definition.key}.${totalKey}`).toBe(true);
    }
  });

  it('has unique keys', () => {
    expect(new Set(REPORT_KEYS).size).toBe(REPORT_KEYS.length);
    expect(reportByKey.size).toBe(REPORT_KEYS.length);
  });

  it('builds parameterised SQL without interpolating raw filter text', () => {
    const definition = reportByKey.get('sales-invoices');
    const query = definition!.build('11111111-1111-1111-1111-111111111111', { from: '2026-01-01', branchId: '22222222-2222-2222-2222-222222222222' });
    expect(query.queryChunks.length).toBeGreaterThan(1);
  });
});

describe('report filters', () => {
  it('drops blanks and unknown params', () => {
    expect(parseFilters({ from: ' 2026-01-01 ', to: '', nonsense: 'x' })).toEqual({ from: '2026-01-01' });
  });

  it('rejects malformed dates and ids', () => {
    expect(() => parseFilters({ from: '01/01/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => parseFilters({ branchId: 'not-a-uuid' })).toThrow();
  });
});

describe('report output helpers', () => {
  it('totals only the requested numeric columns', () => {
    const rows = [{ total: '10.50', label: 'a' }, { total: '4.50', label: 'b' }, { total: '', label: 'c' }];
    expect(sumColumns(rows, ['total'])).toEqual({ total: '15.00' });
  });

  it('writes a BOM-prefixed csv with Arabic headers and quoted values', () => {
    const csv = toCsv([{ key: 'party', labelAr: 'العميل', type: 'text' }, { key: 'total', labelAr: 'الإجمالي', type: 'money' }], [{ party: 'شركة, المدى', total: '10' }]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"شركة, المدى"');
    expect(csv.split('\n')).toHaveLength(2);
  });

  it('escapes every value that reaches a printed document', () => {
    // Printed documents interpolate names, references and descriptions straight into the
    // markup, so the escape has to cover quotes as well as angle brackets — an item named
    // `" onload="…` would otherwise become an attribute.
    expect(escapeHtml('<x>')).toBe('&lt;x&gt;');
    expect(escapeHtml('شركة "المدى" & شركاه')).toBe('شركة &quot;المدى&quot; &amp; شركاه');
    expect(escapeHtml("O'Brien")).toBe('O&#39;Brien');
  });

  it('publishes a catalog entry per definition', () => {
    const catalog = makeService().catalog();
    expect(catalog).toHaveLength(REPORT_DEFINITIONS.length);
    expect(catalog[0]).toHaveProperty('columns');
    expect(catalog[0]).toHaveProperty('params');
  });
});
