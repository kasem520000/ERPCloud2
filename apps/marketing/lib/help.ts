/**
 * P-M9 — منطق مركز المساعدة وحالة الخدمة، **خالصاً بلا شبكة** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5).
 *
 * القاعدة نفسها التي حكمت `lib/verify.ts` في P-M8: ما يمكن أن يُخطئ يُوضع في دالّةٍ خالصةٍ
 * تُقاس بلا خادم — شرائح الفئات، ومنع التصويت مرّتين في المتصفّح نفسه، وتطبيع حالة الخدمة
 * إلى صنف عرض. ومكوّنات الخادم تبقى رسمَ HTML فقط.
 */

import type { Locale } from './i18n';

export const HELP_PATH = '/help';
export const CHANGELOG_PATH = '/changelog';
export const STATUS_PATH = '/status';

/** فئةٌ في مركز المساعدة كما يردّها الغلاف: اسمٌ وعددُ مقالاتٍ منشورة. */
export type HelpCategory = { name: string; count: number };

/**
 * رقاقة فئة: هل هي المختارة الآن؟ وهل هي «الكل»؟
 *
 * و«الكل» ليست فئةً في القاعدة بل رابطاً بلا `category` — اختيارها يعني إسقاط المرشّح،
 * وعدّادها مجموع المقالات لا صفر.
 */
export type HelpCategoryChip = {
  key: string;
  name: string;
  href: string;
  count: number | null;
  active: boolean;
};

/**
 * شرائح الفئات من الغلاف + المختار الحالي.
 *
 * والترتيب: **«الكل» أوّلاً ثم الأكثر مقالاتٍ**، وهو الترتيب نفسه الذي تُعيده القاعدة
 * (`count DESC, category ASC`) فلا يختلف ترتيبٌ بين بيئتين. والبحث يُحفظ في الرابط عند
 * التنقّل بين الفئات: من بحث عن «فاتورة» ثم نقّح «التقارير» لا يفقد بحثه.
 */
export function helpCategoryChips(options: {
  categories: HelpCategory[];
  selected?: string | null;
  query?: string | null;
}): HelpCategoryChip[] {
  const selected = (options.selected ?? '').trim();
  const query = (options.query ?? '').trim();
  const withQuery = (href: string) => (query ? `${href}?q=${encodeURIComponent(query)}` : href);
  // ليس `total`: حارس `no-restricted-syntax` يمنع الأسماء الماليّة في مواضع القيم — والاسم هنا
  // للتجميع لا للمال، لكن القاعدة واحدة على المستودع كله فلا يُستثنى ملفّ.
  const all = options.categories.reduce((sum, category) => sum + category.count, 0);

  return [
    {
      key: '__all__',
      name: 'الكل',
      href: withQuery(HELP_PATH),
      count: all,
      active: selected.length === 0,
    },
    ...options.categories.map((category) => ({
      key: category.name,
      name: category.name,
      href: withQuery(`${HELP_PATH}?category=${encodeURIComponent(category.name)}`),
      count: category.count,
      active: selected === category.name,
    })),
  ];
}

/** مفتاح التصويت في `localStorage`: صوتٌ لكل مقالٍ لا لكل زيارة — فلا يتكرّر العدّد. */
export function helpVoteKey(slug: string): string {
  return `help-vote:${slug}`;
}

/** صوتٌ محفوظٌ في المتصفّح: `true`/`false`، وغير ذلك «لم يصوّت». */
export function storedHelpVote(raw: string | null): boolean | null {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  return null;
}

/** ما يُكتب في المتصفّح بعد تصويتٍ. */
export function helpVoteValue(helpful: boolean): string {
  return helpful ? 'yes' : 'no';
}

/**
 * معرّف المتصفّح العشوائي — **ليس هوية، والغرض منعُ العدّ المزدوج**.
 *
 * ويُولَّد في المتصفّح لا في الخادم: لا نطلب من أحدٍ أن يعرّف عن نفسه ليقول «لم يفدني هذا».
 * و`crypto.randomUUID` في كل متصفّحٍ حديث؛ وإن غاب (بيئةٌ قديمة أو غير آمنة) يُبنى معرّفٌ
 * احتياطيّ من `getRandomValues` — ولا يُمنع الزائر من التصويت لأنّ متصفّحه قديم.
 */
export function newVisitorId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    cryptoRef.getRandomValues(bytes);
  } else {
    // آخر ملاذ: متصفّحٌ قديم بلا `crypto` — نستعمل الزمن والأداء مصدرَ تغايُر، ولا نستعمل
    // `Math.random` لأنه أضعف ولا يُقصَد هنا توليدُ سرّ بل معرّفُ عدّ.
    const seed = `${Date.now()}${Math.round(performance.now() * 1000)}`;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number(seed.slice(index, index + 2)) % 256;
    }
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  // الشكل يبقى UUID v4 — لأن العقد يتحقّق منه، والاستثناء يفتح باباً لم يُطلب.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-a${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
}

/** رسالة نتيجة التصويت كما يقرؤها الزائر — تقول الحقيقة: حُسب الآن أم كان محسوباً. */
export function voteMessageAr(recorded: boolean): string {
  return recorded ? 'شكراً — سُجّل صوتك.' : 'صوتك محسوبٌ من قبل على هذا المتصفّح.';
}

/** جملة العدّادين: لا تُعرَض أصفارٌ فارغة، وتُعرَض النسبة إن وُجدت أصوات. */
export function helpfulSummaryAr(yes: number, no: number): string | null {
  if (yes + no === 0) return null;
  if (no === 0) return `أفاد ${yes} من القارئين.`;
  const percent = Math.round((yes / (yes + no)) * 100);
  return `أفاد ${yes} من ${yes + no} قارئاً (${percent}٪).`;
}

/** صنف عرض حالة الخدمة — من `tone` في العقد إلى صنف الشارات المستعمل في الموقع. */
export function statusToneClass(tone: 'ready' | 'pending' | 'failed' | 'muted'): string {
  if (tone === 'ready') return 'badge ready';
  if (tone === 'pending') return 'badge pending';
  if (tone === 'failed') return 'badge failed';
  return 'badge';
}

/** زمن الاستجابة كما يُعرض: بلا كسورٍ زائدة، وبلا «null» في الشاشة. */
export function latencyLabel(latencyMs: number | null, locale: Locale): string | null {
  if (latencyMs === null || Number.isNaN(latencyMs)) return null;
  const rounded = latencyMs >= 10 ? Math.round(latencyMs) : Math.round(latencyMs * 10) / 10;
  return locale === 'en' ? `${rounded} ms` : `${rounded} مللي ثانية`;
}

/** مدّة التشغيل كما يفهمها العميل: أيامٌ وساعات، لا ثوانٍ طويلة. */
export function uptimeLabel(seconds: number, locale: Locale): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return locale === 'en' ? `${days}d ${hours}h` : `${days} يوم و${hours} ساعة`;
  if (hours > 0) return locale === 'en' ? `${hours}h ${minutes}m` : `${hours} ساعة و${minutes} دقيقة`;
  if (minutes > 0) return locale === 'en' ? `${minutes}m` : `${minutes} دقيقة`;
  return locale === 'en' ? 'less than a minute' : 'أقلّ من دقيقة';
}

/** تاريخ المقال/التحديث كما يُعرض — عشرة أحرفٍ من ISO، و`null` إن لم يوجد. */
export function readableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * تجميع سجلّ التغييرات بحسب الشهر — «أيلول ٢٠٢٦» عنواناً، والمدخلات تحته.
 *
 * والتجميع في الواجهة لا في القاعدة: المدخلات تُكتب بأسمائها، والتاريخ يُعرض كما هو. ولو
 * جمّعناها في SQL لاحتاج كل تغييرٍ في شكل العرض ترحيلاً.
 */
export function changelogByMonth<T extends { publishedAt: string }>(
  entries: T[],
  locale: Locale,
): Array<{ key: string; label: string; entries: T[] }> {
  const formatter = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ar-SA-u-ca-gregory', {
    month: 'long',
    year: 'numeric',
  });
  const groups = new Map<string, { key: string; label: string; entries: T[] }>();
  for (const entry of entries) {
    const date = new Date(entry.publishedAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const group = groups.get(key) ?? { key, label: formatter.format(date), entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => (left.key < right.key ? 1 : -1));
}

/** هل المدخل إصدارٌ (سطر أول يبدأ بـ`v`) — يُوسَم شارةً، ويُترك بلا وسمٍ إن لم يكن. */
export function changelogVersionOf(title: string): string | null {
  const match = /^v?\d+\.\d+(?:\.\d+)?/.exec(title.trim());
  return match ? (match[0].startsWith('v') ? match[0].slice(1) : match[0]) : null;
}
