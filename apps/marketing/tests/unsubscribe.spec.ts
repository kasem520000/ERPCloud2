import { describe, expect, it } from 'vitest';

import { unsubscribeCopy, unsubscribeOutcome, wasAlreadyUnsubscribed } from '../lib/unsubscribe';

/**
 * P-M7 — صفحة إلغاء الاشتراك (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * ما يُقاس هنا ما لا يحتاج متصفّحاً: **حالات الصفحة الأربع** ونصوصها. والفرق بين «أُلغي
 * اشتراكك» و«الرابط غير معروف» ليس تجميلاً: من ضغط رابطاً قديماً وظنّ أنه أُلغي سيبقى
 * يتلقّى رسائلنا ويُبلغ عنها بريداً مزعجاً.
 */
describe('marketing unsubscribe page (P-M7)', () => {
  it('بلا رمز: الصفحة تقول أين الرابط، ولا تدّعي إلغاءً', () => {
    const outcome = unsubscribeOutcome({ token: undefined, status: 200 });
    expect(outcome.state).toBe('missing');
    expect(outcome.headingAr).toContain('لا رابط');
    expect(outcome.tone).toBe('muted');
    expect(outcome.email).toBeNull();
  });

  it('رمزٌ غير معروف (404): يُقال صراحةً، ولا يُكشف أي عنوان', () => {
    const outcome = unsubscribeOutcome({ token: 'a'.repeat(32), status: 404 });
    expect(outcome.state).toBe('unknown');
    expect(outcome.tone).toBe('danger');
    expect(outcome.bodyAr).toContain('قديم');
    expect(JSON.stringify(outcome)).not.toContain('@');
  });

  it('نجاح: نصٌّ يؤكّد الحجب عبر المنصّة، ويميّز رسائل الحساب عن التسويق', () => {
    const outcome = unsubscribeOutcome({
      token: 'a'.repeat(32),
      status: 200,
      email: 'someone@example.test',
      message: 'أُلغي اشتراكك، ولن تصلك رسائل تسويقية بعد اليوم.',
    });
    expect(outcome.state).toBe('done');
    expect(outcome.tone).toBe('ok');
    expect(outcome.bodyAr).toContain('قائمة الحجب');
    // ورسائل الحساب تبقى — وهذا ما يسأل عنه من ألغى اشتراكه: «هل سأخسر فاتورتي؟»
    expect(outcome.bodyAr).toContain('فاتورة');
    // والبريد لا يُعرض في الصفحة (قد تُفتح على شاشةٍ ليست لصاحبها).
    expect(outcome.email).toBeNull();
  });

  it('سقوط الشبكة: «تعذّر» لا «أُلغي»', () => {
    const outcome = unsubscribeOutcome({ token: 'a'.repeat(32), status: 0 });
    expect(outcome.state).toBe('unknown');
    expect(outcome.headingAr).toContain('تعذّر');
    expect(outcome.bodyAr).toContain('أعد المحاولة');
  });

  it('«كان ملغى من قبل» تُقرأ من جواب الخادم ولا تُخلط بالنجاح الجديد', () => {
    expect(wasAlreadyUnsubscribed('هذا العنوان مُلغى الاشتراك من قبل — لا شيء يُغيَّر.')).toBe(true);
    expect(wasAlreadyUnsubscribed('أُلغي اشتراكك، ولن تصلك رسائل تسويقية بعد اليوم.')).toBe(false);
    expect(wasAlreadyUnsubscribed(null)).toBe(false);
  });

  it('الصفحة معلَنة غير مفهرسة ومسارها واحد', () => {
    expect(unsubscribeCopy.path).toBe('/unsubscribe');
    expect(unsubscribeCopy.noindex).toBe(true);
    expect(unsubscribeCopy.supportAr.length).toBeGreaterThan(2);
  });
});
