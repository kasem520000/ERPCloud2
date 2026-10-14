/**
 * P-M1 — العملة (i18n) في الموقع التسويقي: **لغتان حقيقيتان لا ترجمة تجميلية**.
 *
 * القرار: اللغة في **المسار** (`/en/...`) لا في كوكي ولا في `Accept-Language`. ثلاثة أسباب:
 *
 *   1. **محرّكات البحث**: صفحةٌ إنجليزية على `/blog/x` لا تُفهرَس كصفحةٍ إنجليزية إن كان
 *      الإنجليزي مخفيّاً في كوكي — والزائر يشارك رابطاً فيصل عربياً.
 *   2. **`hreflang`**: يُبنى من أزواج المسارات (`buildMetadata` في `lib/site.ts`)، وهو بلا
 *      مسارٍ للغة لا وجود له.
 *   3. **بلا حالة**: لا كوكي يُنسى ولا وميض ترجمة في أول رسم.
 *
 * والنصوص **القابلة للتغيير** لا تسكن هنا: هذه تسمياتٌ ثابتة في القشرة (تنقّل، خطأ، صيانة).
 * أمّا العناوين والفقرات والأسئلة فمن نظام إدارة المحتوى (`lib/content.ts`) — وهذا هو الفرق
 * الذي يجعل تعديل كلمةٍ لا يحتاج نشرة كود.
 */

export type Locale = 'ar' | 'en';

export const LOCALES: readonly Locale[] = ['ar', 'en'];

/** اللغة الأصل للمنصّة (السوق السعودي) — ويُقرأ من إعدادات الموقع عند الحاجة. */
export const DEFAULT_LOCALE: Locale = 'ar';

export function dir(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** من مسارٍ (`/en/blog/x`) إلى لغته؛ وما لا يبدأ بـ`/en` عربيّ. */
export function localeFromPath(pathname: string): Locale {
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'ar';
}

/** المسار النظير في اللغة الأخرى — أساس `hreflang` ومبدّل اللغة. */
export function localePath(pathname: string, locale: Locale): string {
  const bare = localeFromPath(pathname) === 'en' ? pathname.replace(/^\/en(?=\/|$)/, '') || '/' : pathname;
  if (locale === 'ar') return bare;
  return bare === '/' ? '/en' : `/en${bare}`;
}

type Dictionary = Record<string, string>;

const ar: Dictionary = {
  'nav.features': 'الوحدات',
  'nav.einvoicing': 'الفاتورة الإلكترونية',
  'nav.blog': 'المدوّنة',
  'nav.cases': 'دراسات حالة',
  'nav.help': 'مركز المساعدة',
  'nav.pricing': 'الباقات',
  // P-M3 — صفحة الأسعار (عناوينها القصيرة؛ والأرقام والحقوق من الـAPI لا من هنا)
  'pricing.title': 'الباقات والأسعار',
  'pricing.subtitle': 'أسعارٌ معلنة من المنصة نفسها: اختر ما تحتاجه اليوم، وارتقِ حين تكبر.',
  'pricing.interval.label': 'دورة الفاتورة',
  'pricing.interval.month': 'شهري',
  'pricing.interval.year': 'سنوي',
  'pricing.perMonth': 'تُدفع كل شهر',
  'pricing.perYear': 'تُدفع مرة واحدة في السنة',
  'pricing.equivalent': 'تعادل شهرياً',
  'pricing.save': 'وفّر',
  'pricing.choose': 'اشترك بهذه الباقة',
  'pricing.compare.title': 'الباقات المعروضة',
  'pricing.compare.caption': 'مقارنة الباقات بالحقوق',
  'pricing.compare.feature': 'الحق',
  'pricing.compare.everyPlan': 'في كل الباقات',
  'pricing.note.vat': 'الأسعار لا تشمل ضريبة القيمة المضافة',
  'pricing.faq.title': 'أسئلة التسعير',
  'pricing.final.title': 'جاهز تبدأ؟',
  'pricing.final.body': 'أنشئ منشأتك في دقائق، واختر الباقة أثناء الاشتراك — ثم أضف فرعك وفريقك.',
  'pricing.empty': 'لا توجد باقات معلنة الآن — تواصل معنا لنرتّب لك عرضاً.',
  'nav.contact': 'تواصل',
  'nav.verify': 'تحقق من فاتورة',
  // P-M8 — القطاعات وصفحة الثقة: مساران حقيقيّان بمحتواهما من `lib/industries.ts` و
  // `lib/trust.ts`، والعناوين هنا لأنها تُستعمل في القشرة وخريطة الموقع وقائمة التذييل.
  'nav.industries': 'القطاعات',
  'nav.trust': 'الأمان والثقة',
  'industries.title': 'القطاعات',
  'industries.subtitle':
    'خمسة أنشطةٍ لها وحداتٌ رأسيةٌ قائمة في النظام نفسه: التفصيل · النظارات · إدارة المراسي · المقاولات · متجر سلة.',
  'industries.open': 'تفاصيل القطاع',
  'industries.pains.title': 'ما يشتكي منه أصحاب هذا النشاط',
  'industries.screens.title': 'الشاشات التي تحلّها',
  'industries.screens.subtitle': 'كل سطرٍ بتسميته في تطبيق العمل ومساره وملفّه — للتحقّق لا للتزيين.',
  'industries.loop.title': 'دورة العمل في النظام',
  'industries.final.title': 'أتحبّ أن تراها على بياناتك؟',
  'industries.final.body': 'اطلب عرضاً ونجعل النشاط الأقرب إليك هو ما تُعرض عليه الشاشات.',
  'trust.title': 'الأمان والثقة',
  'trust.subtitle':
    'أربعة أسئلةٍ يسألها كل مشترٍ جدّيّ — التشفير · العزل · النسخ · الفاتورة الإلكترونية — ولكل بندٍ مصدرٌ يمكن فتحه.',
  'trust.limits.title': 'ما لا ندّعيه',
  'trust.limits.subtitle': 'الحدّ جزءٌ من الوصف: هذه ليست على القائمة اليوم، ولن تُكتب هنا كأنها كذلك.',
  'trust.final.title': 'اسألنا عن التفصيل الذي يهمّك',
  'trust.final.body': 'نقول ما هو مُنفَّذ، وما هو في خطة العمل، وما لن نفعله — ولن نُجيب بجملةٍ عامّة.',
  'cta.start': 'ابدأ مجاناً',
  'cta.explore': 'شاهد الوحدات',
  'cta.talk': 'تحدّث إلى المبيعات',
  'cta.login': 'دخول',
  'cta.readMore': 'اقرأ المزيد',
  'cta.backToBlog': 'كل المقالات',
  'cta.backToHelp': 'مركز المساعدة',
  'nav.signedIn': 'دخول المنشأة',
  'home.top': 'نظام تخطيط موارد المؤسسات السحابي',
  'home.modules.title': 'وحداتٌ تعمل معاً',
  'home.modules.subtitle': 'ليست تطبيقاتٍ منفصلة: كل وحدةٍ تكتب في الدفتر نفسه وفي المخزون نفسه.',
  'home.steps.title': 'كيف تبدأ في خمس خطوات',
  'home.einvoicing.title': 'الفاتورة الإلكترونية (زاتكا) جاهزة',
  'home.cases.title': 'قالوا عن النظام',
  'home.faq.title': 'أسئلةٌ شائعة',
  'home.final.title': 'جاهز تبدأ؟',
  'home.final.body': 'أنشئ منشأتك في دقائق، ثم أضف فرعك وفريقك — بلا بطاقة ولا التزام.',
    'home.hero.badge': 'مبنيّ للسوق السعودي',
  'home.hero.lead': 'دفاتر، ومخزون، وفواتير ضريبية، وتقارير — كلها في سحابة واحدة، بالعربية أولاً، وجاهزة لربط زاتكا من اليوم الأول.',
  'home.marquee.title': 'قطاعاتٌ نبني لها من اليوم الأول',
  'home.stats.modules': 'وحداتٍ تشغيلية متكاملة',
  'home.stats.steps': 'خطواتٍ من الاشتراك إلى أول فاتورة',
  'home.stats.cases': 'دراسات حالة منشورة',
  'home.stats.faq': 'أسئلة شائعة مجابة',
  'home.stats.cases.one': 'دراسة حالة منشورة',
  'home.stats.faq.one': 'سؤالاً شائعاً مجاباً',
  'pricing.featured': 'الأكثر شيوعاً',
  'home.hero.f1': 'بالعربية أولاً',
  'home.hero.f2': 'ربط زاتكا من اليوم الأول',
  'home.hero.f3': 'بلا بطاقة ولا التزام',
  'features.title': 'الوحدات',
  'features.subtitle': 'ثماني وحداتٍ أساسية، وتعمل على بياناتٍ واحدة.',
  'features.link': 'تفاصيل الوحدة',
  'einvoicing.title': 'الفاتورة الإلكترونية',
  'blog.title': 'المدوّنة',
  'blog.subtitle': 'ما نكتبه عن المحاسبة والتشغيل في السوق السعودي.',
  'blog.empty': 'لا مقالات منشورة بعد — نكتب الأولى الآن.',
  'blog.all': 'الكل',
  'cases.title': 'دراسات حالة',
  'cases.empty': 'لا دراسات حالة منشورة بعد.',
  'help.title': 'مركز المساعدة',
  'help.subtitle': 'مقالاتٌ قصيرة لما يسأل عنه العملاء فعلاً.',
  'help.search': 'ابحث في المساعدة',
  'help.searchCta': 'ابحث',
  'help.empty': 'لا مقال يطابق بحثك.',
  'help.emptyAll': 'لا مقالات منشورة بعد.',
  'help.category': 'التصنيف',
  // P-M9 — مركز المساعدة وسجلّ التغييرات وحالة الخدمة.
  'help.categories': 'التصنيفات',
  'help.all': 'الكل',
  'help.related': 'مقالات في التصنيف نفسه',
  'help.helpful': 'هل أفادك هذا؟',
  'help.helpfulYes': 'أفادني',
  'help.helpfulNo': 'لم يفدني',
  'help.helpfulSending': 'يُسجَّل…',
  'help.helpfulFailed': 'تعذّر تسجيل صوتك الآن — حاول مرّة أخرى.',
  'changelog.title': 'سجلّ التغييرات',
  'changelog.subtitle': 'ما وصل إلى المنصّة فعلاً: ميزةٌ تُكتب هنا يوم تُنشر، لا يوم تُوعد.',
  'changelog.empty': 'لا تغييرات منشورة بعد.',
  'changelog.back': 'كل التغييرات',
  'changelog.entry': 'تحديث',
  'status.title': 'حالة الخدمة',
  'status.subtitle': 'ما تقيسه المنصّة الآن — بنفس المجسّات التي يقرؤها فريق التشغيل.',
  'status.checkedAt': 'آخر قياس',
  'status.uptime': 'مدّة التشغيل',
  'status.components': 'المكوّنات',
  'status.component': 'المكوّن',
  'status.state': 'الحالة',
  'status.what': 'ما يقيسه',
  'status.latency': 'الزمن',
  'status.incident': 'حادث معلَن',
  'status.noIncident': 'لا حادث معلَناً الآن.',
  'status.unavailable': 'تعذّر قراءة حالة الخدمة الآن — لم نُخمّن حالةً بدلاً منها.',
  'status.back': 'أعد القياس بتحديث الصفحة',
  'error.notFound.title': 'الصفحة غير موجودة',
  'error.notFound.body': 'الرابط الذي طلبته لم يعد موجوداً أو لم يكن يوماً. جرّب من البداية.',
  'error.notFound.cta': 'إلى الصفحة الرئيسية',
  'maintenance.title': 'صيانةٌ مجدولة',
  'maintenance.body': 'نُعيد ترتيب البيت لدقائق. المعاودة قريباً — والأنظمة القائمة لم تتوقف.',
  'footer.product': 'المنتج',
  'footer.content': 'المحتوى',
  'footer.company': 'المنشورات',
  'footer.legal': 'قانوني',
  'footer.contact': 'تواصل',
  'footer.rights': 'جميع الحقوق محفوظة',
  'footer.language': 'اللغة',
  'lang.switch': 'English',
  'banner.dismiss': 'إغلاق',
  'meta.localeName': 'العربية',
};

const en: Dictionary = {
  'nav.features': 'Modules',
  'nav.einvoicing': 'E-invoicing',
  'nav.blog': 'Blog',
  'nav.cases': 'Case studies',
  'nav.help': 'Help center',
  'nav.pricing': 'Pricing',
  // P-M3 — the pricing page. `/pricing` is Arabic-only today (route map §4), and the English
  // strings live here so the twin route needs no new vocabulary when it is added.
  'pricing.title': 'Plans and pricing',
  'pricing.subtitle': 'Prices published from the platform itself: pick what you need today, move up when you grow.',
  'pricing.interval.label': 'Billing period',
  'pricing.interval.month': 'Monthly',
  'pricing.interval.year': 'Yearly',
  'pricing.perMonth': 'Billed every month',
  'pricing.perYear': 'Billed once a year',
  'pricing.equivalent': 'Equivalent to',
  'pricing.save': 'Save',
  'pricing.choose': 'Choose this plan',
  'pricing.compare.title': 'Published plans',
  'pricing.compare.caption': 'Plans compared by entitlement',
  'pricing.compare.feature': 'Entitlement',
  'pricing.compare.everyPlan': 'in every plan',
  'pricing.note.vat': 'Prices exclude VAT',
  'pricing.faq.title': 'Pricing questions',
  'pricing.final.title': 'Ready to start?',
  'pricing.final.body': 'Create your workspace in minutes and pick a plan during sign-up — then add your branch and team.',
  'pricing.empty': 'No plans are published right now — talk to us and we will put an offer together.',
  'nav.contact': 'Contact',
  'nav.verify': 'Verify invoice',
  // P-M8 — the two Arabic-first routes. Their content (`lib/industries.ts`, `lib/trust.ts`) is
  // Arabic by decision; the English labels exist so the shell, the footer and the sitemap never
  // print a raw key when `/en/*` arrives in P-M10.
  'nav.industries': 'Industries',
  'nav.trust': 'Trust and security',
  'industries.title': 'Industries',
  'industries.subtitle':
    'Five trades with vertical modules already shipping: tailoring, optics, marina, contracting and Salla.',
  'industries.open': 'Industry detail',
  'industries.pains.title': 'What this trade complains about',
  'industries.screens.title': 'The screens that answer it',
  'industries.screens.subtitle': 'Every line carries its Staff app label, route and source file.',
  'industries.loop.title': 'The loop in the system',
  'industries.final.title': 'See it on your own data',
  'industries.final.body': 'Book a demo and we show the trade closest to yours.',
  'trust.title': 'Trust and security',
  'trust.subtitle':
    'Four questions every serious buyer asks — encryption, isolation, backups, e-invoicing — each with a source you can open.',
  'trust.limits.title': 'What we do not claim',
  'trust.limits.subtitle': 'Limits are part of the description.',
  'trust.final.title': 'Ask about the detail you care about',
  'trust.final.body': 'We answer what is shipped, what is planned, and what we will not do.',
  'cta.start': 'Start free',
  'cta.explore': 'Explore modules',
  'cta.talk': 'Talk to sales',
  'cta.login': 'Sign in',
  'cta.readMore': 'Read more',
  'cta.backToBlog': 'All articles',
  'cta.backToHelp': 'Help center',
  'nav.signedIn': 'Workspace sign-in',
  'home.top': 'Cloud ERP for growing businesses',
  'home.modules.title': 'Modules that work together',
  'home.modules.subtitle': 'Not separate apps: every module writes to the same ledger and the same stock.',
  'home.steps.title': 'Live in five steps',
  'home.einvoicing.title': 'E-invoicing (ZATCA) ready',
  'home.cases.title': 'What customers say',
  'home.faq.title': 'Frequently asked',
  'home.final.title': 'Ready to start?',
  'home.final.body': 'Create your workspace in minutes, then add your branch and team — no card needed.',
    'home.hero.badge': 'Built for the Saudi market',
  'home.hero.lead': 'Ledgers, inventory, tax invoices and reports — one cloud, Arabic-first, ready to connect to ZATCA from day one.',
  'home.marquee.title': 'Industries we build for from day one',
  'home.stats.modules': 'integrated operational modules',
  'home.stats.steps': 'steps from sign-up to your first invoice',
  'home.stats.cases': 'published case study',
  'home.stats.faq': 'answered FAQ',
  'home.stats.cases.one': 'published case study',
  'home.stats.faq.one': 'answered FAQ',
  'pricing.featured': 'Most popular',
  'home.hero.f1': 'Arabic-first',
  'home.hero.f2': 'ZATCA-ready from day one',
  'home.hero.f3': 'No card, no commitment',
  'features.title': 'Modules',
  'features.subtitle': 'Eight core modules on one set of data.',
  'features.link': 'Module details',
  'einvoicing.title': 'E-invoicing',
  'blog.title': 'Blog',
  'blog.subtitle': 'Notes on accounting and operations in the Saudi market.',
  'blog.empty': 'No articles published yet — the first ones are being written.',
  'blog.all': 'All',
  'cases.title': 'Case studies',
  'cases.empty': 'No case studies published yet.',
  'help.title': 'Help center',
  'help.subtitle': 'Short articles for what customers actually ask.',
  'help.search': 'Search the help center',
  'help.searchCta': 'Search',
  'help.empty': 'No article matches your search.',
  'help.emptyAll': 'No articles published yet.',
  'help.category': 'Category',
  'help.categories': 'Categories',
  'help.all': 'All',
  'help.related': 'More in this category',
  'help.helpful': 'Was this helpful?',
  'help.helpfulYes': 'Yes',
  'help.helpfulNo': 'No',
  'help.helpfulSending': 'Saving…',
  'help.helpfulFailed': 'Could not record your vote right now — please try again.',
  'changelog.title': 'Changelog',
  'changelog.subtitle': 'What actually shipped: written the day it ships, not the day it is promised.',
  'changelog.empty': 'No changelog entries published yet.',
  'changelog.back': 'All changes',
  'changelog.entry': 'Update',
  'status.title': 'Service status',
  'status.subtitle': 'What the platform measures right now — the same probes the operations team reads.',
  'status.checkedAt': 'Last check',
  'status.uptime': 'Uptime',
  'status.components': 'Components',
  'status.component': 'Component',
  'status.state': 'State',
  'status.what': 'What it measures',
  'status.latency': 'Latency',
  'status.incident': 'Declared incident',
  'status.noIncident': 'No incident is declared right now.',
  'status.unavailable': 'Service status could not be read — no state was invented in its place.',
  'status.back': 'Refresh the page to measure again',
  'error.notFound.title': 'Page not found',
  'error.notFound.body': 'That link is gone, or was never here. Start from the home page.',
  'error.notFound.cta': 'Go to home page',
  'maintenance.title': 'Scheduled maintenance',
  'maintenance.body': 'We are tidying up for a few minutes. Back shortly — running systems stay up.',
  'footer.product': 'Product',
  'footer.content': 'Content',
  'footer.company': 'Company',
  'footer.legal': 'Legal',
  'footer.contact': 'Contact',
  'footer.rights': 'All rights reserved',
  'footer.language': 'Language',
  'lang.switch': 'العربية',
  'banner.dismiss': 'Dismiss',
  'meta.localeName': 'English',
};

const dictionaries: Record<Locale, Dictionary> = { ar, en };

/** نصٌّ من القاموس الثابت — والمفتاح الغائب يُعيد المفتاح نفسه فلا يظهر فراغٌ صامت. */
export function t(locale: Locale, key: string): string {
  return dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
}

/**
 * قاموسٌ كامل للغة — يُستعمل في القشرة التي ترسم عشرات المفاتيح في مكانٍ واحد.
 * (نموذج `copy` القديم بقي للتوافق مع الصفحات القائمة.)
 */
export function dictionary(locale: Locale): Dictionary {
  return { ...dictionaries[DEFAULT_LOCALE], ...dictionaries[locale] };
}

export const copy = {
  ar: {
    title: 'نظام تخطيط موارد المؤسسات السحابي',
    subtitle: 'المحاسبة والمخزون والمبيعات والفواتير الإلكترونية — اشترك وابدأ خلال دقائق.',
    login: 'تسجيل الدخول',
    portal: 'دخول بوابة العملاء',
    verify: 'تحقق من فاتورة',
    contact: 'تواصل معنا',
  },
  en: {
    title: 'Cloud ERP for growing businesses',
    subtitle: 'Accounting, inventory, sales and e-invoicing — subscribe and start in minutes.',
    login: 'Login',
    portal: 'Open customer portal',
    verify: 'Verify invoice',
    contact: 'Contact us',
  },
} as const;
