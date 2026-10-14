/**
 * P-M10 — منطق القياس في المتصفّح، **خالصاً بلا شبكة** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * القاعدة نفسها التي حكمت `lib/verify.ts` و`lib/help.ts`: ما يمكن أن يُخطئ يُوضع في دالّةٍ
 * خالصةٍ تُقاس بلا متصفّح — معرّف الزائر، وتشذيب المسار، وقراءة `data-goal`، واختيار نسخة أ/ب،
 * وبناء الدفعة. والمكوّنات تبقى رسمَ HTML ونقراً.
 *
 * **والقرار الحاكم فيها: أقلّ قدرٍ من البيانات.** كل دالّة هنا تحذف شيئاً: المسار يُجرَّد من
 * معاملاته، والنسخة تُختار محلياً (فلا يُرسل معرّف الزائر ليُختار له)، والحدث يُبنى من مفردات
 * العقد المغلقة.
 */

import {
  SITE_EVENTS_MAX_BATCH,
  pickContentVariant,
  siteEventNames,
  type PublicContentVariant,
  type SiteEvent,
  type SiteEventMetaKey,
  type SiteEventName,
} from '@erp/contracts';

import { consentAllowsEvents, doNotTrackEnabled, readConsentDecision, type StorageLike } from './consent';

/** مفتاح معرّف المتصفّح — عشوائي، ولا يحمل شيئاً عن صاحبه. */
export const VISITOR_STORAGE_KEY = 'erp.visitor.v1';

/** المسار النسبي: الموقع يكلّم نطاقه، و`next.config.mjs` يوصله إلى الـAPI. */
export const SITE_EVENTS_ENDPOINT = '/api/v1/public/events';

/** السمة التي تحمل اسم الهدف على أي رابطٍ أو زرّ — تُقرأ بالتكرار لا بمكوّنٍ لكل زرّ. */
export const GOAL_ATTRIBUTE = 'data-goal';

/**
 * الحدّ الأدنى الذي نحتاجه من `crypto` — بنيويّاً لا بنوع DOM أو Node: الملف يُترجم في
 * المتصفّح (نوع DOM) وفي السبيك (نوع Node)، ونوعٌ أحدهما يُسقط الآخر (وقع فعلاً في tsc الأساس).
 */
export type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => unknown;
};

/**
 * معرّفٌ عشوائي للمتصفّح: `crypto.randomUUID` إن وُجد، وإلا جمعٌ من قيمٍ عشوائية.
 * **ولا `Math.random` وحده**: معرّفٌ متنبَّأ به يمكن تخمينه، فيصير «تمييز الزيارة» أداةً
 * لربط زيارات زائرٍ بعينه — وهو بالضبط ما لا نريده.
 */
export function newVisitorId(cryptoLike: CryptoLike | undefined = globalThis.crypto): string {
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoLike?.getRandomValues) cryptoLike.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readVisitorId(storage: StorageLike | null): string | null {
  const value = storage?.getItem(VISITOR_STORAGE_KEY) ?? null;
  return value && value.length >= 8 ? value : null;
}

/** يقرأ المعرّف أو يولّده ويحفظه — ولا يُنشأ معرّفٌ لمن لم يوافق (يُنشأ عند أوّل حدثٍ مسموح). */
export function ensureVisitorId(storage: StorageLike | null, cryptoLike?: CryptoLike): string | null {
  if (!storage) return null;
  const existing = readVisitorId(storage);
  if (existing) return existing;
  const created = newVisitorId(cryptoLike);
  storage.setItem(VISITOR_STORAGE_KEY, created);
  return created;
}

/** هل يُرسل شيءٌ أصلاً؟ الموافقة وحدها، و`DNT` يُلغيها. */
export function allowedToSend(input: {
  storage: StorageLike | null;
  navigator?: { doNotTrack?: string | null } | null;
}): boolean {
  if (doNotTrackEnabled(input.navigator)) return false;
  return consentAllowsEvents(readConsentDecision(input.storage));
}

/** اسمٌ من مفردات العقد أو لا شيء — فـ`data-goal` في HTML ليس مصدر ثقة. */
export function goalFromAttribute(value: string | null | undefined): SiteEventName | null {
  const name = (value ?? '').trim();
  return (siteEventNames as readonly string[]).includes(name) ? (name as SiteEventName) : null;
}

/**
 * المسار كما يُخزَّن: بلا نطاق ولا استعلام ولا هاش، وبحدّ ٢٠٠ حرف.
 * `?utm_source=…` ليس جزءاً من الصفحة، وحفظُه يعني حفظ نصٍّ حرّ في القاعدة.
 */
export function prunePath(input: string): string {
  const withoutOrigin = input.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const cut = withoutOrigin.split(/[?#]/)[0] ?? '';
  const normalized = cut.startsWith('/') ? cut : `/${cut}`;
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  return (trimmed || '/').slice(0, 200);
}

/** حدثٌ مبنيّ من المرافق: الاسم والمسار واللغة — ولا شيء غيرهما. */
export function pageViewEvent(input: {
  path: string;
  locale: 'ar' | 'en';
  visitor: string;
}): SiteEvent {
  return { name: 'page_view', path: prunePath(input.path), locale: input.locale, visitor: input.visitor };
}

export function goalEvent(input: {
  name: SiteEventName;
  path: string;
  locale: 'ar' | 'en';
  visitor: string;
  meta?: Partial<Record<SiteEventMetaKey, string>>;
}): SiteEvent {
  const event: SiteEvent = {
    name: input.name,
    path: prunePath(input.path),
    locale: input.locale,
    visitor: input.visitor,
  };
  const meta = Object.fromEntries(
    Object.entries(input.meta ?? {}).filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Partial<Record<SiteEventMetaKey, string>>;
  return Object.keys(meta).length > 0 ? { ...event, meta } : event;
}

/** الدفعة: تُقصّ عند حدّ العقد (والجسم مفتاحٌ واحد لا ثاني — العقد صارم). */
export function eventPayload(events: SiteEvent[]): { events: SiteEvent[] } {
  return { events: events.slice(0, SITE_EVENTS_MAX_BATCH) };
}

/**
 * **أ/ب في المتصفّح**: النسخُ كلها تصل من الخادم، والاختيار هنا بمعرّف الزائر ودالّة العقد
 * (`pickContentVariant`) — فلا يُرسل المعرّف ليُختار له، ولا يعرف الخادم من رأى ماذا.
 *
 * والمفاتيح تُرتَّب قبل التوزيع: لو أضاف المشغّل نسخةً ثالثة يوماً لَما تغيّر اختيار من كان
 * ثابتاً على نسخةٍ موجودة إن كانت القائمة نفسها — والترتيب يجعل النتيجة قابلةً للتوقّع.
 */
export function experimentVariant(input: {
  slug: string;
  variants: PublicContentVariant[];
  visitor: string;
}): PublicContentVariant | null {
  if (input.variants.length === 0) return null;
  const ordered = [...input.variants].sort((left, right) => left.key.localeCompare(right.key));
  const key = pickContentVariant({
    slug: input.slug,
    visitor: input.visitor,
    keys: ordered.map((variant) => variant.key),
  });
  return ordered.find((variant) => variant.key === key) ?? null;
}

/** نصّ التجربة للعرض: عنوان النسخة ودعوتها — أو `null` حين لا تجربة. */
export function experimentHeadline(variant: PublicContentVariant | null): {
  title: string;
  ctaLabel: string | null;
  ctaHref: string | null;
} | null {
  if (!variant) return null;
  return { title: variant.titleAr, ctaLabel: variant.ctaLabelAr, ctaHref: variant.ctaHref };
}
