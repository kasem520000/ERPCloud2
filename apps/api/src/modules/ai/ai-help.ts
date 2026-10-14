import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPORT_DEFINITIONS } from '../reporting/report-catalog.js';

import { NAVIGATION_SNAPSHOT } from './navigation-snapshot.js';

/**
 * Help corpus for the how-to skill.
 *
 * Navigation articles are the screens a clerk actually opens. Report articles
 * come from the same catalog the report centre renders, so a question about a
 * report can point at `/reports/:key` without a second list drifting away.
 */

export type HelpArticle = {
  id: string;
  title: string;
  href: string;
  keywords: string[];
  steps: string[];
  source: 'navigation' | 'report' | 'docs';
};

export const NAVIGATION_HELP: readonly HelpArticle[] = [
  {
    id: 'sales-invoice-new',
    title: 'إنشاء فاتورة مبيعات',
    href: '/sales/invoices/new',
    keywords: ['فاتورة', 'فواتير', 'مبيعات', 'انشئ', 'إنشاء', 'جديدة', 'بيع', 'اضافة'],
    steps: [
      'افتح شاشة فاتورة مبيعات جديدة.',
      'اختر الفرع والعميل، ثم أضف الأصناف والكميات.',
      'احفظ المسودة وراجع الضريبة والإجمالي.',
      'رحّل الفاتورة بعد المراجعة حتى تدخل التقارير.',
    ],
    source: 'navigation',
  },
  {
    id: 'journal-new',
    title: 'إنشاء قيد يومية',
    href: '/accounting/journal-entries/new',
    keywords: ['قيد', 'قيود', 'يومية', 'ترحيل', 'رحيل', 'محاسبة', 'مدين', 'دائن'],
    steps: [
      'افتح قيد يومية جديد.',
      'أدخل التاريخ والحسابات المدينة والدائنة بمبالغ متساوية.',
      'راجع القيد ثم رحّله من الشاشة. المساعد لا يرحّل قيداً تلقائياً.',
    ],
    source: 'navigation',
  },
  {
    id: 'reports-center',
    title: 'مركز التقارير',
    href: '/reports',
    keywords: ['تقرير', 'تقارير', 'قائمة', 'مركز'],
    steps: ['افتح مركز التقارير.', 'اختر التقرير وحدد الفترة والفرع.', 'صدّر أو اطبع بعد المراجعة.'],
    source: 'navigation',
  },
  {
    id: 'customers',
    title: 'العملاء',
    href: '/sales/customers',
    keywords: ['عميل', 'عملاء', 'ذمم'],
    steps: ['افتح بطاقات العملاء.', 'ابحث بالاسم أو أنشئ عميلاً جديداً.', 'حد الائتمان يُراجع قبل ترحيل فاتورة آجلة.'],
    source: 'navigation',
  },
  {
    id: 'items',
    title: 'الأصناف والمخزون',
    href: '/inventory/items',
    keywords: ['صنف', 'أصناف', 'مخزون', 'حد', 'نواقص'],
    steps: ['افتح بطاقة الصنف وراجع الحد الأدنى.', 'الأصناف تحت الحد تظهر في تنبيهات المساعد ولوحة المخزون.'],
    source: 'navigation',
  },
  {
    id: 'payments',
    title: 'روابط الدفع',
    href: '/settings/payments',
    keywords: ['ميسر', 'دفع', 'رابط', 'hyperpay', 'tap'],
    steps: ['اربط مزود الدفع من الإعدادات.', 'من الفاتورة المرحّلة أنشئ رابط دفع وأرسله للعميل.'],
    source: 'navigation',
  },
  {
    id: 'payroll',
    title: 'حماية الأجور والتأمينات',
    href: '/hrm/payroll',
    keywords: ['راتب', 'رواتب', 'مدد', 'تأمينات', 'wps'],
    steps: ['افتح مسير الرواتب المرحّل.', 'صدّر ملف حماية الأجور أو التأمينات ثم ارفع الملف يدوياً.'],
    source: 'navigation',
  },
];

export function reportHelpArticles(
  reports: ReadonlyArray<{ key: string; titleAr: string; hintAr?: string }>,
): HelpArticle[] {
  return reports.map((report) => ({
    id: `report:${report.key}`,
    title: report.titleAr,
    href: `/reports/${report.key}`,
    keywords: report.titleAr.split(/\s+/).filter((token) => token.length > 2),
    steps: [
      `افتح تقرير «${report.titleAr}».`,
      'حدد الفترة والفرع ثم اعرض النتائج.',
      report.hintAr ?? 'الأرقام مجمّعة من المستندات المرحّلة.',
    ],
    source: 'report',
  }));
}

const SCREEN_CALL =
  /screen\(\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']+)'\s*,\s*'(ready|api|planned)'/g;

/** Pulls ready screens out of `apps/staff/lib/navigation.ts` without importing the staff app. */
export function navigationArticlesFromSource(source: string): HelpArticle[] {
  const articles: HelpArticle[] = [];
  for (const match of source.matchAll(SCREEN_CALL)) {
    const [, key, labelAr, labelEn, href, status] = match;
    if (!key || !labelAr || !href || status !== 'ready' || !href.startsWith('/')) continue;
    const keywords: string[] = [];
    for (const token of `${labelAr} ${labelEn ?? ''} ${href.replaceAll('/', ' ')}`.split(/[^\p{L}\p{N}]+/u)) {
      if (token.length > 1 && !keywords.includes(token)) keywords.push(token);
    }
    articles.push({
      id: `nav:${key}`,
      title: labelAr,
      href,
      keywords: keywords.slice(0, 12),
      steps: [
        `افتح «${labelAr}» من قائمة النظام.`,
        'أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد.',
      ],
      source: 'navigation',
    });
  }
  return articles;
}

/**
 * Short system guide shipped with the API. It is the docs half of the corpus:
 * the production image does not contain the docs tree.
 */
export const SYSTEM_GUIDE = [
  '## إنشاء فاتورة مبيعات',
  'افتح فاتورة جديدة، اختر الفرع والعميل، أضف الأصناف والكميات، راجع الضريبة ثم رحّل من الشاشة.',
  '## إنشاء قيد يومية',
  'القيد يُراجع ثم يُرحّل من شاشة قيد اليومية. المساعد لا ينشئ قيداً ولا يرحّله.',
  '## التقارير',
  'مركز التقارير يعرض مجاميع المستندات المرحّلة. حدد الفترة والفرع قبل التصدير.',
  '## المخزون',
  'الحد الأدنى على بطاقة الصنف يُقارن بالرصيد. التنبيه يذكر عدد الأصناف لا تكلفة الشراء.',
  '## الفواتير المتأخرة',
  'الفاتورة المتأخرة فاتورة مرحّلة غير مسددة منذ أكثر من 30 يوماً. المتبقي مجموع لا أسماء.',
  '## الخصوصية',
  'لا تُرسل أرقام الهوية ولا مسيرات الرواتب التفصيلية إلى النموذج. أسئلة الرواتب تُحال إلى شاشة المسير.',
].join('\n');

export function docsArticlesFromMarkdown(idPrefix: string, markdown: string): HelpArticle[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [titleLine, ...rest] = section.split('\n');
      const title = titleLine?.trim() ?? '';
      const steps = rest
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('|'));
      return { title, steps };
    })
    .filter((section) => section.title.length > 0 && section.steps.length > 0)
    .slice(0, 40)
    .map((section) => ({
      id: `docs:${idPrefix}:${section.title}`,
      title: section.title,
      href: section.title.includes('فاتورة')
        ? '/sales/invoices'
        : section.title.includes('قيد')
          ? '/accounting/journal-entries'
          : section.title.includes('تقرير')
            ? '/reports'
            : section.title.includes('مخزون')
              ? '/inventory/items'
              : section.title.includes('راتب')
              ? '/hrm/payroll'
              : '/assistant',
      keywords: section.title.split(/\s+/).filter((token) => token.length > 2),
      steps: section.steps.slice(0, 3),
      source: 'docs' as const,
    }));
}

function navigationCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(process.cwd(), 'apps/staff/lib/navigation.ts'),
    join(process.cwd(), '../staff/lib/navigation.ts'),
    join(here, '../../../../..', 'apps/staff/lib/navigation.ts'),
    join(here, '../../../../../..', 'apps/staff/lib/navigation.ts'),
  ];
}

function readNavigationSource(): string | undefined {
  for (const path of navigationCandidates()) {
    if (!existsSync(path)) continue;
    return readFileSync(path, 'utf8');
  }
  return undefined;
}

function reportArticles(): HelpArticle[] {
  return reportHelpArticles(
    REPORT_DEFINITIONS.map((definition) => ({
      key: definition.key,
      titleAr: definition.titleAr,
      hintAr: definition.hintAr,
    })),
  );
}

export function defaultHelpCorpus(): HelpArticle[] {
  return [...NAVIGATION_HELP, ...reportArticles()];
}

/**
 * Curated steps stay first. Live `navigation.ts` is preferred when the monorepo
 * is present; otherwise the committed snapshot is used. Docs come from the
 * shipped guide, not from tenant data.
 */
export function workspaceHelpCorpus(): HelpArticle[] {
  const live = readNavigationSource();
  const parsed = live ? navigationArticlesFromSource(live) : NAVIGATION_SNAPSHOT;
  const curatedHrefs = new Set(NAVIGATION_HELP.map((article) => article.href));
  return [
    ...NAVIGATION_HELP,
    ...parsed.filter((article) => !curatedHrefs.has(article.href)),
    ...docsArticlesFromMarkdown('system', SYSTEM_GUIDE),
    ...reportArticles(),
  ];
}
