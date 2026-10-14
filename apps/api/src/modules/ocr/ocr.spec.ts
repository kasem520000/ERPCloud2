import { describe, expect, it } from 'vitest';

import {
  confidenceBand,
  normaliseDate,
  normaliseMoney,
  normaliseOcrPayload,
} from './ocr.utils.js';

describe('purchase-invoice OCR normalisation', () => {
  it('maps Arabic and English header labels into the stable extraction contract', () => {
    const extraction = normaliseOcrPayload({
      المورد: { value: 'شركة صنعاء التجارية', confidence: 0.96 },
      'رقم الفاتورة': { value: ' INV-42 ', confidence: 0.94 },
      'الإجمالي': { value: '١١٥.٠٠ ريال', confidence: 0.93 },
    });

    expect(extraction.supplierName).toBe('شركة صنعاء التجارية');
    expect(extraction.invoiceNumber).toBe('INV-42');
    expect(extraction.total).toBe('115.00');
    expect(extraction.confidenceByField).toMatchObject({ supplierName: 0.96, invoiceNumber: 0.94, total: 0.93 });
  });

  it('only uses the first page of a multi-page PDF', () => {
    const extraction = normaliseOcrPayload({
      pages: [
        { invoiceNumber: 'FIRST', total: '100', text: 'header page' },
        { invoiceNumber: 'SECOND', total: '900', text: 'continuation page' },
      ],
    });

    expect(extraction.invoiceNumber).toBe('FIRST');
    expect(extraction.total).toBe('100');
    expect(extraction.rawText).toBe('header page');
  });

  it('normalises Arabic digits, thousands separators and common invoice dates', () => {
    expect(normaliseMoney('١٬٢٣٤٫٥٠ ريال')).toBe('1234.50');
    expect(normaliseMoney('1,234.50')).toBe('1234.50');
    expect(normaliseDate('٣١/١٢/٢٠٢٥')).toBe('2025-12-31');
    expect(normaliseDate('2025-12-31')).toBe('2025-12-31');
  });

  it('keeps line items available for reviewer mapping without inventing item ids', () => {
    const extraction = normaliseOcrPayload({
      lines: [
        { description: 'كرتون مياه', quantity: '2', unitPrice: '10', taxRate: '15', total: '23', confidence: 0.91 },
        { name: 'خدمة نقل', quantity: '1', amount: '5' },
      ],
    });

    expect(extraction.lines).toEqual([
      { description: 'كرتون مياه', quantity: '2', unitPrice: '10', taxRate: '15', total: '23', confidence: 0.91 },
      { description: 'خدمة نقل', quantity: '1', unitPrice: undefined, taxRate: undefined, total: '5', confidence: undefined },
    ]);
  });

  it('uses the documented green/yellow/red confidence bands', () => {
    expect(confidenceBand(0.901)).toBe('high');
    expect(confidenceBand(0.9)).toBe('medium');
    expect(confidenceBand(0.7)).toBe('medium');
    expect(confidenceBand(0.699)).toBe('low');
    expect(confidenceBand(undefined)).toBe('low');
  });

  it('does not fabricate missing fields and gives an empty extraction zero confidence', () => {
    const extraction = normaliseOcrPayload({ text: 'unreadable document' });

    expect(extraction.supplierName).toBeNull();
    expect(extraction.invoiceNumber).toBeNull();
    expect(extraction.subtotal).toBeNull();
    expect(extraction.lines).toEqual([]);
    expect(extraction.confidence).toBe(0);
    expect(extraction.rawText).toBe('unreadable document');
  });
});
