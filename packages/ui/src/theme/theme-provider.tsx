'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  applyTheme,
  readThemeChoice,
  resolveTheme,
  systemPrefersDark,
  THEME_EVENT,
  THEME_STORAGE_KEY,
  themeInitScript,
  writeThemeChoice,
  type ResolvedTheme,
  type ThemeChoice,
} from './theme';

type ThemeContextValue = {
  /** What the visitor asked for (`system` follows the OS). */
  choice: ThemeChoice;
  /** What is painted right now. */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  /** Convenience for a two-state switch. */
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export type ThemeProviderProps = {
  children: ReactNode;
  /**
   * The choice used when nothing is stored yet. `system` for staff and
   * marketing, `dark` for the platform console (Design v3 §2.1).
   */
  defaultChoice?: ThemeChoice;
};

/**
 * Owns the single `erp.theme` value for a whole surface.
 *
 * It listens to three things so the answer can never drift between tabs or
 * between the pre-hydration script and React: the `erp:theme-change` event,
 * the `storage` event (another tab), and the OS `prefers-color-scheme`
 * change that matters while the choice is `system`.
 */
export function ThemeProvider({ children, defaultChoice = 'system' }: ThemeProviderProps) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice(defaultChoice));
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  // Keep the OS listener in sync; only meaningful while choice === 'system'.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(choice, prefersDark);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // A second tab (or the pre-hydration script) may have changed the answer.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onThemeEvent = (event: Event) => {
      const detail = (event as CustomEvent<ThemeChoice>).detail;
      if (detail === 'light' || detail === 'dark' || detail === 'system') setChoiceState(detail);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      setChoiceState(readThemeChoice(defaultChoice));
    };
    window.addEventListener(THEME_EVENT, onThemeEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, onThemeEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, [defaultChoice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    writeThemeChoice(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      choice,
      resolved,
      setChoice,
      toggle: () => setChoice(resolved === 'dark' ? 'light' : 'dark'),
    }),
    [choice, resolved, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the theme. Throws outside a provider on purpose: a silent default
 * here is how two mechanisms end up in one app (§2.2.1).
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}

/**
 * The blocking `<head>` script. Rendered once per surface, before hydration.
 */
export function ThemeScript({ defaultChoice = 'system' }: { defaultChoice?: ThemeChoice }) {
  return (
    // A static, build-time string with no user input in it — the whole point of
    // the pre-hydration script is that it is a fixed few hundred bytes.
    <script dangerouslySetInnerHTML={{ __html: themeInitScript(defaultChoice) }} data-theme-init="" />
  );
}
