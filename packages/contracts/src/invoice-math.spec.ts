import { describe, expect, it } from 'vitest';

import { calculateInvoiceTotals } from './invoice-math.js';

describe('calculateInvoiceTotals', () => {
  it('calculates exclusive VAT and line discounts with decimal precision', () => {
    const result = calculateInvoiceTotals({ lines: [{ quantity: '2.5', unitPrice: '10.00', discountRate: '10', discountAmount: '0', taxRate: '15' }] });
    expect(result.subtotal).toBe('22.5');
    expect(result.tax).toBe('3.375');
    expect(result.total).toBe('25.875');
  });

  it('extracts inclusive VAT without floating point drift', () => {
    const result = calculateInvoiceTotals({ priceIncludesVat: true, lines: [{ quantity: '1', unitPrice: '115', discountRate: '0', discountAmount: '0', taxRate: '15' }] });
    expect(result.tax).toBe('15');
    expect(result.total).toBe('115');
  });

  it('applies document discount, extra tax, and withholding', () => {
    const result = calculateInvoiceTotals({ invoiceDiscount: '5', extraTax: '2', withholding: '3', lines: [{ quantity: '1', unitPrice: '100', discountRate: '0', discountAmount: '0', taxRate: '0' }] });
    expect(result.total).toBe('94');
  });

  it('recomputes VAT after the header discount, pro-rata by gross (desktop InvoiceCalc rule)', () => {
    const result = calculateInvoiceTotals({
      invoiceDiscount: '30',
      lines: [
        { quantity: '1', unitPrice: '200', discountRate: '0', discountAmount: '0', taxRate: '15' },
        { quantity: '1', unitPrice: '100', discountRate: '0', discountAmount: '0', taxRate: '15' },
      ],
    });
    // Gross 300, discount 30 -> shares 20 + 10; VAT follows the discounted bases.
    expect(result.lines[0]?.headerDiscountShare).toBe('20');
    expect(result.lines[1]?.headerDiscountShare).toBe('10');
    expect(result.subtotal).toBe('270');
    expect(result.tax).toBe('40.5');
    expect(result.total).toBe('310.5');
  });

  it('keeps per-line rates when the discount spans mixed VAT rates', () => {
    const result = calculateInvoiceTotals({
      invoiceDiscount: '20',
      lines: [
        { quantity: '1', unitPrice: '100', discountRate: '0', discountAmount: '0', taxRate: '15' },
        { quantity: '1', unitPrice: '100', discountRate: '0', discountAmount: '0', taxRate: '0' },
      ],
    });
    expect(result.lines[0]?.tax).toBe('13.5');
    expect(result.lines[1]?.tax).toBe('0');
    expect(result.total).toBe('193.5');
  });

  it('distributes the discount from the VAT-inclusive base on inclusive prices', () => {
    const result = calculateInvoiceTotals({
      priceIncludesVat: true,
      invoiceDiscount: '23',
      lines: [{ quantity: '1', unitPrice: '230', discountRate: '0', discountAmount: '0', taxRate: '15' }],
    });
    expect(result.subtotal).toBe('180');
    expect(result.tax).toBe('27');
    expect(result.total).toBe('207');
  });

  it('reconciles header totals with the lines so ZATCA buckets match', () => {
    const result = calculateInvoiceTotals({
      invoiceDiscount: '7',
      lines: [
        { quantity: '2', unitPrice: '50', discountRate: '10', discountAmount: '0', taxRate: '15' },
        { quantity: '1', unitPrice: '30', discountRate: '0', discountAmount: '0', taxRate: '15' },
      ],
    });
    const lineNet = result.lines.reduce((sum, line) => sum + Number(line.net), 0);
    const lineTax = result.lines.reduce((sum, line) => sum + Number(line.tax), 0);
    expect(lineNet).toBeCloseTo(Number(result.subtotal), 4);
    expect(lineTax).toBeCloseTo(Number(result.tax), 4);
    expect(Number(result.total)).toBeCloseTo(lineNet + lineTax, 4);
  });

  it('rounds half up at the configured precision', () => {
    const result = calculateInvoiceTotals({ scale: 2, lines: [{ quantity: '1', unitPrice: '1.005', discountRate: '0', discountAmount: '0', taxRate: '0' }] });
    expect(result.subtotal).toBe('1.01');
  });
});
