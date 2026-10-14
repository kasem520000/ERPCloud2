'use client';

import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme } from './theme-provider';
import { nextThemeChoice, type ThemeChoice } from './theme';

/**
 * The one theme switch, shared by staff, platform-admin and marketing
 * (Design v3 §5 — "ThemeToggle موحد رمزًا وسلوكًا").
 *
 * Two shapes, identical behaviour:
 *   `variant="segmented"` (default) — three explicit choices, so «تتبع النظام»
 *     is never hidden inside a cycle. This is what a console and a back
 *     office use, where the visitor wants to *know* what will happen.
 *   `variant="icon"` — one button that cycles light → dark → system. Smaller,
 *     for a marketing navbar that already carries a lot.
 *
 * Both are real `<button>`s with an Arabic `aria-label`, a visible focus
 * ring, and a `disabled` state that stays on screen instead of disappearing.
 */
export type ThemeToggleProps = {
  variant?: 'segmented' | 'icon';
  /** Render at a smaller size (marketing navbar on narrow screens). */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  /** Labels are Arabic by default; pass `lang="en"` for the English surfaces. */
  lang?: 'ar' | 'en';
};

const LABELS: Record<ThemeChoice, { ar: string; en: string }> = {
  light: { ar: 'الوضع الفاتح', en: 'Light' },
  dark: { ar: 'الوضع الداكن', en: 'Dark' },
  system: { ar: 'تتبّع النظام', en: 'System' },
};

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

function label(choice: ThemeChoice, lang: 'ar' | 'en'): string {
  return LABELS[choice][lang];
}

export function ThemeToggle({
  variant = 'segmented',
  compact = false,
  disabled = false,
  className = '',
  lang = 'ar',
}: ThemeToggleProps) {
  const { choice, setChoice, resolved } = useTheme();

  if (variant === 'icon') {
    const current = choice === 'system' ? 'system' : resolved;
    const Icon = ICONS[current];
    const text = label(choice, lang);
    return (
      <button
        type="button"
        onClick={() => setChoice(nextThemeChoice(choice))}
        disabled={disabled}
        aria-label={text}
        title={text}
        data-theme-choice={choice}
        className={`grid size-9 place-items-center rounded-[10px] border border-line bg-surface text-muted transition-colors duration-150 ease-out hover:bg-surface-3 hover:text-ink focus-visible:ring-4 focus-visible:ring-brand-600/20 disabled:cursor-not-allowed disabled:opacity-55 ${className}`}
      >
        <Icon size={17} strokeWidth={2} aria-hidden />
      </button>
    );
  }

  const options: ThemeChoice[] = ['light', 'dark', 'system'];
  return (
    <div
      role="radiogroup"
      aria-label={lang === 'ar' ? 'مظهر الواجهة' : 'Appearance'}
      data-theme-choice={choice}
      className={`inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-surface-2 p-0.5 ${className}`}
    >
      {options.map((option) => {
        const Icon = ICONS[option];
        const active = choice === option;
        const text = label(option, lang);
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={text}
            title={text}
            disabled={disabled}
            onClick={() => setChoice(option)}
            className={`grid place-items-center rounded-[8px] transition-colors duration-150 ease-out focus-visible:ring-4 focus-visible:ring-brand-600/20 disabled:cursor-not-allowed disabled:opacity-55 ${
              compact ? 'size-7' : 'size-8'
            } ${active ? 'bg-surface text-brand shadow-1' : 'text-muted hover:text-ink'}`}
          >
            <Icon size={compact ? 14 : 15} strokeWidth={2} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
