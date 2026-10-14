'use client';

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * حقول بخانة عائمة (floating label) — التسمية تتقلص فوق الإطار عند التركيز أو التعبئة.
 * التكنيك: `:placeholder-shown` عبر `group-has`، فلا حاجة إلى state لكل حقل.
 * الحقول النصية تحمل `placeholder=" "` افتراضياً.
 */
const BASE_LABEL =
  'pointer-events-none absolute start-3 bg-surface px-1 rounded-sm transition-all duration-150 ease-out select-none';

/** Resting (centered) → shrunk (top) on focus or when the control has content. */
const INPUT_LABEL =
  `${BASE_LABEL} top-1/2 -translate-y-1/2 text-[13px] text-muted ` +
  `group-has-[input:focus]/field:top-0 group-has-[input:focus]/field:-translate-y-1/2 group-has-[input:focus]/field:text-[11px] group-has-[input:focus]/field:font-bold group-has-[input:focus]/field:text-brand-600 ` +
  `group-has-[input:not(:placeholder-shown)]/field:top-0 group-has-[input:not(:placeholder-shown)]/field:-translate-y-1/2 group-has-[input:not(:placeholder-shown)]/field:text-[11px] group-has-[input:not(:placeholder-shown)]/field:font-bold`;

const TEXTAREA_LABEL =
  `${BASE_LABEL} top-5 text-[13px] text-muted ` +
  `group-has-[textarea:focus]/field:top-1.5 group-has-[textarea:focus]/field:text-[11px] group-has-[textarea:focus]/field:font-bold group-has-[textarea:focus]/field:text-brand-600 ` +
  `group-has-[textarea:not(:placeholder-shown)]/field:top-1.5 group-has-[textarea:not(:placeholder-shown)]/field:text-[11px] group-has-[textarea:not(:placeholder-shown)]/field:font-bold`;

/** A select always shows a value, so its label always sits shrunken at the top. */
const SELECT_LABEL =
  `${BASE_LABEL} top-0 -translate-y-1/2 text-[11px] font-bold ` +
  `group-has-[select:focus]/field:text-brand-600`;

const FRAME = (error?: string) =>
  `w-full h-10 ps-9 pe-3 rounded-[10px] border bg-surface text-[13.5px] text-ink transition-all duration-150 ease-out focus:outline-none ${
    error
      ? 'border-danger-line shadow-[var(--ring-danger)]'
      : 'border-line-strong focus:border-brand-600 focus:shadow-[var(--ring-brand)]'
  }`;

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
};

export function Input({ label, error, hint, className = '', placeholder, ...rest }: InputProps) {
  const id = useId();
  return (
    <div className="grid gap-1 min-w-0">
      <div className="relative group/field">
        <input
          id={id}
          placeholder={placeholder ?? ' '}
          className={FRAME(error) + ` ${className}`}
          aria-invalid={error ? 'true' : undefined}
          {...rest}
        />
        <label htmlFor={id} className={INPUT_LABEL}>
          {label}
        </label>
      </div>
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
  hint?: string;
  /** Optional first option; when given it is selectable as "all". */
  placeholder?: string;
};

export function Select({ label, error, hint, placeholder, className = '', children, ...rest }: SelectProps) {
  const id = useId();
  return (
    <div className="grid gap-1 min-w-0">
      <div className="relative group/field">
        <select
          id={id}
          className={`${FRAME(error)} appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%2364748b%22%20stroke-width%3D%222.5%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:0.85rem_center] pe-9 ${className}`}
          aria-invalid={error ? 'true' : undefined}
          {...rest}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {children}
        </select>
        <label htmlFor={id} className={SELECT_LABEL}>
          {label}
        </label>
      </div>
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string;
  hint?: string;
};

export function Textarea({ label, error, hint, className = '', placeholder, ...rest }: TextareaProps) {
  const id = useId();
  return (
    <div className="grid gap-1 min-w-0">
      <div className="relative group/field">
        <textarea
          id={id}
          placeholder={placeholder ?? ' '}
          className={`w-full min-h-28 ps-9 pe-3 pt-6 pb-2 rounded-[10px] border bg-surface text-[13.5px] text-ink transition-all duration-150 ease-out focus:outline-none ${
            error
              ? 'border-danger-line shadow-[var(--ring-danger)]'
              : 'border-line-strong focus:border-brand-600 focus:shadow-[var(--ring-brand)]'
          } ${className}`}
          aria-invalid={error ? 'true' : undefined}
          {...rest}
        />
        <label htmlFor={id} className={TEXTAREA_LABEL}>
          {label}
        </label>
      </div>
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

function FieldMessage({ error, hint }: { error?: string; hint?: string }) {
  if (error) return <p className="m-0 text-xs font-semibold text-danger">{error}</p>;
  if (hint) return <p className="m-0 text-xs text-muted">{hint}</p>;
  return null;
}

/** تسمية ثابتة (غير عائمة) فوق حقل إرثي. */
export function Labeled({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid gap-1.5 min-w-0">
      <span className="text-xs font-bold text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}
