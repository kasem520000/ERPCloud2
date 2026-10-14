import { describe, expect, it } from 'vitest';

import {
  decodeZatcaQrPayload,
  toAmount,
  zatcaQrChecks,
  zatcaQrVerdict,
  type ZatcaQrFields,
} from './zatca-qr.js';

/**
 * P-M8 — فكّ رمز QR الزاتكاوي (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M8).
 *
 * هذا الملف يقيس **الدالّة التي تحكم المتصفّح والخادم معاً**: موقعٌ يقرأ رمزاً «صالحاً» ثم
 * خادمٌ يقول «غير صالح» عيبٌ لا يُقبل في صفحة اسمها «التحقّق». والقيم هنا مبنيةٌ بنفس مُرمِّز
 * الخدمة (`apps/api/src/modules/einvoicing/zatca/qr.ts`): وسمٌ، طولٌ، بايتات — فلا يُختبر
 * الفكّ على شكلٍ متخيَّل.
 */
function encode(fields: Array<[number, string | Buffer]>): string {
  const parts: number[] = [];
  for (const [tag, value] of fields) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    parts.push(tag, bytes.length, ...bytes);
  }
  return Buffer.from(Uint8Array.from(parts)).toString('base64');
}

const SIMPLIFIED = encode([
  [1, 'مؤسسة الأفق للتجارة'],
  [2, '310000000000003'],
  [3, '2026-03-01T10:15:00Z'],
  [4, '172.50'],
  [5, '22.50'],
]);

describe('decodeZatcaQrPayload', () => {
  it('يقرأ الوسوم الخمسة بما فيها الاسم العربي', () => {
    const decoded = decodeZatcaQrPayload(SIMPLIFIED);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.fields.sellerName).toBe('مؤسسة الأفق للتجارة');
    expect(decoded.fields.vatNumber).toBe('310000000000003');
    expect(decoded.fields.timestamp).toBe('2026-03-01T10:15:00Z');
    expect(decoded.fields.total).toBe('172.50');
    expect(decoded.fields.vatTotal).toBe('22.50');
    expect(decoded.fields.signed).toBe(false);
    expect(decoded.tags).toHaveLength(5);
  });

  it('يعلَم الفاتورة مختومةً حين تجتمع البصمة والتوقيع', () => {
    const stamped = encode([
      [1, 'Al Ufuq Trading'],
      [2, '310000000000003'],
      [3, '2026-03-01T10:15:00Z'],
      [4, '172.50'],
      [5, '22.50'],
      [6, Buffer.from('hash-value')],
      [7, Buffer.from([1, 2, 3, 4])],
      [8, Buffer.from([5, 6, 7, 8])],
    ]);
    const decoded = decodeZatcaQrPayload(stamped);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.fields.signed).toBe(true);
    expect(decoded.tags.map((tag) => tag.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('لا يعلَن الختم بوجود البصمة وحدها', () => {
    const half = encode([
      [1, 'Al Ufuq'],
      [2, '310000000000003'],
      [3, '2026-03-01T10:15:00Z'],
      [4, '172.50'],
      [5, '22.50'],
      [6, Buffer.from('hash-only')],
    ]);
    const decoded = decodeZatcaQrPayload(half);
    expect(decoded.ok && decoded.fields.signed).toBe(false);
  });

  it('يقبل صيغة base64url والمسافات والأسطر المكسورة (لصقٌ من قارئ QR)', () => {
    const urlSafe = SIMPLIFIED.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const spaced = `${SIMPLIFIED.slice(0, 20)}\n ${SIMPLIFIED.slice(20)}`;
    for (const variant of [urlSafe, spaced, `"${SIMPLIFIED}"`]) {
      const decoded = decodeZatcaQrPayload(variant);
      expect(decoded.ok, variant.slice(0, 12)).toBe(true);
      if (decoded.ok) expect(decoded.fields.vatNumber).toBe('310000000000003');
    }
  });

  it('يرفض ما ليس رمزاً: النصّ العادي، والحِمل المقطوع، والوسم الشاذّ', () => {
    expect(decodeZatcaQrPayload('')).toMatchObject({ ok: false, problem: 'empty' });
    expect(decodeZatcaQrPayload('hello there, not a qr')).toMatchObject({ ok: false, problem: 'not_base64' });
    expect(decodeZatcaQrPayload('QQ==')).toMatchObject({ ok: false, problem: 'not_base64' });

    const truncated = SIMPLIFIED.slice(0, 12);
    expect(decodeZatcaQrPayload(truncated)).toMatchObject({ ok: false });

    const weirdTag = encode([[10, 'abcdefgh']]);
    expect(decodeZatcaQrPayload(weirdTag)).toMatchObject({ ok: false, problem: 'broken_tlv' });
  });

  it('يرفض حقلاً مطلوباً فارغاً ولو كان الشكل سليماً', () => {
    const noTotal = encode([
      [1, 'مؤسسة الأفق'],
      [2, '310000000000003'],
      [3, '2026-03-01T10:15:00Z'],
      [5, '22.50'],
    ]);
    const decoded = decodeZatcaQrPayload(noTotal);
    expect(decoded).toMatchObject({ ok: false, problem: 'missing_required' });
    if (!decoded.ok) expect(decoded.detailAr).toContain('الإجمالي');
  });

  it('يرفض الحِمل الأطول من الحدّ بلا فكّ', () => {
    const decoded = decodeZatcaQrPayload('A'.repeat(5000));
    expect(decoded).toMatchObject({ ok: false, problem: 'too_long' });
  });
});

describe('zatcaQrChecks', () => {
  const fields = (overrides: Partial<ZatcaQrFields> = {}): ZatcaQrFields => ({
    sellerName: 'مؤسسة الأفق للتجارة',
    vatNumber: '310000000000003',
    timestamp: '2026-03-01T10:15:00Z',
    total: '172.50',
    vatTotal: '22.50',
    signed: false,
    ...overrides,
  });

  const check = (code: string, overrides: Partial<ZatcaQrFields> = {}) =>
    zatcaQrChecks(fields(overrides)).find((item) => item.code === code);

  it('يقبل فاتورة مبسّطة سليمة بلا ختم — الحقول صحيحة والملاحظة تُقال', () => {
    const checks = zatcaQrChecks(fields());
    const verdict = zatcaQrVerdict(checks);
    expect(verdict.valid).toBe(true);
    expect(verdict.notes).toBe(1);
    expect(check('vat_rate')?.ok).toBe(true);
    expect(check('signature')?.ok).toBe(false);
    expect(verdict.failures).toEqual([]);
  });

  it('الرقم الضريبي: ١٥ رقماً كما في قاعدة هذا المستودع', () => {
    expect(check('vat_number')?.ok).toBe(true);
    expect(check('vat_number', { vatNumber: '310000000003' })?.ok).toBe(false);
    expect(check('vat_number', { vatNumber: '31000000000000A' })?.ok).toBe(false);
    const verdict = zatcaQrVerdict(zatcaQrChecks(fields({ vatNumber: '123' })));
    expect(verdict.valid).toBe(false);
    expect(verdict.failures).toContain('vat_number');
  });

  it('التاريخ: يُقرأ تاريخاً فعلياً لا نصّاً', () => {
    expect(check('timestamp')?.ok).toBe(true);
    expect(check('timestamp', { timestamp: '03/01/2026' })?.ok).toBe(false);
    expect(check('timestamp', { timestamp: '2026-03-01 10:15' })?.ok).toBe(false);
    expect(check('timestamp', { timestamp: '2026-03-01T10:15:00+03:00' })?.ok).toBe(true);
  });

  it('الأرقام: الإجمالي لا يقلّ عن الضريبة والنسبة تُحسب', () => {
    expect(check('totals', { total: '10.00', vatTotal: '22.50' })?.ok).toBe(false);
    expect(check('totals', { total: 'abc', vatTotal: '22.50' })?.ok).toBe(false);
    // ضريبةٌ ليست ١٥٪: ملاحظةٌ لا رفض — الفاتورة المعفاة مشروعة.
    const exempt = check('vat_rate', { total: '100.00', vatTotal: '0.00' });
    expect(exempt?.severity).toBe('note');
    expect(exempt?.ok).toBe(false);
    expect(zatcaQrVerdict(zatcaQrChecks(fields({ total: '100.00', vatTotal: '0.00' }))).valid).toBe(true);
  });

  it('يقرأ الأرقام العربية والفاصلة الألفية', () => {
    expect(toAmount('١٧٢.٥٠')).toBe(172.5);
    expect(toAmount('1,172.50')).toBe(1172.5);
    expect(toAmount('١٢٣')).toBe(123);
    expect(toAmount('غير رقم')).toBeNull();
  });
});
