import { describe, expect, it } from 'vitest';

import { GENESIS_PIH, buildInvoiceXml, type ZatcaInvoiceInput, type ZatcaLine } from '../src/modules/einvoicing/zatca/ubl.js';
import { todayInRiyadh, todayInTimezone } from '../src/modules/hrm/payroll-compliance.js';

/**
 * AUD-17 — دقّة الأموال في مستند ZATCA.
 *
 * الخطر المرصود: تحويل المبالغ النصّية عبر `Number()` ثم `toFixed(2)`. وهو ليس خطرًا
 * نظريًّا عند `2^53` بل يقع عند **حدود التقريب** بأرقام تشغيلية عادية: ضريبة 15% على
 * 100.50 = 15.075، و`Number(15.075).toFixed(2)` في جافاسكربت يعطي `15.07` لأن 15.075
 * عائمًا أقل من النصف بقليل — أي هللة ناقصة في `cbc:TaxAmount` لمستند ضريبي رسمي.
 * وبالمثل `1.0000005` في الكميّات و`2.675` في الخصم.
 *
 * الاستجابة: كل حساب مالي في `ubl.ts` يمرّ بـ`Decimal` مع `ROUND_HALF_UP`، والاختبارات
 * هنا تُثبت قيمة كل حالة حدّية بعينها. وقياس ما قبل الإصلاح (stash): حالتان تفشلان —
 * ضريبة نصف الهللة (`15.075 → 15.07`) وخصم نصف الهللة (`2.675 → 2.67`) — وأربع تمرّ
 * (الكميّة، والشرائح، والعاديّة، وغير الصالحة) فلا تُنسَب إليها قيمة تمييز.
 */

const base: Omit<ZatcaInvoiceInput, 'lines' | 'subtotal' | 'taxTotal' | 'total' | 'invoiceDiscount'> = {
  number: 'SI-2026-0001',
  uuid: '11111111-1111-4111-8111-111111111111',
  issuedAt: new Date('2026-10-11T09:15:30.000Z'),
  kind: 'sale',
  profile: 'simplified',
  currency: 'SAR',
  seller: { nameAr: 'مؤسسة الأفق للتجارة', nameEn: 'Ufuq Trading', vatNo: '310000000000003' },
  counter: 1,
  previousHash: GENESIS_PIH,
  paymentMeansCode: '10',
};

const line = (over: Partial<ZatcaLine> = {}): ZatcaLine => ({
  lineNo: 1,
  name: 'خدمة صيانة',
  unitCode: 'PCE',
  quantity: '1',
  unitPrice: '100.50',
  net: '100.50',
  discount: '0',
  tax: '15.075',
  taxRate: '15',
  ...over,
});

const xml = (input: Partial<ZatcaInvoiceInput> & { lines: ZatcaLine[] }) =>
  buildInvoiceXml({ ...base, subtotal: '0', taxTotal: '0', total: '0', invoiceDiscount: '0', ...input });

const tag = (document: string, name: string) => {
  const match = new RegExp(`<cbc:${name}[^>]*>([^<]*)</cbc:${name}>`).exec(document);
  return match?.[1];
};

const allTags = (document: string, name: string) => [...document.matchAll(new RegExp(`<cbc:${name}[^>]*>([^<]*)</cbc:${name}>`, 'g'))].map((m) => m[1]);

describe('AUD-17 — دقّة التقريب المالي في مستند ZATCA', () => {
  it('ضريبة نصف هللة تُقرَّب إلى الأعلى: 15.075 ⇒ 15.08 لا 15.07', () => {
    // القيمة الحقيقية: 100.50 × 15% = 15.075 (تُخزَّن numeric(18,4) فيكون النص '15.0750').
    for (const tax of ['15.075', '15.0750']) {
      const document = xml({ lines: [line({ tax })], subtotal: '100.50', taxTotal: tax, total: '115.575', invoiceDiscount: '0' });
      expect(tag(document, 'TaxAmount'), tax).toBe('15.08');
      expect(tag(document, 'TaxInclusiveAmount')).toBe('115.58');
      expect(allTags(document, 'TaxAmount')).toContain('15.08');
    }
  });

  it('كميّة بستّ خانات نصفية تُقرَّب إلى الأعلى: 1.0000005 ⇒ 1.000001', () => {
    const document = xml({
      lines: [line({ quantity: '1.0000005' })],
      subtotal: '100.50',
      taxTotal: '15.075',
      total: '115.58',
      invoiceDiscount: '0',
    });
    expect(tag(document, 'InvoicedQuantity')).toBe('1.000001');
  });

  it('خصم نصف هللة على مستوى السطر والمستند: 2.675 ⇒ 2.68 و 1.005 ⇒ 1.01', () => {
    const document = xml({
      lines: [line({ discount: '2.675' })],
      subtotal: '100.50',
      taxTotal: '15.075',
      total: '115.58',
      invoiceDiscount: '1.005',
    });
    expect(allTags(document, 'Amount')).toContain('2.68'); // خصم السطر
    expect(allTags(document, 'Amount')).toContain('1.01'); // خصم المستند
    // TaxExclusiveAmount = 100.50 − 1.005 = 99.495 ⇒ 99.50 بالتقريب النصفي إلى الأعلى.
    expect(tag(document, 'TaxExclusiveAmount')).toBe('99.50');
  });

  it('مجموع الشرائح يجمع عشريًّا لا عائمًا', () => {
    // ثلاث سطور بالضريبة نفسها ⇒ شريحة واحدة: 3 × 15.075 = 45.225 ⇒ 45.23 (العائم يعطي 45.22).
    const document = xml({
      lines: [1, 2, 3].map((lineNo) => line({ lineNo, tax: '15.075' })),
      subtotal: '301.50',
      taxTotal: '45.225',
      total: '346.725',
      invoiceDiscount: '0',
    });
    expect(tag(document, 'TaxableAmount')).toBe('301.50');
    expect(tag(document, 'TaxAmount')).toBe('45.23');
  });

  it('لا انحدار على القيم العادية: الخانتان مكتملتان والقيم الصحيحة تبقى كما هي', () => {
    const document = xml({
      lines: [line({ quantity: '2', net: '100.50', tax: '15.08', unitPrice: '50.25' })],
      subtotal: '100.50',
      taxTotal: '15.08',
      total: '115.58',
      invoiceDiscount: '0',
    });
    expect(tag(document, 'LineExtensionAmount')).toBe('100.50');
    expect(tag(document, 'TaxExclusiveAmount')).toBe('100.50');
    expect(tag(document, 'TaxInclusiveAmount')).toBe('115.58');
    expect(tag(document, 'PayableAmount')).toBe('115.58');
    expect(tag(document, 'InvoicedQuantity')).toBe('2'); // بلا أصفار زائدة، كما كان
    expect(tag(document, 'Percent')).toBe('15.00');
  });

  it('قيمة غير صالحة لا ترمي ولا تُفسد المستند (صفر كما كان)', () => {
    const document = xml({
      lines: [line({ tax: 'abc', net: '' })],
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      invoiceDiscount: 'x',
    });
    expect(tag(document, 'TaxInclusiveAmount')).toBe('0.00');
    expect(tag(document, 'TaxAmount')).toBe('0.00');
  });

  it('AUD-17: تاريخ الأعمال بعد منتصف الليل يعتمد المنطقة الزمنية للمنشأة لا UTC', () => {
    // 2026-10-10T22:30:00Z = 01:30 صباح 2026-10-11 في الرياض (UTC+3)، و 02:30 في دبي (UTC+4).
    const instant = new Date('2026-10-10T22:30:00.000Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-10'); // UTC ما زال أمس
    expect(todayInRiyadh(instant)).toBe('2026-10-11');
    expect(todayInTimezone('Asia/Riyadh', instant)).toBe('2026-10-11');
    expect(todayInTimezone('Asia/Dubai', instant)).toBe('2026-10-11');
    expect(todayInTimezone('America/New_York', instant)).toBe('2026-10-10');
    // منطقة غير صالحة ترتدّ بأمان إلى Asia/Riyadh بدلاً من رمي استثناء:
    expect(todayInTimezone('Invalid/Zone', instant)).toBe('2026-10-11');
  });
});
