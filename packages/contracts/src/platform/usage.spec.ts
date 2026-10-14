import { describe, expect, it } from 'vitest';

import {
  errorCodes,
  errorStatus,
  platformSettingDefinitions,
  usageMetricKeys,
  usageMetricRegistry,
  usagePercentUsed,
  usagePeriodOf,
  usageSoftThresholdPercent,
  usageStateFor,
} from '../index.js';

/**
 * P-C5 — قيود الفهرس نفسه. لا شيء هنا يمسّ قاعدة بيانات: هذا الملف يقيس الاتساق الذي لو
 * انكسر لما ظهر خطأٌ في الشاشة، بل رقمٌ لا حدَّ له.
 */
describe('usage metric registry (P-C5)', () => {
  it('يقيس ثمانية مقاييس كما في خطة §4', () => {
    expect(usageMetricRegistry).toHaveLength(8);
    expect(usageMetricRegistry.map((metric) => metric.key)).toEqual([...usageMetricKeys]);
  });

  it('لا يتكرّر مفتاح ولا تسمية', () => {
    const keys = new Set(usageMetricRegistry.map((metric) => metric.key));
    const labels = new Set(usageMetricRegistry.map((metric) => metric.labelAr));
    expect(keys.size).toBe(usageMetricRegistry.length);
    expect(labels.size).toBe(usageMetricRegistry.length);
  });

  it('كل مقياس له حدٌّ في فهرس إعدادات المنصة (P-C1)، وافتراضيّه داخل مداه', () => {
    for (const metric of usageMetricRegistry) {
      const definition = platformSettingDefinitions.find((entry) => entry.key === metric.limitKey);
      expect(definition, `${metric.key} → ${metric.limitKey}`).toBeDefined();
      expect(definition?.kind).toBe('integer');
      expect(definition?.scopes).toContain('tenant');
      if (typeof definition?.defaultValue === 'number') {
        expect(definition.defaultValue).toBeGreaterThanOrEqual(definition.min ?? 0);
        if (typeof definition.max === 'number') {
          expect(definition.defaultValue).toBeLessThanOrEqual(definition.max);
        }
      }
    }
  });

  it('النسبة تُحسب بلا انقسام على صفر', () => {
    expect(usagePercentUsed(0, 10)).toBe(0);
    expect(usagePercentUsed(8, 10)).toBe(80);
    expect(usagePercentUsed(10, 10)).toBe(100);
    expect(usagePercentUsed(11, 10)).toBe(110);
    expect(usagePercentUsed(3, null)).toBeNull();
    expect(usagePercentUsed(0, 0)).toBe(0);
    expect(usagePercentUsed(1, 0)).toBe(100);
  });

  it('الحالة من الرقمين: ناعم عند 80٪ وصلب عند 100٪', () => {
    expect(usageSoftThresholdPercent).toBe(80);
    expect(usageStateFor(0, 10)).toBe('ok');
    expect(usageStateFor(7, 10)).toBe('ok');
    expect(usageStateFor(8, 10)).toBe('soft');
    expect(usageStateFor(9, 10)).toBe('soft');
    expect(usageStateFor(10, 10)).toBe('hard');
    expect(usageStateFor(12, 10)).toBe('hard');
    expect(usageStateFor(12, null)).toBe('unlimited');
  });

  it('فترة الشهر بصيغة YYYY-MM', () => {
    expect(usagePeriodOf(new Date('2026-09-17T04:00:00Z'))).toBe('2026-09');
    expect(usagePeriodOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
  });

  it('رمز التجاوز مُعلن وله حالة HTTP', () => {
    expect(errorCodes.USAGE_LIMIT_REACHED).toBe('USAGE_LIMIT_REACHED');
    expect(errorStatus.USAGE_LIMIT_REACHED).toBe(409);
  });
});
