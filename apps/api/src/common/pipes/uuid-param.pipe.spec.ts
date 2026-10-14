import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { DomainError, errorCodes } from '@erp/contracts';

import { UuidParamPipe, isIdentifierParam } from './uuid-param.pipe.js';

/**
 * 🔑 R6 — «معالج UUID عام (500 → 400)»: الحارس الذي يقف بين رابط الطلب وقاعدة البيانات.
 *
 * الوحدة تُختبر هنا بمعزلٍ عن HTTP: ما يهمّ أنه يفحص **معاملات المسار** ذات الأسماء التي
 * تعني معرّف صفّ، ويمرّر ما عداها كما هو، وأن الرفض يحمل اسم المعامل.
 */
const param = (data?: string): ArgumentMetadata => ({ type: 'param', data, metatype: String });

describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe();
  const uuid = '01a0bc0e-3518-777d-b132-397b04651c8a';

  it('يمرّر معرّفاً سليماً كما هو', () => {
    expect(pipe.transform(uuid, param('id'))).toBe(uuid);
    expect(pipe.transform(uuid, param('partyId'))).toBe(uuid);
  });

  it('يرفض معرّفاً معطوباً بـ`INVALID_ID` 400 ويسمّي المعامل', () => {
    for (const name of ['id', 'partyId', 'invoiceId', 'warehouseId', 'sourceId']) {
      let caught: unknown;
      try {
        pipe.transform('not-a-uuid', param(name));
      } catch (error) {
        caught = error;
      }
      expect(caught, name).toBeInstanceOf(DomainError);
      const domain = caught as DomainError;
      expect(domain.code).toBe(errorCodes.INVALID_ID);
      expect(domain.status).toBe(400);
      expect(domain.message).toContain(name);
    }
  });

  it('يرفض الحالات القريبة من الصيغة الصحيحة', () => {
    const almost = [
      '01a0bc0e-3518-777d-b132-397b04651c8', // ناقصٌ حرف
      '01a0bc0e3518777db132397b04651c8a', // بلا شُرَط
      '01a0bc0e-3518-777d-b132-397b04651c8a ', // بمسافة
      'zzzzzzzz-3518-777d-b132-397b04651c8a',
    ];
    for (const value of almost) expect(() => pipe.transform(value, param('id')), value).toThrow();
  });

  it('لا يمسّ ما ليس معرّفاً: المفاتيح والرموز والمعرّفات الخارجية', () => {
    // ليس معامل مسار
    expect(pipe.transform('xyz', { type: 'query', data: 'id', metatype: String })).toBe('xyz');
    expect(pipe.transform('xyz', { type: 'body', data: 'id', metatype: String })).toBe('xyz');
    // أسماء لا تعني معرّف صفّ
    expect(pipe.transform('xyz', param('key'))).toBe('xyz');
    expect(pipe.transform('POS-001', param('code'))).toBe('POS-001');
    expect(pipe.transform('xyz', param(undefined))).toBe('xyz');
    // معرّفات الطرف الآخر (سلة) ليست UUID بطبيعتها
    expect(pipe.transform('778899', param('remoteId'))).toBe('778899');
    expect(pipe.transform('store-9', param('storeId'))).toBe('store-9');
  });

  it('يفحص **كائن المعاملات** كاملاً — ٦١ مساراً تكتب `@Param(idParamSchema)`', () => {
    // `metadata.data` غائب هنا، وكان الحارس يمرّ فيسقط الفحص إلى zod ويردّ
    // `VALIDATION_FAILED` — نفس 400 برمزٍ آخر. صار يسمّي المعامل المعطوب برمز العقد.
    expect(pipe.transform({ id: uuid }, param(undefined))).toEqual({ id: uuid });

    let caught: unknown;
    try {
      pipe.transform({ id: 'not-a-uuid' }, param(undefined));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(errorCodes.INVALID_ID);
    expect((caught as DomainError).status).toBe(400);

    // مسارٌ بمعرّفَين: المعطوب وحده هو ما يوقف الطلب، والاسم يخرج في الحقل.
    let two: unknown;
    try {
      pipe.transform({ id: uuid, contactId: 'nope' }, param(undefined));
    } catch (error) {
      two = error;
    }
    expect((two as DomainError).message).toContain('contactId');

    // وما ليس معرّفاً داخل الكائن يمرّ: المفاتيح والرموز والمعرّفات الخارجية.
    expect(pipe.transform({ currency: 'USD', remoteId: '778899' }, param(undefined))).toEqual({
      currency: 'USD',
      remoteId: '778899',
    });
  });

  it('قائمة الأسماء ذات المعنى معرَّفة صراحةً', () => {
    expect(isIdentifierParam('id')).toBe(true);
    expect(isIdentifierParam('partyId')).toBe(true);
    expect(isIdentifierParam('remoteId')).toBe(false);
    expect(isIdentifierParam('storeId')).toBe(false);
    expect(isIdentifierParam('branch_id')).toBe(false);
  });
});
