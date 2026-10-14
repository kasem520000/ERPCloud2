/**
 * سوق الإضافات والعلامة البيضاء — قواعد بلا قاعدة بيانات.
 *
 * الإضافة المقبولة صفٌّ في الكتالوج الثابت، لا ملفٌ يُنفَّذ. إيقاف الإضافة يُخفي
 * شاشتها ولا يمسح إعداداتها. الدومين يُتحقق منه بسجل TXT، والشهادة تبقى يدوية.
 */

export class MarketplaceRuleError extends Error {
  constructor(readonly rule: 'UNKNOWN_APP' | 'DOMAIN' | 'TXT') {
    super(rule);
    this.name = 'MarketplaceRuleError';
  }
}

export type MarketplaceApp = {
  code: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  icon: string;
  version: string;
  monthlyPrice: string;
  isCore: boolean;
  screens: readonly string[];
};

/** إضافات مُراجَعة. لا حقل كود ولا SQL: التفعيل علمٌ على صف، لا تحميل وحدة. */
export const MARKETPLACE_APPS: readonly MarketplaceApp[] = [
  {
    code: 'salla',
    nameAr: 'سلة',
    nameEn: 'Salla',
    descriptionAr: 'استيراد طلبات سلة إلى فواتير المبيعات.',
    icon: '🛒',
    version: '1.0.0',
    monthlyPrice: '49.0000',
    isCore: false,
    screens: ['/settings/ecommerce', '/sales/ecommerce-orders'],
  },
  {
    code: 'zid',
    nameAr: 'زد',
    nameEn: 'Zid',
    descriptionAr: 'استيراد طلبات زد إلى فواتير المبيعات.',
    icon: '🛍️',
    version: '1.0.0',
    monthlyPrice: '49.0000',
    isCore: false,
    screens: ['/settings/ecommerce', '/sales/ecommerce-orders'],
  },
  {
    code: 'shopify',
    nameAr: 'شوبيفاي',
    nameEn: 'Shopify',
    descriptionAr: 'استيراد طلبات شوبيفاي إلى فواتير المبيعات.',
    icon: '🏪',
    version: '1.0.0',
    monthlyPrice: '49.0000',
    isCore: false,
    screens: ['/settings/ecommerce', '/sales/ecommerce-orders'],
  },
  {
    code: 'moyasar',
    nameAr: 'ميسر',
    nameEn: 'Moyasar',
    descriptionAr: 'روابط دفع ميسر على فواتير المبيعات.',
    icon: '💳',
    version: '1.0.0',
    monthlyPrice: '29.0000',
    isCore: false,
    screens: [],
  },
  {
    code: 'ocr',
    nameAr: 'مسح الفواتير',
    nameEn: 'OCR',
    descriptionAr: 'قراءة فاتورة الشراء. مشحونة مع النظام ولا تُخفى.',
    icon: '📄',
    version: '1.0.0',
    monthlyPrice: '0.0000',
    isCore: true,
    screens: [],
  },
  {
    code: 'esign',
    nameAr: 'توقيع مرسوم',
    nameEn: 'E-sign',
    descriptionAr: 'توقيع مرسوم مع رمز لمرة واحدة. مشحون مع النظام.',
    icon: '✍️',
    version: '1.0.0',
    monthlyPrice: '0.0000',
    isCore: true,
    screens: [],
  },
  {
    code: 'wms',
    nameAr: 'المستودعات',
    nameEn: 'WMS',
    descriptionAr: 'الرفوف والتصنيع الخفيف. مشحونان مع النظام.',
    icon: '📦',
    version: '1.0.0',
    monthlyPrice: '0.0000',
    isCore: true,
    screens: [],
  },
];

const APP_BY_CODE = new Map(MARKETPLACE_APPS.map((app) => [app.code, app]));

export function reviewedApp(code: string): MarketplaceApp | undefined {
  return APP_BY_CODE.get(code.trim().toLowerCase());
}

export function assertReviewedApp(code: string): MarketplaceApp {
  const app = reviewedApp(code);
  if (!app) throw new MarketplaceRuleError('UNKNOWN_APP');
  return app;
}

/** الشاشات التي يفتحها تطبيق مفعّل. التطبيق الأساسي لا يخفي شيئاً ولا يُشترط له صف. */
export function enabledScreenHrefs(enabledCodes: readonly string[]): string[] {
  const enabled = new Set(enabledCodes);
  const hrefs = new Set<string>();
  for (const app of MARKETPLACE_APPS) {
    if (app.isCore || enabled.has(app.code)) {
      for (const href of app.screens) hrefs.add(href);
    }
  }
  return [...hrefs];
}

export function gatedScreenHrefs(): string[] {
  return [...new Set(MARKETPLACE_APPS.flatMap((app) => [...app.screens]))];
}

export function screenVisibleForApps(href: string, enabledCodes: readonly string[]): boolean {
  const path = href.split('?')[0] ?? href;
  const gates = MARKETPLACE_APPS.filter((app) => app.screens.includes(path));
  if (gates.length === 0) return true;
  const enabled = new Set(enabledCodes);
  return gates.some((app) => app.isCore || enabled.has(app.code));
}

export type InstalledApp = {
  code: string;
  isEnabled: boolean;
  settings: Record<string, unknown>;
};

/** الإيقاف علمٌ فقط. الإعدادات والمتجر يبقيان. */
export function disableApp(row: InstalledApp): InstalledApp {
  return { code: row.code, isEnabled: false, settings: { ...row.settings } };
}

const DOMAIN_LABEL = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function normaliseDomain(raw: string): string {
  const stripped = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]
    ?.split('?')[0]
    ?.split('#')[0] ?? '';
  const host = (stripped.split(':')[0] ?? '').replace(/\.$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host.split('.').every((label) => /^\d+$/.test(label)) ||
    !DOMAIN_LABEL.test(host)
  ) {
    throw new MarketplaceRuleError('DOMAIN');
  }
  return host;
}

export function verificationTxt(domain: string, token: string): { host: string; value: string } {
  return { host: `_erpcloud-verify.${domain}`, value: `erpcloud-verify=${token}` };
}

export function txtMatches(expected: string, records: readonly string[]): boolean {
  const wanted = expected.trim();
  return records.some((record) => record.trim() === wanted);
}

export type HostDomain = {
  domain: string;
  status: string;
  tenantCode: string;
};

/** الدومين النشط وحده يحدّد المنشأة. المعلّق لا يختطف الاسم. */
export function tenantCodeForHost(host: string, domains: readonly HostDomain[]): string | undefined {
  let normalised: string;
  try {
    normalised = normaliseDomain(host);
  } catch {
    return undefined;
  }
  return domains.find((row) => row.domain === normalised && row.status === 'active')?.tenantCode;
}

export function safeHexColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** جزء الترويسة الذي تثبته الفاتورة المطبوعة. اللون غير السداسي يُسقط ولا يُحقن. */
export function brandMark(logoUrl: string, primaryColor: string): { logoHtml: string; color: string } {
  const color = safeHexColor(primaryColor);
  const logoHtml = logoUrl
    ? `<img class="brand-logo" alt="شعار المنشأة" src="${escapeHtml(logoUrl)}" />`
    : '';
  return { logoHtml, color };
}
