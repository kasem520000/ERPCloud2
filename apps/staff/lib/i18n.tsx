'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Language preference — settings screen «اللغة» in the desktop tree.
 *
 * Scope, stated plainly: the *chrome* (app shell, navigation, login, common states) is
 * fully bilingual and flips the document between RTL and LTR. Screen content is written
 * Arabic-first (it mirrors Arabic source documents), so screens keep their Arabic text in
 * English mode; the navigation labels always follow the selected language because both
 * names live in `lib/navigation.ts`.
 */

export type Lang = 'ar' | 'en';

export const LANGUAGE_STORAGE_KEY = 'erp.lang';

type DictEntry = { ar: string; en: string };

export const STRINGS: Record<string, DictEntry> = {
  'app.name': { ar: 'نظام المحاسبة السحابي', en: 'Cloud Accounting System' },
  'app.tagline': {
    ar: 'محاسبة، مستودعات، مشتريات، مبيعات، رواتب، مراسٍ ومشاريع — بنظام متعدد المنشآت وفوترة إلكترونية متوافقة مع هيئة الزكاة والضريبة.',
    en: 'Accounting, inventory, purchasing, sales, payroll, marinas and projects — multi-tenant with ZATCA-compliant e-invoicing.',
  },
  'app.feature.isolation': { ar: 'عزل كامل لبيانات كل منشأة (RLS على مستوى قاعدة البيانات)', en: 'Full per-tenant data isolation (database-level RLS)' },
  'app.feature.permissions': { ar: 'صلاحيات دقيقة لكل شاشة وكل إجراء', en: 'Fine-grained permissions for every screen and action' },
  'app.feature.audit': { ar: 'سجل تدقيق غير قابل للتعديل', en: 'Tamper-proof audit log' },

  'nav.home': { ar: 'الرئيسية', en: 'Home' },
  'nav.searchPlaceholder': { ar: 'ابحث في الشاشات…', en: 'Search screens…' },
  'nav.logout': { ar: 'تسجيل الخروج', en: 'Sign out' },
  'nav.status.ready': { ar: 'جاهز', en: 'Ready' },
  'nav.status.api': { ar: 'الواجهة البرمجية جاهزة', en: 'API ready' },
  'nav.status.planned': { ar: 'قيد التطوير', en: 'Planned' },
  'nav.coverage': { ar: 'تغطية الشاشات', en: 'Screen coverage' },
  'nav.coverage.hint': {
    ar: 'شاشة تدّعي أنها تعمل فقط عندما تكون جاهزة.',
    en: 'A screen claims to work only when it is ready.',
  },
  'nav.coverage.ready': { ar: 'جاهزة', en: 'ready' },
  'nav.coverage.api': { ar: 'واجهة برمجية جاهزة', en: 'API ready' },
  'nav.coverage.planned': { ar: 'مخطَّطة', en: 'planned' },
  'nav.lang': { ar: 'اللغة', en: 'Language' },
  'nav.lang.ar': { ar: 'العربية', en: 'Arabic' },
  'nav.lang.en': { ar: 'الإنجليزية', en: 'English' },
  'theme.label': { ar: 'مظهر الواجهة', en: 'Appearance' },

  'login.title': { ar: 'تسجيل الدخول', en: 'Sign in' },
  'login.subtitle': { ar: 'لوحة تحكم المنشأة وموظفيها.', en: 'Tenant back office for staff.' },
  'login.joined': { ar: 'تم إنشاء منشأتك. سجّل الدخول ببيانات المالك للبدء.', en: 'Your tenant was created. Sign in with the owner credentials to start.' },
  'login.tenantCode': { ar: 'رمز المنشأة', en: 'Tenant code' },
  'login.email': { ar: 'البريد الإلكتروني', en: 'E-mail' },
  'login.password': { ar: 'كلمة المرور', en: 'Password' },
  'login.submit': { ar: 'دخول', en: 'Sign in' },
  'login.busy': { ar: 'جارٍ الدخول…', en: 'Signing in…' },
  'login.signup': { ar: 'ليس لديك حساب؟ اشترك الآن', en: 'No account? Sign up' },
  'login.error.invalid': { ar: 'بيانات الدخول غير صحيحة. تحقق من رمز المنشأة والبريد وكلمة المرور.', en: 'Invalid credentials. Check the tenant code, e-mail and password.' },
  'login.error.suspended': { ar: 'الاشتراك موقوف. تواصل مع إدارة المنصة لتفعيل الحساب.', en: 'Subscription suspended. Contact platform administration to activate the account.' },
  'login.error.rateLimited': { ar: 'محاولات كثيرة. انتظر دقيقة ثم أعد المحاولة.', en: 'Too many attempts. Wait a minute and try again.' },
  'login.error.unreachable': { ar: 'تعذر الاتصال بالخادم. تأكد من تشغيل الـ API وضبط API_PROXY_TARGET في ملف .env', en: 'Could not reach the server. Make sure the API is running and API_PROXY_TARGET is set in .env' },

  'mfa.title': { ar: 'رمز التحقق', en: 'Verification code' },
  'mfa.hint': { ar: 'أدخل الرمز المكوَّن من 6 أرقام من تطبيق المصادقة، أو رمز استرداد لم يُستخدم من قبل.', en: 'Enter the 6-digit code from your authenticator app, or an unused recovery code.' },
  'mfa.code': { ar: 'رمز التحقق', en: 'Verification code' },
  'mfa.verify': { ar: 'تحقق', en: 'Verify' },
  'mfa.verifying': { ar: 'جارٍ التحقق…', en: 'Verifying…' },
  'mfa.back': { ar: 'رجوع', en: 'Back' },
  'mfa.error.invalid': { ar: 'الرمز غير صحيح. تحقق من التطبيق وأعد المحاولة.', en: 'Invalid code. Check your authenticator and try again.' },

  'common.loading': { ar: 'جارٍ التحميل…', en: 'Loading…' },
  'common.retry': { ar: 'إعادة المحاولة', en: 'Retry' },
  'common.copy': { ar: 'نسخ', en: 'Copy' },
  'common.copied': { ar: 'تم النسخ', en: 'Copied' },
  'common.save': { ar: 'حفظ', en: 'Save' },
  'common.cancel': { ar: 'إلغاء', en: 'Cancel' },
};

export function translate(key: string, lang: Lang): string {
  return STRINGS[key]?.[lang] ?? key;
}

export function dirFor(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

type LangContextValue = {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
};

const LangContext = createContext<LangContextValue | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('ar');

  // The stored preference wins; read after mount so SSR and the first paint stay Arabic/RTL.
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
    if (stored === 'en' || stored === 'ar') setLangState(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    setLangState(next);
  }, []);

  const value = useMemo<LangContextValue>(
    () => ({ lang, dir: dirFor(lang), setLang, t: (key: string) => translate(key, lang) }),
    [lang, setLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const context = useContext(LangContext);
  if (!context) throw new Error('useLang must be used inside <LanguageProvider>');
  return context;
}
