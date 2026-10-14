/**
 * P-M1 — مسارات الموقع التسويقي: مصدرٌ واحد للرأس والتذييل وخريطة الموقع والاختبارات.
 *
 * ويقابله `publicRoutes` القديم (أربعة مسارات) الذي بقي كما هو لأن `tests/routes.spec.ts`
 * يقيسه — والجديد يوسّعه ولا يمحوه.
 */

import { t, type Locale } from './i18n';

export type PortalRoute = { key: string; href: string; labelAr: string; labelEn: string };

export const publicRoutes: PortalRoute[] = [
  { key: 'home', href: '/', labelAr: 'الرئيسية', labelEn: 'Home' },
  { key: 'pricing', href: '/pricing', labelAr: 'الأسعار', labelEn: 'Pricing' },
  // P-M6: طلب العرض صار مساراً (كان زرّاً يشير إلى `/contact`) — ومصدره `demo` في طابور
  // العملاء المتوقّعين، فلا يجب أن يعيش خارج خريطة الموقع.
  { key: 'demo', href: '/demo', labelAr: 'اطلب عرضاً', labelEn: 'Book a demo' },
  { key: 'contact', href: '/contact', labelAr: 'تواصل', labelEn: 'Contact' },
  { key: 'verify', href: '/verify', labelAr: 'تحقق من فاتورة', labelEn: 'Verify' },
];

export type SiteRoute = {
  key: string;
  /** مسار الشاشة في هذه اللغة. */
  href: string;
  labelAr: string;
  labelEn: string;
  /** هل للمسار نظيرٌ إنجليزي؟ — يُبنى منه `hreflang`. */
  bilingual: boolean;
  /** أيقونة العلامة تظهر بها في الشريط. */
  nav: boolean;
};

/**
 * المسارات العامّة بعد P-M1/P-M2. `bilingual: false` للأسطح التشغيلية (الباقات، الاشتراك،
 * الدخول، التحقّق) — هذه واجهة تشغيلٍ للسوق السعودي، وتزويجها بلغةٍ ثانية بلا ترجمةٍ حقيقية
 * يخالف قاعدتين: «اللغتان حقيقيتان» و«لا نصّ وهمي».
 */
export const siteRoutes: SiteRoute[] = [
  { key: 'home', href: '/', labelAr: 'الرئيسية', labelEn: 'Home', bilingual: true, nav: false },
  { key: 'features', href: '/features', labelAr: 'الوحدات', labelEn: 'Modules', bilingual: true, nav: true },
  {
    key: 'einvoicing',
    href: '/features/einvoicing',
    labelAr: 'الفاتورة الإلكترونية',
    labelEn: 'E-invoicing',
    bilingual: true,
    // القسم يظهر في `/features` وفي التذييل، ولا يزدحم به شريط الرأس.
    nav: false,
  },
  { key: 'blog', href: '/blog', labelAr: 'المدوّنة', labelEn: 'Blog', bilingual: true, nav: true },
  { key: 'cases', href: '/cases', labelAr: 'دراسات حالة', labelEn: 'Case studies', bilingual: true, nav: true },
  { key: 'help', href: '/help', labelAr: 'مركز المساعدة', labelEn: 'Help center', bilingual: true, nav: true },
  { key: 'pricing', href: '/pricing', labelAr: 'الباقات', labelEn: 'Pricing', bilingual: false, nav: true },
  { key: 'contact', href: '/contact', labelAr: 'تواصل معنا', labelEn: 'Contact', bilingual: false, nav: true },
  // P-M6: «اطلب عرضاً» مسارٌ عربيٌّ وحده (ترجمته مع `/en/*` في P-M10)، ويظهر في الرأس
  // لأنّه أوّل ما يطلبه زائرٌ يريد أن يرى النظام قبل أن يدفع.
  { key: 'demo', href: '/demo', labelAr: 'اطلب عرضاً', labelEn: 'Book a demo', bilingual: false, nav: true },
  // P-M8: القطاعات وصفحة الثقة في الرأس — وهما السؤالان اللذان يسألهما المشتري قبل الشراء
  // («هل يناسب نشاطي؟» و«أين بياناتي؟»)، فلا يُخفيان في التذييل وحده.
  {
    key: 'industries',
    href: '/industries',
    labelAr: 'القطاعات',
    labelEn: 'Industries',
    // arabic-only today: القطاعات تُسمّي شاشات الموظّفين بتسمياتها العربية، والترجمة تأتي مع
    // `/en/*` في P-M10 — فإعلان نظيرٍ غير موجود أسوأ من غياب الوسم.
    bilingual: false,
    nav: true,
  },
  { key: 'trust', href: '/trust', labelAr: 'الأمان والثقة', labelEn: 'Trust and security', bilingual: false, nav: true },
  { key: 'verify', href: '/verify', labelAr: 'تحقّق من فاتورة', labelEn: 'Verify invoice', bilingual: false, nav: false },
  // P-M9: سجلّ التغييرات وحالة الخدمة — في التذييل لا في الرأس: من يبحث عنهما يعرف أنهما
  // موجودان (وهما في خريطة الموقع)، ولا يزدحم بهما شريطُ أوّل زيارة.
  { key: 'changelog', href: '/changelog', labelAr: 'سجلّ التغييرات', labelEn: 'Changelog', bilingual: false, nav: false },
  { key: 'status', href: '/status', labelAr: 'حالة الخدمة', labelEn: 'Service status', bilingual: false, nav: false },
  { key: 'onboarding', href: '/onboarding', labelAr: 'اشترك', labelEn: 'Subscribe', bilingual: false, nav: false },
  { key: 'login', href: '/login', labelAr: 'دخول', labelEn: 'Sign in', bilingual: false, nav: false },
  { key: 'maintenance', href: '/maintenance', labelAr: 'صيانة', labelEn: 'Maintenance', bilingual: false, nav: false },
];

/** روابط الرأس — التي تُعلن `nav: true` فقط. */
export function headerRoutes(): SiteRoute[] {
  return siteRoutes.filter((route) => route.nav);
}

/** مسارٌ في لغته: العربي بلا بادئة، والإنجليزي بـ`/en`. */
export function routeHref(route: SiteRoute, locale: Locale): string {
  if (locale === 'ar') return route.href;
  return route.href === '/' ? '/en' : `/en${route.href}`;
}

/** عناصر القائمة الافتراضية — تُستعمل حين لا قائمة في نظام المحتوى بعد. */
export function siteNavLinks(locale: Locale) {
  return headerRoutes().map((route) => ({
    key: route.key,
    href: routeHref(route, locale),
    label: locale === 'en' ? route.labelEn : route.labelAr,
  }));
}

export function siteFooterLinks(locale: Locale): Array<{ key: string; label: string; links: Array<{ href: string; label: string }> }> {
  const byKey = (key: string) => siteRoutes.find((route) => route.key === key) as SiteRoute;
  const link = (key: string) => {
    const route = byKey(key);
    return { href: routeHref(route, locale), label: locale === 'en' ? route.labelEn : route.labelAr };
  };
  const article = (path: string, labelAr: string, labelEn: string, bilingual = true) => ({
    href: locale === 'en' && bilingual ? `/en${path}` : path,
    label: locale === 'en' && bilingual ? labelEn : labelAr,
  });

  return [
    {
      key: 'product',
      label: t(locale, 'footer.product'),
      links: [
        link('features'),
        link('einvoicing'),
        link('industries'),
        link('pricing'),
        link('verify'),
        link('trust'),
        link('status'),
      ],
    },
    {
      key: 'content',
      label: t(locale, 'footer.content'),
      links: [link('blog'), link('cases'), link('help'), link('changelog')],
    },
    {
      key: 'company',
      label: t(locale, 'footer.company'),
      links: [
        article('/legal/terms', 'شروط الاستخدام', 'Terms of use'),
        article('/legal/privacy', 'سياسة الخصوصية', 'Privacy policy'),
        article('/legal/cookies', 'ملفات الارتباط', 'Cookies'),
      ],
    },
  ];
}

/**
 * صفحة `not-found` وحدها بلا لغةٍ في المسار (Next لا يمرّر القطعة إليها)، فتُقرأ اللغة من
 * الرابط عبر `x-pathname` — و`RouteNotFound` في `components/site/views.tsx` تحمل النصّين.
 */
export function notFoundText(locale: Locale) {
  return {
    title: t(locale, 'error.notFound.title'),
    body: t(locale, 'error.notFound.body'),
    cta: t(locale, 'error.notFound.cta'),
    href: locale === 'ar' ? '/' : '/en',
  };
}
