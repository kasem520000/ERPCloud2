'use client';

import { createI18n, dirFor, LANGUAGE_STORAGE_KEY, type DictEntry, type Lang } from '@erp/web-core/i18n';

/**
 * M3 — the accounting app's dictionary over the shared `createI18n` factory
 * (`@erp/web-core/i18n`). Bilingual chrome + RTL/LTR flip; the accounting content
 * itself is Arabic-first (it mirrors Arabic source documents).
 */

export type { DictEntry, Lang };
export { dirFor, LANGUAGE_STORAGE_KEY };

export const STRINGS: Record<string, DictEntry> = {
  'app.name': { ar: 'تطبيق المحاسبة', en: 'Accounting App' },
  'app.tagline': {
    ar: 'دليل الحسابات، القيود، الفترات، التقارير ومكتب الزكاة والضريبة — واجهة المحاسب المخصصة.',
    en: 'Chart of accounts, journals, periods, statements and the ZATCA desk — the accountant-focused surface.',
  },

  'nav.home': { ar: 'الرئيسية', en: 'Home' },
  'nav.accounts': { ar: 'دليل الحسابات', en: 'Chart of accounts' },
  'nav.journals': { ar: 'القيود اليومية', en: 'Journal register' },
  'nav.periods': { ar: 'الفترات المالية', en: 'Fiscal periods' },
  'nav.trialBalance': { ar: 'ميزان المراجعة', en: 'Trial balance' },
  'nav.incomeStatement': { ar: 'قائمة الدخل', en: 'Income statement' },
  'nav.costCenters': { ar: 'مراكز التكلفة', en: 'Cost centres' },
  'nav.zatca': { ar: 'مكتب الزكاة والضريبة', en: 'ZATCA desk' },
  'nav.lang': { ar: 'اللغة', en: 'Language' },
  'nav.logout': { ar: 'تسجيل الخروج', en: 'Sign out' },

  'login.title': { ar: 'تسجيل الدخول', en: 'Sign in' },
  'login.subtitle': { ar: 'واجهة المحاسب — بيانات منشأتك كما هي.', en: 'The accountant surface — your tenant data, as it stands.' },
  'login.tenantCode': { ar: 'رمز المنشأة', en: 'Tenant code' },
  'login.email': { ar: 'البريد الإلكتروني', en: 'E-mail' },
  'login.password': { ar: 'كلمة المرور', en: 'Password' },
  'login.submit': { ar: 'دخول', en: 'Sign in' },
  'login.busy': { ar: 'جارٍ الدخول…', en: 'Signing in…' },
  'login.error.invalid': { ar: 'بيانات الدخول غير صحيحة.', en: 'Invalid credentials.' },
  'login.error.suspended': { ar: 'الاشتراك موقوف. تواصل مع إدارة المنصة.', en: 'Subscription suspended. Contact platform administration.' },
  'login.error.rateLimited': { ar: 'محاولات كثيرة. انتظر دقيقة ثم أعد المحاولة.', en: 'Too many attempts. Wait a minute and try again.' },
  'login.error.generic': { ar: 'تعذر الاتصال بالخادم. تأكد من تشغيل الـ API.', en: 'Could not reach the server. Make sure the API is running.' },

  'mfa.title': { ar: 'رمز التحقق', en: 'Verification code' },
  'mfa.hint': { ar: 'أدخل الرمز المكوَّن من 6 أرقام من تطبيق المصادقة.', en: 'Enter the 6-digit code from your authenticator app.' },
  'mfa.code': { ar: 'رمز التحقق', en: 'Verification code' },
  'mfa.verify': { ar: 'تحقق', en: 'Verify' },
  'mfa.error.invalid': { ar: 'الرمز غير صحيح. تحقق من التطبيق وأعد المحاولة.', en: 'Invalid code. Check your authenticator and try again.' },

  'common.loading': { ar: 'جارٍ التحميل…', en: 'Loading…' },
  'common.retry': { ar: 'إعادة المحاولة', en: 'Retry' },
  'common.error': { ar: 'تعذر تحميل البيانات', en: 'Could not load the data' },
  'common.forbidden': { ar: 'لا تملك صلاحية عرض هذه الشاشة.', en: 'You do not have permission to view this screen.' },
  'common.empty': { ar: 'لا توجد بيانات لعرضها.', en: 'Nothing to show yet.' },
  'common.readonly': { ar: 'قراءة فقط', en: 'Read-only' },

  'entitlement.title': { ar: 'التطبيق غير مفعّل لهذه المنشأة', en: 'This app is not enabled for your tenant' },
  'entitlement.body': {
    ar: 'تطبيق المحاسبة مشحون مع النظام لكن يمكن لمشغّل المنصة تعطيله لمنشأتك. تواصل مع إدارة المنصة أو فعّله من لوحة التحكم (السوق ← الإضافات).',
    en: 'The accounting app ships with the system, but a platform operator can disable it per tenant. Contact platform administration or enable it from the staff panel (Marketplace).',
  },
};

const i18n = createI18n(STRINGS);

export const translate = i18n.translate;
export const LanguageProvider = i18n.LanguageProvider;
export const useLang = i18n.useLang;
