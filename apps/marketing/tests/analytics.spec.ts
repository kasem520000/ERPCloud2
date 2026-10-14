import { describe, expect, it } from 'vitest';
import { pickContentVariant, siteGoalNames, type PublicContentVariant } from '@erp/contracts';

import {
  allowedToSend,
  ensureVisitorId,
  eventPayload,
  experimentHeadline,
  experimentVariant,
  goalEvent,
  goalFromAttribute,
  newVisitorId,
  pageViewEvent,
  prunePath,
  readVisitorId,
  VISITOR_STORAGE_KEY,
} from '../lib/analytics.js';
import { CONSENT_STORAGE_KEY, consentAllowsEvents, doNotTrackEnabled, readConsentDecision, writeConsentDecision } from '../lib/consent.js';

/**
 * P-M10 — سبيك القياس في المتصفّح. يقيس ما لا يُرى بالعين: هل يُرسل شيءٌ قبل الموافقة؟ هل
 * يحمل الحدث ما لا يجوز؟ هل التوزيع حتميّ؟ وهل المسار يُجرَّد من معاملاته؟
 */

/** تخزينٌ محلّيٌّ وهميّ — القياس بلا متصفّح. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    value: (key: string) => map.get(key) ?? null,
  };
}

const visitorId = '7c9f1a2b-3d4e-4f5a-8b6c-7d8e9f0a1b2c';

describe('P-M10 — الموافقة قبل القياس', () => {
  it('لا يُرسل شيءٌ قبل الموافقة: الغياب ليس موافقة', () => {
    const storage = memoryStorage();
    expect(readConsentDecision(storage)).toBeNull();
    expect(consentAllowsEvents(null)).toBe(false);
    expect(allowedToSend({ storage, navigator: {} })).toBe(false);
  });

  it('والاختيار يُحفظ ويُقرأ، والرفض يمنع الإرسال', () => {
    const storage = memoryStorage();
    writeConsentDecision(storage, 'rejected');
    expect(readConsentDecision(storage)).toBe('rejected');
    expect(allowedToSend({ storage, navigator: {} })).toBe(false);

    writeConsentDecision(storage, 'accepted');
    expect(readConsentDecision(storage)).toBe('accepted');
    expect(allowedToSend({ storage, navigator: {} })).toBe(true);
  });

  it('و`Do Not Track` يُلغي الموافقة ولو نُقر «أوافق»', () => {
    const storage = memoryStorage({ [CONSENT_STORAGE_KEY]: 'accepted' });
    expect(doNotTrackEnabled({ doNotTrack: '1' })).toBe(true);
    expect(doNotTrackEnabled({ doNotTrack: 'yes' })).toBe(true);
    expect(doNotTrackEnabled({ doNotTrack: '0' })).toBe(false);
    expect(allowedToSend({ storage, navigator: { doNotTrack: '1' } })).toBe(false);
  });
});

describe('P-M10 — الحدث المجهول', () => {
  it('المسار يُجرَّد من النطاق والاستعلام والهاش', () => {
    expect(prunePath('https://example.com/pricing?utm_source=x#plans')).toBe('/pricing');
    expect(prunePath('/help/how-to?q=فاتورة')).toBe('/help/how-to');
    expect(prunePath('pricing')).toBe('/pricing');
    expect(prunePath('/a/b/')).toBe('/a/b');
    expect(prunePath('/')).toBe('/');
  });

  it('وحدثُ المشاهدة لا يحمل إلا الاسم والمسار واللغة والمعرّف', () => {
    const event = pageViewEvent({ path: '/pricing?x=1', locale: 'ar', visitor: visitorId });
    expect(Object.keys(event).sort()).toEqual(['locale', 'name', 'path', 'visitor']);
    expect(event.path).toBe('/pricing');
    // ولا أثرَ لعنوان أو بريد — العقد لا يحملهما أصلاً.
    expect(JSON.stringify(event)).not.toContain('@');
  });

  it('و`data-goal` تُقرأ من مفردات العقد وحدها', () => {
    for (const goal of siteGoalNames) expect(goalFromAttribute(goal)).toBe(goal);
    expect(goalFromAttribute('Signup_Start')).toBeNull();
    expect(goalFromAttribute('')).toBeNull();
    expect(goalFromAttribute(null)).toBeNull();
  });

  it('والهدف يحمل وصفاً من المفاتيح المغروفة فقط، بلا قيمٍ فارغة', () => {
    const withMeta = goalEvent({
      name: 'request_demo',
      path: '/demo',
      locale: 'ar',
      visitor: visitorId,
      meta: { source: 'demo', plan: '', experiment: undefined },
    });
    expect(withMeta.meta).toEqual({ source: 'demo' });
    const withoutMeta = goalEvent({ name: 'signup_start', path: '/onboarding', locale: 'ar', visitor: visitorId });
    expect(withoutMeta.meta).toBeUndefined();
  });

  it('والدفعة تُقصّ عند حدّ العقد', () => {
    const many = Array.from({ length: 30 }, () => pageViewEvent({ path: '/', locale: 'ar', visitor: visitorId }));
    expect(eventPayload(many).events.length).toBe(20);
    expect(eventPayload([]).events).toEqual([]);
  });

  it('والمعرّف عشوائيّ يُحفظ مرّةً واحدة ولا يُولَّد بلا تخزين', () => {
    const storage = memoryStorage();
    const first = ensureVisitorId(storage);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureVisitorId(storage)).toBe(first);
    expect(readVisitorId(storage)).toBe(first);
    expect(storage.value(VISITOR_STORAGE_KEY)).toBe(first);
    expect(ensureVisitorId(null)).toBeNull();
    expect(newVisitorId()).not.toBe(newVisitorId());
  });
});

describe('P-M10 — اختبار أ/ب في المتصفّح', () => {
  const variants: PublicContentVariant[] = [
    { key: 'a', slug: 'home-a', titleAr: 'نسخة أ', summaryAr: null, ctaLabelAr: 'ابدأ', ctaHref: '/onboarding' },
    { key: 'b', slug: 'home-b', titleAr: 'نسخة ب', summaryAr: null, ctaLabelAr: null, ctaHref: null },
  ];

  it('الاختيار حتميّ: الزائر نفسه يرى النسخة نفسها في كل زيارة', () => {
    const chosen = experimentVariant({ slug: 'home', variants, visitor: visitorId });
    expect(chosen).not.toBeNull();
    expect(experimentVariant({ slug: 'home', variants, visitor: visitorId })?.key).toBe(chosen?.key);
    // ونفس الدالّة التي يستعملها الخادم في السبيك — توزيعٌ واحد لا اثنان.
    expect(chosen?.key).toBe(pickContentVariant({ slug: 'home', visitor: visitorId, keys: ['a', 'b'] }));
  });

  it('والنسختان تُستعملان فعلاً عبر زوّار مختلفين', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const id = `${String(index).padStart(8, '0')}-2222-4333-8444-555566667777`;
      const chosen = experimentVariant({ slug: 'home', variants, visitor: id });
      if (chosen) seen.add(chosen.key);
    }
    expect([...seen].sort()).toEqual(['a', 'b']);
  });

  it('وبلا نسخٍ منشورة لا تجربة — والأساسية هي الافتراض', () => {
    expect(experimentVariant({ slug: 'home', variants: [], visitor: visitorId })).toBeNull();
    expect(experimentHeadline(null)).toBeNull();
    expect(experimentHeadline(variants[1]!)).toEqual({ title: 'نسخة ب', ctaLabel: null, ctaHref: null });
  });
});
