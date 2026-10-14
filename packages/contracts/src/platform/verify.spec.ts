import { describe, expect, it } from 'vitest';

import { decodeZatcaQrPayload } from '../zatca-qr.js';

import {
  PUBLIC_VERIFY_SAMPLE_PAYLOAD,
  publicVerifyInputSchema,
  publicVerifyStatusOf,
  publicVerifyStatuses,
  publicVerifyStatusLabels,
} from './verify.js';

/**
 * P-M8 — عقد التحقّق العام (`docs/roadmap/MARKETING_SITE_PLAN.md` §5 P-M8).
 *
 * يقيس ثلاثة قرارات: **مدخلٌ واحد لا اثنان** (حِملٌ أو رمز)، و**حالةٌ مغلقة** (كل حالةٍ تعود
 * من القاعدة لها تسميةٌ وشرحٌ في العقد، فلا تظهر حالةٌ بلا كلام في الصفحة)، و**حِملُ المثال**
 * صالحٌ فعلاً — لأن مثالاً في الصفحة لا يُقرأ عيبٌ في أول استخدام.
 */
describe('publicVerifyInputSchema', () => {
  it('يقبل حِمل الرمز وحده أو رمز الفاتورة وحده', () => {
    expect(publicVerifyInputSchema.safeParse({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD }).success).toBe(true);
    expect(publicVerifyInputSchema.safeParse({ uuid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }).success).toBe(true);
  });

  it('يرفض الاثنين معاً، ويرفض الفراغ، ويرفض المفتاح الغريب', () => {
    const both = publicVerifyInputSchema.safeParse({
      payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD,
      uuid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    });
    expect(both.success).toBe(false);
    expect(publicVerifyInputSchema.safeParse({}).success).toBe(false);
    expect(publicVerifyInputSchema.safeParse({ payload: '   ' }).success).toBe(false);
    expect(publicVerifyInputSchema.safeParse({ payload: PUBLIC_VERIFY_SAMPLE_PAYLOAD, extra: 1 }).success).toBe(false);
    expect(publicVerifyInputSchema.safeParse({ uuid: 'ليس-رمزاً' }).success).toBe(false);
  });
});

describe('publicVerifyStatusOf', () => {
  it('يوحّد نصّ `zatca_status` الحرّ إلى حالاتٍ محدودة', () => {
    expect(publicVerifyStatusOf('cleared')).toBe('cleared');
    expect(publicVerifyStatusOf('REPORTED')).toBe('reported');
    expect(publicVerifyStatusOf('voided:سبب الإلغاء')).toBe('voided');
    expect(publicVerifyStatusOf(null)).toBe('unknown');
    expect(publicVerifyStatusOf('something-new')).toBe('unknown');
  });

  it('لكل حالةٍ تسميةٌ وشرحٌ بلغتين — لا حالة بلا كلام', () => {
    for (const status of publicVerifyStatuses) {
      const label = publicVerifyStatusLabels[status];
      expect(label.labelAr.length, status).toBeGreaterThan(2);
      expect(label.labelEn.length, status).toBeGreaterThan(2);
      expect(label.explanationAr.length, status).toBeGreaterThan(10);
      expect(label.explanationEn.length, status).toBeGreaterThan(10);
    }
  });
});

describe('PUBLIC_VERIFY_SAMPLE_PAYLOAD', () => {
  it('يُقرأ كرمز زاتكا كامل الحقول — مثالُ الصفحة لا يكون مكسوراً', () => {
    const decoded = decodeZatcaQrPayload(PUBLIC_VERIFY_SAMPLE_PAYLOAD);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.fields.vatNumber).toBe('310000000000003');
    expect(decoded.fields.total).toBe('172.50');
    // ١٧٢٫٥٠ شامل ٢٢٫٥٠ ⇒ الوعاء ١٥٠ والنسبة ١٥٪ تماماً.
    expect(Number(decoded.fields.total) - Number(decoded.fields.vatTotal)).toBe(150);
  });
});
