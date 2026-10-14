import { z } from 'zod';

import { uuidSchema } from '../ids.js';
import { paginationQuerySchema, type ListMeta } from '../pagination.js';

/**
 * P-M5 — «نظام إدارة المحتوى» (`docs/roadmap/MARKETING_SITE_PLAN.md` §6).
 *
 * الموقع التسويقي **لا مقابل له في `Desktop_ERP`**، فبوابة «المصدر بالسطر» تُستبدل هنا
 * بمواصفاتٍ منشورة: بنية Open Graph و`hreflang` وJSON-LD، وسياسة كتلٍ لا HTML حرّاً. وهذا
 * الملف يقفل ثلاث قواعد كانت ستُخترع في الواجهة لو لم تُقفل هنا:
 *
 *   1. **الكتل تُقاس بنوعها**: لكل نوع (`heading` · `cards` · `faq` …) حمولةٌ لها مخططها،
 *      ويُتحقَّق كل لسان على حدة. فلوحةٌ تكتب كتلة `table` بلا أعمدة تُرفض عند الحفظ لا عند
 *      العرض — أي على شاشة المشغّل حيث يمكن تصحيحها.
 *   2. **الرابط العام يُشتقّ من النوع**: `post` → `/blog/<slug>`، `help` → `/help/<slug>`،
 *      وغيرها → `/<slug>`. والدالّة `contentPathOf` تسكن هنا ليستعملها الخادم والموقع
 *      وخريطة الموقع معاً، فلا تختلف ثلاثتها في رابط.
 *   3. **اللغتان في صفٍّ واحد** (`titleAr`/`titleEn`) مع `defaultLocale`: صفحةٌ بصفّين تعني
 *      ترجمةً تنفصل عن أصلها فتصير نسخةً ثانية تُنسى.
 */

// ─────────────────────────────────────────────────────────────────────────────
// المفردات المغلقة
// ─────────────────────────────────────────────────────────────────────────────

/** أنواع المحتوى — ولكلٍّ مساره العام كما في §4 من الخطة. */
// P-M9: `changelog` نوعٌ سابع — «ما تغيّر في المنصّة» مستندٌ إلى العملاء، ومسارُه `/changelog/<slug>`.
export const contentKinds = ['page', 'post', 'case_study', 'faq', 'help', 'legal', 'changelog'] as const;
export type ContentKind = (typeof contentKinds)[number];

export const contentStatuses = ['draft', 'scheduled', 'published'] as const;
export type ContentStatus = (typeof contentStatuses)[number];

export const contentLocales = ['ar', 'en'] as const;
export type ContentLocale = (typeof contentLocales)[number];

export const contentBlockKinds = [
  'heading',
  'text',
  'list',
  'cards',
  'table',
  'faq',
  'quote',
  'image',
  'video',
  'code',
  'cta',
] as const;
export type ContentBlockKind = (typeof contentBlockKinds)[number];

/** مواضع القوائم — و`social` قائمةٌ كغيرها: عنصرٌ بمفتاحٍ ورابطٍ وتسميتين. */
export const contentMenuPositions = ['header', 'footer', 'sidebar', 'legal', 'social'] as const;
export type ContentMenuPosition = (typeof contentMenuPositions)[number];

export const contentBannerTones = ['info', 'ok', 'warn', 'danger'] as const;
export type ContentBannerTone = (typeof contentBannerTones)[number];

export const contentBannerAudiences = ['all', 'visitors'] as const;
export type ContentBannerAudience = (typeof contentBannerAudiences)[number];

/**
 * الرابط العام لصفحة. **دالّة واحدة** يستعملها: خريطة الموقع، وروابط المدوّنة، و`canonical`.
 * لو كُتبت في كل مكان لاختلف رابطٌ واحد فصار لدينا صفحتان لعنوانٍ واحد في نظر محرّك البحث.
 */
export function contentPathOf(kind: ContentKind, slug: string): string {
  if (kind === 'post') return `/blog/${slug}`;
  if (kind === 'help') return `/help/${slug}`;
  if (kind === 'changelog') return `/changelog/${slug}`;
  if (kind === 'case_study') return `/cases/${slug}`;
  if (kind === 'legal') return `/legal/${slug}`;
  return `/${slug}`;
}

/** الـslug: حروف لاتينية صغيرة وأرقام وشرطات — رابطٌ عربي معرَّب أنظف من نصٍّ مُرمَّز. */
export const contentSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'الرابط يقبل حروفاً لاتينية صغيرة وأرقاماً وشرطات فقط');

// ─────────────────────────────────────────────────────────────────────────────
// حمولات الكتل — لكل نوعٍ مخططه
// ─────────────────────────────────────────────────────────────────────────────

const textOf = (min: number, max: number) => z.string().trim().min(min).max(max);
const hrefSchema = z
  .string()
  .trim()
  .max(300)
  .refine(
    (value) => value.startsWith('/') || /^https:\/\/[^\s]+$/i.test(value) || value.startsWith('mailto:') || value.startsWith('tel:'),
    { message: 'الرابط يبدأ بـ/ أو https:// أو mailto: أو tel:' },
  );

export const contentBlockPayloadSchemas = {
  heading: z.object({ text: textOf(2, 200), level: z.union([z.literal(2), z.literal(3)]).default(2) }),
  text: z.object({ text: textOf(2, 6000) }),
  list: z.object({ items: z.array(textOf(1, 300)).min(1).max(20), ordered: z.boolean().default(false) }),
  cards: z.object({
    items: z
      .array(
        z.object({
          icon: textOf(1, 8).optional(),
          title: textOf(2, 120),
          body: textOf(2, 600),
          href: hrefSchema.optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
  table: z.object({
    caption: textOf(2, 200).optional(),
    columns: z.array(textOf(1, 60)).min(1).max(8),
    rows: z.array(z.array(textOf(0, 300)).min(1).max(8)).max(40),
  }),
  faq: z.object({ items: z.array(z.object({ question: textOf(3, 300), answer: textOf(3, 2000) })).min(1).max(20) }),
  quote: z.object({ text: textOf(3, 800), source: textOf(2, 120).optional(), role: textOf(2, 120).optional() }),
  image: z.object({
    url: z.string().trim().min(1).max(500),
    alt: textOf(2, 200),
    caption: textOf(2, 300).optional(),
    width: z.number().int().min(16).max(4000).optional(),
    height: z.number().int().min(16).max(4000).optional(),
  }),
  video: z.object({ url: z.string().trim().min(1).max(500), title: textOf(2, 200).optional() }),
  code: z.object({ language: textOf(1, 30), code: textOf(1, 6000) }),
  cta: z.object({
    title: textOf(2, 200),
    body: textOf(2, 600).optional(),
    primaryLabel: textOf(2, 60),
    primaryHref: hrefSchema,
    secondaryLabel: textOf(2, 60).optional(),
    secondaryHref: hrefSchema.optional(),
  }),
} as const satisfies Record<ContentBlockKind, z.ZodTypeAny>;

export type ContentBlockPayload<K extends ContentBlockKind = ContentBlockKind> = z.infer<
  (typeof contentBlockPayloadSchemas)[K]
>;

/** حمولة كتلةٍ بلغتين — والثانية قد تغيب (لا كل صفحةٍ تُترجم فور نشرها). */
export const contentBlockContentSchema = z.object({
  ar: z.unknown(),
  en: z.unknown().nullable().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// كتلة عند الكتابة — النوع يقرّر الحمولة
// ─────────────────────────────────────────────────────────────────────────────

export const contentBlockInputSchema = z
  .object({
    position: z.number().int().min(0).max(500),
    kind: z.enum(contentBlockKinds),
    content: contentBlockContentSchema,
  })
  .superRefine((block, ctx) => {
    const payload = contentBlockPayloadSchemas[block.kind];
    const arabic = payload.safeParse(block.content.ar);
    if (!arabic.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', 'ar'],
        message: `حمولة الكتلة «${block.kind}» غير صحيحة بالعربية: ${arabic.error.issues[0]?.message ?? ''}`,
      });
    }
    if (block.content.en !== undefined && block.content.en !== null) {
      const english = payload.safeParse(block.content.en);
      if (!english.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['content', 'en'],
          message: `حمولة الكتلة «${block.kind}» غير صحيحة بالإنجليزية: ${english.error.issues[0]?.message ?? ''}`,
        });
      }
    }
  });
export type ContentBlockInput = z.infer<typeof contentBlockInputSchema>;

/** كتلةٌ كما تُقرأ — حمولتها مُتحقَّق منها عند الحفظ، فتُعاد كما هي. */
export const contentBlockSchema = z.object({
  id: uuidSchema,
  position: z.number().int(),
  kind: z.enum(contentBlockKinds),
  content: z.object({ ar: z.unknown(), en: z.unknown().nullable() }),
});
export type ContentBlock = z.infer<typeof contentBlockSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// الصفحة
// ─────────────────────────────────────────────────────────────────────────────

export const contentSeoSchema = z.object({
  titleAr: z.string().trim().max(70).nullable(),
  titleEn: z.string().trim().max(70).nullable(),
  descriptionAr: z.string().trim().max(180).nullable(),
  descriptionEn: z.string().trim().max(180).nullable(),
  /** صورة المشاركة — من وحدة `files` القائمة (لا رفع جديد في هذا الجزء). */
  ogImageUrl: z.string().trim().max(500).nullable(),
});
export type ContentSeo = z.infer<typeof contentSeoSchema>;

/**
 * P-M10 — **اختبار أ/ب من نظام المحتوى** (`docs/roadmap/MARKETING_SITE_PLAN.md` §5): نسختان
 * لنفس الصفحة، والمتصفّح يختار واحدة بمعرّفه العشوائي.
 *
 * وثلاثة قرارات في هذه القطعة الصغيرة:
 *
 *   1. **النسخة صفحةٌ كاملة لا حقل** (`variant_of` + `variant_key` في P-M10): لها عنوانها
 *      وملخّصها وكتلها — أي أن «الدعوة» تُكتب في كتلة `cta` داخل النسخة، فلا يحتاج التسويق
 *      مطوّراً ليغيّر جملة.
 *   2. **التوزيع في المتصفّح** (`pickContentVariant`): الخادم يعيد النسخ كلها والمتصفّح يختار
 *      بـ`slug + معرّف الزائر` — فلا يُرسل معرّف الزائر في رابطٍ ليُختار له، ولا يعرف الخادم
 *      أصلاً من رأى ماذا (وهو ما يقيسه السبيك). والثمن أن الصفحة تُرسم بالنسخة الأساسية ثم
 *      تُستبدل — مقبولٌ لأن النصّ بديلُه في الصفحة نفسها، و`noindex` لمشكلة الزحف غير قائمة:
 *      الزاحف لا معرّف له فيرى الأساسية دائماً.
 *   3. **دالّة توزيعٍ واحدة في العقد**: المتصفّح والسبيك واللوحة يستعملونها نفسها، فلا يوزّع
 *      أحدهم بالتساوي والآخر بالباقي ثم تختلف النسب بين ما يُقاس وما يُعرض.
 */
export const contentVariantKeys = ['a', 'b'] as const;
export type ContentVariantKey = (typeof contentVariantKeys)[number];

/** نسخةٌ كما تُرسل إلى المتصفّح: ما يلزم للعرض وحده (بلا كتل: الأساسية تُرسم بكتلها). */
export const publicContentVariantSchema = z.object({
  key: z.enum(contentVariantKeys),
  slug: contentSlugSchema,
  titleAr: z.string(),
  summaryAr: z.string().nullable(),
  /** «الدعوة» — من كتلة `cta` في النسخة، وهي التي يقيسها الهدف `signup_start`. */
  ctaLabelAr: z.string().nullable(),
  ctaHref: z.string().nullable(),
});
export type PublicContentVariant = z.infer<typeof publicContentVariantSchema>;

/**
 * اختيارٌ حتميّ: نفس الزائر على نفس الصفحة يحصل على نفس النسخة دائماً (٠ أو ١ أو …)،
 * والتوزيع يقارب التساوي لأن FNV-1a تنثر الحروف. وبلا معرّف ⇒ لا نسخة (الأساسية).
 */
export function pickContentVariant(input: {
  slug: string;
  visitor: string;
  keys?: readonly string[];
}): string | null {
  const keys = input.keys ?? contentVariantKeys;
  if (keys.length === 0 || input.visitor.length === 0) return null;
  let hash = 0x811c9dc5;
  const seed = `${input.slug}:${input.visitor}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return keys[hash % keys.length] ?? null;
}

export const contentPageSchema = z.object({
  id: uuidSchema,
  slug: contentSlugSchema,
  kind: z.enum(contentKinds),
  status: z.enum(contentStatuses),
  titleAr: z.string(),
  titleEn: z.string().nullable(),
  summaryAr: z.string().nullable(),
  summaryEn: z.string().nullable(),
  defaultLocale: z.enum(contentLocales),
  publishAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  seo: contentSeoSchema,
  category: z.string().nullable(),
  authorName: z.string().nullable(),
  /** ما تُرجم فعلاً — الشاشة تقول «العربية فقط» بلا تخمين. */
  translatedLocales: z.array(z.enum(contentLocales)),
  path: z.string(),
  /** P-M10: الصفحة الأم التي هذه نسخةٌ منها (`null` للأصل). */
  variantOf: uuidSchema.nullable(),
  /** `a` أو `b` للنسخة، و`null` للأصل. */
  variantKey: z.enum(contentVariantKeys).nullable(),
  blockCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type ContentPage = z.infer<typeof contentPageSchema>;

/** صفحةٌ بكتلها — ما يُعاد من `GET /public/content/:slug` ومن محرّر اللوحة. */
export const contentPageDetailSchema = contentPageSchema.extend({
  blocks: z.array(contentBlockSchema),
  /** P-M10: النسخ المنشورة لهذه الصفحة (فارغة إن لم تكن تجربةً). */
  variants: z.array(publicContentVariantSchema),
});
export type ContentPageDetail = z.infer<typeof contentPageDetailSchema>;

// ── الكتابة

export const contentPageCreateSchema = z.object({
  slug: contentSlugSchema,
  kind: z.enum(contentKinds).default('page'),
  titleAr: textOf(2, 200),
  titleEn: textOf(2, 200).nullable().optional(),
  summaryAr: textOf(2, 600).nullable().optional(),
  summaryEn: textOf(2, 600).nullable().optional(),
  defaultLocale: z.enum(contentLocales).default('ar'),
  /** مسوّدة · مجدولة (تحتاج `publishAt`) · منشورة الآن. */
  status: z.enum(contentStatuses).default('draft'),
  publishAt: z.string().datetime({ offset: true }).nullable().optional(),
  seoTitleAr: textOf(2, 70).nullable().optional(),
  seoTitleEn: textOf(2, 70).nullable().optional(),
  seoDescAr: textOf(2, 180).nullable().optional(),
  seoDescEn: textOf(2, 180).nullable().optional(),
  ogImageUrl: z.string().trim().max(500).nullable().optional(),
  category: textOf(2, 60).nullable().optional(),
  authorName: textOf(2, 120).nullable().optional(),
  /** P-M10 — جعل الصفحة نسخةً من صفحةٍ أخرى: `variantOf` معرّف الأصل و`variantKey` حرفها. */
  variantOf: uuidSchema.nullable().optional(),
  variantKey: z.enum(contentVariantKeys).nullable().optional(),
  blocks: z.array(contentBlockInputSchema).max(80).default([]),
});
export type ContentPageCreate = z.infer<typeof contentPageCreateSchema>;

/**
 * التعديل: كل حقلٍ اختياري، **والكتل إن أُرسلت فهي البديل الكامل** (لا دمج).
 * الدمج يجعل حذف كتلةٍ مستحيلاً (يُرسل الباقي ولا يُرسل المحذوف ⇒ يبقى)، والبديل الكامل
 * هو الوحيد الذي يجعل المحرّر صادقاً في ما يرسله.
 */
export const contentPageUpdateSchema = z.object({
  titleAr: textOf(2, 200).optional(),
  titleEn: textOf(2, 200).nullable().optional(),
  summaryAr: textOf(2, 600).nullable().optional(),
  summaryEn: textOf(2, 600).nullable().optional(),
  defaultLocale: z.enum(contentLocales).optional(),
  category: textOf(2, 60).nullable().optional(),
  authorName: textOf(2, 120).nullable().optional(),
  variantOf: uuidSchema.nullable().optional(),
  variantKey: z.enum(contentVariantKeys).nullable().optional(),
  seoTitleAr: textOf(2, 70).nullable().optional(),
  seoTitleEn: textOf(2, 70).nullable().optional(),
  seoDescAr: textOf(2, 180).nullable().optional(),
  seoDescEn: textOf(2, 180).nullable().optional(),
  ogImageUrl: z.string().trim().max(500).nullable().optional(),
  blocks: z.array(contentBlockInputSchema).max(80).optional(),
  note: textOf(2, 300).optional(),
});
export type ContentPageUpdate = z.infer<typeof contentPageUpdateSchema>;

export const contentPublishSchema = z.object({
  /** نشرٌ فوري، أو جدولة إلى لحظةٍ قادمة. */
  at: z.string().datetime({ offset: true }).nullable().optional(),
  note: textOf(2, 300).optional(),
});
export type ContentPublish = z.infer<typeof contentPublishSchema>;

export const contentRetractSchema = z.object({
  reason: textOf(3, 300),
});
export type ContentRetract = z.infer<typeof contentRetractSchema>;

export const contentRestoreSchema = z.object({
  version: z.number().int().positive(),
  note: textOf(2, 300).optional(),
});
export type ContentRestore = z.infer<typeof contentRestoreSchema>;

/**
 * الترشيح **كائناً متداخلاً** لا مفاتيح بأقواس: `bootstrap.ts` يضبط محلّل الاستعلام على
 * `extended`، فـ`?filter[kind]=post` يصل إلى الخدمة `{ filter: { kind: 'post' } }`. ومفتاحٌ
 * باسم `'filter[kind]'` لا يصل أبداً — فيبدو الترشيح مضبوطاً في المخطط ويسقط صامتاً في
 * التشغيل. ويُقاس ذلك في `platform-content.spec.ts` (قائمةٌ مرشّحة لا تحمل نوعاً آخر).
 */
export const contentPageListQuerySchema = paginationQuerySchema.extend({
  filter: z
    .object({
      kind: z.enum(contentKinds).optional(),
      status: z.enum(contentStatuses).optional(),
      category: z.string().trim().max(60).optional(),
    })
    .optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(['updated', 'published', 'title']).default('updated'),
});
export type ContentPageListQuery = z.infer<typeof contentPageListQuerySchema>;

// ── النسخ

export const contentVersionSchema = z.object({
  id: uuidSchema,
  pageId: uuidSchema,
  version: z.number().int().positive(),
  note: z.string().nullable(),
  /** ما تحفظه الصورة: عدد الكتل وحالاتها — واللقطة الكاملة تُقرأ عند الاستعادة. */
  blockCount: z.number().int().nonnegative(),
  pageStatus: z.enum(contentStatuses),
  titleAr: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
export type ContentVersion = z.infer<typeof contentVersionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// القوائم واللافتات
// ─────────────────────────────────────────────────────────────────────────────

export const contentMenuItemSchema = z.object({
  key: z.string().trim().min(1).max(40),
  href: hrefSchema,
  labelAr: textOf(1, 60),
  labelEn: textOf(1, 60).nullable().optional(),
  /** وسمٌ صغير (`` · «جديد») يظهر بجانب العنصر. */
  badgeAr: textOf(1, 20).nullable().optional(),
});
export type ContentMenuItem = z.infer<typeof contentMenuItemSchema>;

export const contentMenuSchema = z.object({
  id: uuidSchema,
  position: z.enum(contentMenuPositions),
  items: z.array(contentMenuItemSchema),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type ContentMenu = z.infer<typeof contentMenuSchema>;

export const contentMenuUpdateSchema = z.object({
  items: z.array(contentMenuItemSchema).max(30),
});
export type ContentMenuUpdate = z.infer<typeof contentMenuUpdateSchema>;

export const contentBannerSchema = z.object({
  id: uuidSchema,
  textAr: z.string(),
  textEn: z.string().nullable(),
  href: z.string().nullable(),
  linkLabelAr: z.string().nullable(),
  linkLabelEn: z.string().nullable(),
  tone: z.enum(contentBannerTones),
  audience: z.enum(contentBannerAudiences),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  active: z.boolean(),
  /** هل هي معروضة الآن؟ (نشطة وداخل نافذتها) — يُحسب في الخدمة لا في كل شاشة. */
  live: z.boolean(),
  createdAt: z.string(),
});
export type ContentBanner = z.infer<typeof contentBannerSchema>;

const contentBannerBaseSchema = z.object({
  textAr: textOf(3, 200),
  textEn: textOf(3, 200).nullable().optional(),
  href: hrefSchema.nullable().optional(),
  linkLabelAr: textOf(1, 60).nullable().optional(),
  linkLabelEn: textOf(1, 60).nullable().optional(),
  tone: z.enum(contentBannerTones).default('info'),
  audience: z.enum(contentBannerAudiences).default('all'),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  active: z.boolean().default(true),
});

/**
 * نافذة العرض: النهاية بعد البداية.
 *
 * القاعدة مكتوبةٌ في القاعدة نفسها (`content_banners_window_check`) — وهي الحاكم الأخير —
 * لكن تركها هناك وحدها يجعل الخطأ يخرج `500 INTERNAL`: القيد يرفض الصفّ بعد أن يكون كل شيء
 * قد نُفِّذ. والقاعدةُ هنا تُعيده **400 بوصفٍ عربي** قبل أن يصل شيء إلى القاعدة، ولذلك
 * تُكرَّر في الخدمة أيضاً عند التعديل الجزئي (حيث لا تعرف هذه المدقّقة صفَّ القاعدة القائم).
 */
const windowMessage: { message: string; path: string[] } = {
  message: 'نهاية اللافتة يجب أن تكون بعد بدايتها',
  path: ['endsAt'],
};

export const contentBannerCreateSchema = contentBannerBaseSchema.refine(
  (value) =>
    value.endsAt === undefined ||
    value.endsAt === null ||
    new Date(value.endsAt).getTime() > (value.startsAt ? new Date(value.startsAt).getTime() : Date.now()),
  windowMessage,
);
export type ContentBannerCreate = z.infer<typeof contentBannerCreateSchema>;
export const contentBannerUpdateSchema = contentBannerBaseSchema.partial().refine(
  (value) =>
    value.endsAt === undefined ||
    value.endsAt === null ||
    new Date(value.endsAt).getTime() > (value.startsAt ? new Date(value.startsAt).getTime() : Date.now()),
  windowMessage,
);
export type ContentBannerUpdate = z.infer<typeof contentBannerUpdateSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// الواجهات العامة للموقع
// ─────────────────────────────────────────────────────────────────────────────

export const publicPostsQuerySchema = z.object({
  /**
   * نوع المحتوى المسرود. الافتراضي `post` (المدوّنة)، و`case_study` هو ما تقرؤه `/cases`
   * و«قالوا عن النظام» في الرئيسية — فنقطة النهاية واحدة والقيد من العميل.
   */
  kind: z.enum(contentKinds).default('post'),
  category: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PublicPostsQuery = z.infer<typeof publicPostsQuerySchema>;

export const publicHelpQuerySchema = z.object({
  category: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PublicHelpQuery = z.infer<typeof publicHelpQuerySchema>;

/** بطاقة مقالٍ في قائمة — بلا كتل: القائمة لا تحتاج نصّ المقال كاملاً. */
export const publicPostSchema = z.object({
  slug: z.string(),
  kind: z.enum(contentKinds),
  titleAr: z.string(),
  titleEn: z.string().nullable(),
  summaryAr: z.string().nullable(),
  summaryEn: z.string().nullable(),
  path: z.string(),
  category: z.string().nullable(),
  authorName: z.string().nullable(),
  publishedAt: z.string(),
  ogImageUrl: z.string().nullable(),
});
export type PublicPost = z.infer<typeof publicPostSchema>;

/** ما يكفي لتوليد `sitemap.xml` و`hreflang`: الرابط، متى تغيّر، وأي لغةٍ نالت ترجمة. */
export const publicSitemapEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(contentKinds),
  lastModified: z.string(),
  locales: z.array(z.enum(contentLocales)),
});
export type PublicSitemapEntry = z.infer<typeof publicSitemapEntrySchema>;

/** سؤال شائع للعرض في JSON-LD وفي الصفحة معاً. */
export const publicFaqSchema = z.object({
  slug: z.string(),
  question: z.string(),
  answer: z.string(),
});
export type PublicFaq = z.infer<typeof publicFaqSchema>;

/**
 * إعدادات الموقع — من `platform_settings` بمفاتيح `site.*` (P-C1)، فتُدار من شاشة
 * «الإعدادات» القائمة بلا شاشةٍ ثانية.
 */
export const publicSiteSchema = z.object({
  brandName: z.string(),
  brandInitials: z.string(),
  taglineAr: z.string(),
  taglineEn: z.string(),
  supportEmail: z.string(),
  supportPhone: z.string(),
  defaultLocale: z.enum(contentLocales),
  locales: z.array(z.enum(contentLocales)),
  /** النطاق العام — به تُبنى الروابط المطلقة في `sitemap.xml` و`canonical`. */
  siteUrl: z.string(),
  companyLegalName: z.string(),
  maintenance: z.boolean(),
  /** خريطة الموقع تحمل قوائمها أيضاً فلا تحتاج الشاشة نداءً ثانياً. */
  menus: z.record(z.enum(contentMenuPositions), z.array(contentMenuItemSchema)),
  /** اللافتة المعروضة الآن (إن وُجدت ونافذتها مفتوحة). */
  banner: contentBannerSchema.nullable(),
});
export type PublicSite = z.infer<typeof publicSiteSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// أفعال التدقيق
// ─────────────────────────────────────────────────────────────────────────────

/**
 * أفعال التدقيق — كائنٌ بأسماء ثابتة كما في P-C4، فالشاشة والاختبار يشيران إلى الفعل نفسه
 * بلا سلسلةٍ حرّة تُخطئ في حرف.
 */
export const contentAuditActions = {
  CREATED: 'content.page.created',
  UPDATED: 'content.page.updated',
  PUBLISHED: 'content.page.published',
  SCHEDULED: 'content.page.scheduled',
  RETRACTED: 'content.page.retracted',
  RESTORED: 'content.page.restored',
  MENU_UPDATED: 'content.menu.updated',
  BANNER_CREATED: 'content.banner.created',
  BANNER_UPDATED: 'content.banner.updated',
} as const;
export type ContentAuditAction = (typeof contentAuditActions)[keyof typeof contentAuditActions];

/** صفُّ خريطة الموقع — اسمٌ صريح لأن `PublicSitemapEntry` يُستعمل في التطبيق أيضاً. */
export type ContentSitemapRow = PublicSitemapEntry;

// ─────────────────────────────────────────────────────────────────────────────
// P-M9 — مركز المساعدة: الفئات والتصويت والحالة
// ─────────────────────────────────────────────────────────────────────────────

/**
 * فئةٌ من فئات مركز المساعدة — تُقرأ من `content_pages.category` لمقالات `help` المنشورة.
 *
 * **والعدد مقصود**: «التقارير (٤)» تُخبر الزائر قبل أن ينقر أنّ الباب ليس فارغاً؛ وقائمةُ
 * فئاتٍ بلا عدّاد تجعل الفارغ يبدو ممتلئاً.
 */
export const publicHelpCategorySchema = z.object({
  name: z.string(),
  count: z.number().int().min(1),
});
export type PublicHelpCategory = z.infer<typeof publicHelpCategorySchema>;

/**
 * غلاف قائمة المساعدة: `ListMeta` **زائد الفئات**.
 *
 * ولماذا في الغلاف لا في مسارٍ ثالث (`/public/help/categories`)؟ لأن الشاشة تحتاج القائمة
 * والفئات في اللحظة نفسها: نداءان يعنيان أن الفئات تصل بعد أول رسم، ولحظةَ فراغٍ لا معنى لها
 * في صفحةٍ هدفها إجابةُ سؤال. والفئات **غير مرشَّحة** بالفئة المطلوبة عمداً: من دخل على فئةٍ
 * من رابطٍ مباشر يجب أن يرى بقيّة الفئات ليخرج منها.
 */
export type PublicHelpMeta = ListMeta & { categories: PublicHelpCategory[] };

/**
 * تصويت «هل أفادك هذا؟».
 *
 * **و`visitor` ليس هوية**: معرّفٌ عشوائي (UUID) يولّده المتصفّح ويحفظه في `localStorage`،
 * والغرض منه **منع عدّ الصوت مرّتين** من المتصفّح نفسه لا تتبّع أحد. ولا يُخزَّن عنوان IP
 * ولا وسيط المتصفّح مع الصوت (والسبيك الحيّ يقيس ذلك في سجلّ التدقيق).
 */
export const publicHelpFeedbackSchema = z
  .object({
    helpful: z.boolean(),
    // معرّفٌ عشوائي بطول UUID — لا اسمٌ ولا بريد ولا رقم عميل.
    visitor: z.string().trim().uuid(),
  })
  .strict();
export type PublicHelpFeedback = z.infer<typeof publicHelpFeedbackSchema>;

/** نتيجة التصويت: العدّادان بعد المحاولة، وهل حُسب الصوت الآن أم كان محسوباً قبل. */
export const publicHelpFeedbackResultSchema = z.object({
  yes: z.number().int().min(0),
  no: z.number().int().min(0),
  recorded: z.boolean(),
});
export type PublicHelpFeedbackResult = z.infer<typeof publicHelpFeedbackResultSchema>;

/** عدّادا التصويت كما يُقرآن مع المقال. */
export type PublicHelpHelpful = { yes: number; no: number };

/**
 * مقالُ مساعدةٍ كامل: الصفحة بكتلها + فئتها + مقالاتها المجاورة + العدّادان.
 *
 * **والمجاورة من الفئة نفسها** لا «الأحدث عموماً»: من قرأ «كيف أُصدر فاتورة» يهمّه ما بعده في
 * الإصدار لا مقالٌ عن التسويق. فإن لم تكن للمقال فئة (مسموح في CMS) تعود المجاورة فارغة ولا
 * تُخترع من عموم المقالات.
 */
export type PublicHelpArticle = {
  page: ContentPageDetail;
  category: string | null;
  related: PublicPost[];
  helpful: PublicHelpHelpful;
};
