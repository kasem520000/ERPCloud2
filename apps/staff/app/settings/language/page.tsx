'use client';

import { motion } from 'framer-motion';
import { Check, Languages } from 'lucide-react';

import { Screen } from '../../../components/screen';
import { useLang, type Lang } from '../../../lib/i18n';

/**
 * اللغة — the desktop tree's language screen.
 *
 * The preference is stored locally (localStorage) and flips the whole document between
 * RTL/Arabic and LTR/English. The chrome follows it immediately; the navigation labels
 * switch too, because every screen carries both names. Individual screens remain
 * Arabic-first (they mirror Arabic source documents) — see `lib/i18n.tsx`.
 */
export default function LanguagePage() {
  const { lang, setLang, dir } = useLang();

  const option = (value: Lang, titleAr: string, titleEn: string, detail: string, flag: string) => {
    const active = lang === value;
    return (
      <motion.button
        type="button"
        onClick={() => setLang(value)}
        initial={false}
        animate={{ scale: active ? 1 : 1 }}
        className={`relative w-full rounded-xl border p-4 text-start transition-all duration-150 ease-out cursor-pointer ${
          active
            ? 'border-brand-600 bg-brand-50/50 shadow-3 ring-1 ring-brand-600'
            : 'border-line bg-surface hover:border-line-strong hover:shadow-2'
        }`}
        dir={dir}
      >
        {active ? (
          <span className="absolute top-3 end-3 grid place-items-center size-6 rounded-full bg-brand-600 text-on-accent">
            <Check size={14} strokeWidth={3} />
          </span>
        ) : null}
        <div className="flex items-center gap-3">
          <span className="grid place-items-center size-11 rounded-xl bg-surface-3 text-2xl flex-none">{flag}</span>
          <div className="min-w-0">
            <p className="m-0 text-[15px] font-bold text-ink">
              {titleAr} <span className="text-muted font-semibold">· {titleEn}</span>
            </p>
            <p className="m-0 mt-1 text-[12.5px] text-muted leading-snug">{detail}</p>
          </div>
        </div>
      </motion.button>
    );
  };

  return (
    <Screen title="اللغة" subtitle="Language" crumbs={['الإعدادات', 'عامة']}>
      <section className="rounded-xl border border-line bg-surface p-4 shadow-1">
        <div className="flex items-center gap-2 mb-3">
          <span className="grid place-items-center size-8 rounded-lg bg-brand-50 text-brand-600">
            <Languages size={16} />
          </span>
          <h3 className="m-0 text-[15px] font-bold text-ink">اختر لغة الواجهة</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {option('ar', 'العربية', 'Arabic', 'اتجاه الكتابة من اليمين إلى اليسار (RTL). هذا هو الوضع الافتراضي للنظام.', '🇸🇦')}
          {option('en', 'الإنجليزية', 'English', 'Left-to-right (LTR). Shell, menus and the login screen switch; screen content stays Arabic-first.', '🇬🇧')}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4 shadow-1">
        <h3 className="m-0 text-[15px] font-bold text-ink mb-2">{lang === 'ar' ? 'معاينة' : 'Preview'}</h3>
        <p className="m-0 text-[13.5px] text-ink-2">
          {lang === 'ar'
            ? 'هكذا تظهر النصوص العامة في النظام: الرئيسية، تسجيل الخروج، رسائل الدخول، وحالات الشاشات.'
            : 'This is how shared chrome text renders: Home, Sign out, login messages and screen states.'}
        </p>
        <p
          className="m-0 mt-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-[13px] font-semibold text-brand-800"
          role="note"
        >
          {lang === 'ar'
            ? 'تنطبق اللغة على واجهة النظام العامة وقوائم التنقل وشاشة الدخول، بينما تبقى بيانات المستندات والتقارير بلغتها الأصلية.'
            : 'The preference applies to the shared chrome, navigation and login screen; document and report content keeps its original language.'}
        </p>
      </section>
    </Screen>
  );
}
