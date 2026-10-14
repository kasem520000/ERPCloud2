/**
 * Theme resolution — the one mechanism shared by staff, platform-admin and
 * marketing (Design v3 §2.2.1).
 *
 * Storage: a single `localStorage` key, `erp.theme`, holding
 * `light | dark | system`. There are deliberately **no** per-app or
 * per-context sub-keys (§8.11) — switching the theme on one surface and
 * opening another must not produce two answers.
 */

/** The one storage key. Never fork it. */
export const THEME_STORAGE_KEY = 'erp.theme';

/** What the visitor asked for. */
export type ThemeChoice = 'light' | 'dark' | 'system';

/** What the page is actually painted with. */
export type ResolvedTheme = 'light' | 'dark';

/** Event dispatched on `window` whenever the stored choice changes. */
export const THEME_EVENT = 'erp:theme-change';

const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

/** `localStorage` is absent in SSR, in private modes that block it, and in
 *  some embedded webviews — every read below is therefore defensive. */
function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value);
}

export function readThemeChoice(fallback: ThemeChoice = 'system'): ThemeChoice {
  const storage = safeStorage();
  if (!storage) return fallback;
  const stored = storage.getItem(THEME_STORAGE_KEY);
  return isThemeChoice(stored) ? stored : fallback;
}

export function writeThemeChoice(choice: ThemeChoice): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* a full or blocked storage must not break the toggle */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ThemeChoice>(THEME_EVENT, { detail: choice }));
  }
}

/** Resolve `system` against the OS preference. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Paint the document. The class goes on `<html>` so a portal, a dialog or a
 * toast rendered at the body root still inherits the flip.
 */
export function applyTheme(resolved: ResolvedTheme, root?: HTMLElement): void {
  const element = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!element) return;
  element.classList.toggle('dark', resolved === 'dark');
  element.style.colorScheme = resolved;
  element.dataset.theme = resolved;
}

/** Cycle light → dark → system → light, for the compact icon toggle. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  const order: ThemeChoice[] = ['light', 'dark', 'system'];
  const index = order.indexOf(choice);
  return order[(index + 1) % order.length] ?? 'system';
}

/**
 * The blocking micro-script that runs in `<head>` before React hydrates
 * (§2.2.3). It is a few hundred bytes, has no dependency on the bundle, and
 * exists for exactly one reason: a visitor in dark mode must never see a
 * white flash. It also removes a `dark` class left over by a previous paint
 * when the stored choice is light.
 */
export function themeInitScript(fallback: ThemeChoice = 'system'): string {
  return (
    `(function(){try{` +
    `var k=${JSON.stringify(THEME_STORAGE_KEY)};` +
    `var v=null;try{v=window.localStorage.getItem(k)}catch(e){}` +
    `if(v!=='light'&&v!=='dark'&&v!=='system'){v=${JSON.stringify(fallback)}}` +
    `var d=v==='dark'||(v==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);` +
    `var r=document.documentElement;` +
    `r.classList.toggle('dark',d);` +
    `r.style.colorScheme=d?'dark':'light';` +
    `r.dataset.theme=d?'dark':'light';` +
    `}catch(e){}})();`
  );
}
