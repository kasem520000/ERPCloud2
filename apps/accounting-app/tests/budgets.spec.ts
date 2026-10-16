import { describe, expect, it } from 'vitest';

import {
  BUDGET_STATUS_LABELS,
  previewDistribution,
  statusLabelOf,
  varianceTone,
} from '../lib/budgets';

/**
 * M6.4 — مساعدات الموازنات الصرفة، تُثبَّت كدوال:
 *   • معاينة التوزيع تحاكي رياض الخادم حرفيًا (قسط متساوٍ HALF_UP بدقة 4، والأخيرة
 *     تحمل الباقي بالضبط) — وإلا وعدَ النموذجُ بأرقامٍ لا يوزّعها الإنشاء؛
 *   • إشارة الانحراف بلغة المحاسب: تحت الموازنة جيدٌ في المصروف، وفوقها جيدٌ في
 *     الإيراد — والبقية صفرية صامتة.
 */
describe('M6.4 — distribution preview mirrors the server math', () => {
  it('divides evenly when the year divides the amount', () => {
    expect(previewDistribution('120000', 12)).toEqual(Array(12).fill('10000.0000'));
    expect(previewDistribution('60000', 12)).toEqual(Array(12).fill('5000.0000'));
  });

  it('telescopes the exact remainder into the last period', () => {
    // 100 ÷ 12 = 8.3333… ⇒ 8.3333 ×11 + 8.3337 = 100 بالضبط.
    const rows = previewDistribution('100', 12);
    expect(rows?.slice(0, 11)).toEqual(Array(11).fill('8.3333'));
    expect(rows?.[11]).toBe('8.3337');
    // ومجموع السطور = السنوي تمامًا.
    const sum = (rows ?? []).reduce((acc, value) => acc + Number(value), 0);
    expect(Math.round(sum * 10_000) / 10_000).toBe(100);
  });

  it('refuses nonsense instead of inventing numbers', () => {
    expect(previewDistribution('0', 12)).toBeNull();
    expect(previewDistribution('-50', 12)).toBeNull();
    expect(previewDistribution('abc', 12)).toBeNull();
    expect(previewDistribution('', 12)).toBeNull();
    expect(previewDistribution('120000', 0)).toBeNull();
    expect(previewDistribution('120000', -3)).toBeNull();
  });
});

describe('M6.4 — variance tone reads the account nature', () => {
  it('calls under-budget spending good for expenses and over-budget revenue good for income', () => {
    // مصروف: إنفاق أقل من الموازنة (انحراف موجب) = جيد؛ أكثر (سالب) = سيئ.
    expect(varianceTone({ accountType: 'expense', variance: '500.0000' })).toBe('good');
    expect(varianceTone({ accountType: 'expense', variance: '-700.0000' })).toBe('bad');
    // إيراد: تحقيق فوق الموازنة (سالب: الفعلي أكبر) = جيد؛ تقصير (موجب) = سيئ.
    expect(varianceTone({ accountType: 'revenue', variance: '-3000.0000' })).toBe('good');
    expect(varianceTone({ accountType: 'revenue', variance: '1000.0000' })).toBe('bad');
    // صفر أو رمز غريب = صامت.
    expect(varianceTone({ accountType: 'expense', variance: '0.0000' })).toBe('flat');
    expect(varianceTone({ accountType: 'revenue', variance: undefined })).toBe('flat');
  });
});

describe('M6.4 — budget status labels', () => {
  it('labels both lifecycle states and falls back to the raw code', () => {
    expect(Object.keys(BUDGET_STATUS_LABELS).sort()).toEqual(['approved', 'draft']);
    expect(statusLabelOf({ id: 'b', name: 'خطة', status: 'draft' })).toBe('مسودة');
    expect(statusLabelOf({ id: 'b', name: 'خطة', status: 'approved' })).toBe('معتمدة');
    expect(statusLabelOf({ id: 'b', name: 'خطة' })).toBe('مسودة');
    expect(statusLabelOf({ id: 'b', name: 'خطة', status: 'weird' })).toBe('weird');
  });
});
