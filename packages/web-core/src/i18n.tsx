'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * i18n primitives shared by every frontend. Each app owns its dictionary (the strings are
 * product content, not infrastructure), and builds its provider from this factory — the
 * factory closes over the dictionary so both apps get the same bilingual + RTL/LTR
 * behaviour, storage key, and fallback-to-key semantics without sharing a translation
 * file. Extracted verbatim in behavior from the staff console's `lib/i18n.tsx` (M2).
 */

export type Lang = 'ar' | 'en';

export type DictEntry = { ar: string; en: string };

export const LANGUAGE_STORAGE_KEY = 'erp.lang';

export function dirFor(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

type LangContextValue = {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
};

export type I18nInstance = {
  translate: (key: string, lang: Lang) => string;
  LanguageProvider: (props: { children: ReactNode }) => React.JSX.Element;
  useLang: () => LangContextValue;
};

export function createI18n(strings: Record<string, DictEntry>): I18nInstance {
  const translate = (key: string, lang: Lang): string => strings[key]?.[lang] ?? key;

  const LangContext = createContext<LangContextValue | undefined>(undefined);

  function LanguageProvider({ children }: { children: ReactNode }) {
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

  function useLang(): LangContextValue {
    const context = useContext(LangContext);
    if (!context) throw new Error('useLang must be used inside <LanguageProvider>');
    return context;
  }

  return { translate, LanguageProvider, useLang };
}
