'use client';

import { ChevronDown, Search, X } from 'lucide-react';
import {
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

import { cn } from '../lib/cn';
import { toWesternDigits } from '../lib/format';

/**
 * Input / Select / Combobox / MoneyField / DateRangePicker.
 *
 * Shared rules (Design v3 §4–§5):
 *   • `h-9` control height (`--control-h`), token borders, token focus ring.
 *   • RTL-first: the label sits above the field and every icon is placed with
 *     logical properties (`start-3` / `end-3`), so an `<html dir="ltr">` page
 *     mirrors without a single extra rule.
 *   • `disabled` is greyed and *kept* — the POS price field for a cashier
 *     without `pos.priceoverride` says «لا يمكن تعديل السعر» instead of
 *     vanishing (staff R4).
 *   • digits are always Western and always Inter (`.num`).
 */

const FIELD_BASE =
  'h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-[13.5px] text-ink ' +
  'transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-muted ' +
  'hover:border-line-raised focus:border-brand focus:ring-4 focus:ring-brand/20 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-3 disabled:text-muted ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/20';

function FieldShell({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
  className = '',
  /** Extra node rendered at the far end of the label row (a «حدّك: …» note). */
  note,
}: {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor: string;
  children: ReactNode;
  className?: string;
  note?: ReactNode;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      {label || note ? (
        <div className="flex items-baseline justify-between gap-2">
          {label ? (
            <label htmlFor={htmlFor} className="text-[12.5px] font-bold text-ink-2">
              {label}
              {required ? <span className="text-danger"> *</span> : null}
            </label>
          ) : (
            <span />
          )}
          {note ? <span className="text-[11.5px] text-muted">{note}</span> : null}
        </div>
      ) : null}
      {children}
      {error ? (
        <p className="m-0 text-[11.5px] font-semibold text-danger">{error}</p>
      ) : hint ? (
        <p className="m-0 text-[11.5px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Leading icon, placed on the inline-start edge. */
  icon?: ReactNode;
  /** Trailing node — a unit, a currency code, a «حدّك» note. */
  suffix?: ReactNode;
  /** Show a clear button when the field has a value. */
  clearable?: boolean;
  onClear?: () => void;
  className?: string;
  wrapperClassName?: string;
  note?: string;
};

export function Input({
  label,
  hint,
  error,
  icon,
  suffix,
  clearable = false,
  onClear,
  className = '',
  wrapperClassName = '',
  note,
  id,
  value,
  ...rest
}: InputProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hasValue = value !== undefined && value !== null && String(value).length > 0;

  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      required={rest.required}
      htmlFor={fieldId}
      className={wrapperClassName}
      note={note}
    >
      <div className="relative">
        {icon ? (
          <span className="pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-muted">
            {icon}
          </span>
        ) : null}
        <input
          id={fieldId}
          value={value}
          aria-invalid={error ? true : undefined}
          className={cn(
            FIELD_BASE,
            icon && 'ps-9',
            suffix && 'pe-16',
            clearable && hasValue && 'pe-9',
            className,
          )}
          {...rest}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 end-3 grid place-items-center text-[11.5px] font-bold text-muted">
            {suffix}
          </span>
        ) : null}
        {clearable && hasValue ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="مسح الحقل"
            className="absolute inset-y-0 end-2 grid place-items-center rounded-sm px-1 text-muted hover:text-ink"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
    </FieldShell>
  );
}

/** A search box with the magnifier built in and an Arabic placeholder. */
export function SearchInput({
  label,
  placeholder = 'بحث…',
  className = '',
  ...rest
}: Omit<InputProps, 'icon' | 'suffix'>) {
  return (
    <Input
      label={label}
      placeholder={placeholder}
      icon={<Search size={15} />}
      clearable
      className={className}
      {...rest}
    />
  );
}

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  label?: string;
  hint?: string;
  error?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  /** An empty first option, e.g. «— اختر —». */
  placeholder?: string;
  className?: string;
  wrapperClassName?: string;
  note?: string;
};

export function Select({
  label,
  hint,
  error,
  options,
  placeholder,
  className = '',
  wrapperClassName = '',
  note,
  id,
  ...rest
}: SelectProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      required={rest.required}
      htmlFor={fieldId}
      className={wrapperClassName}
      note={note}
    >
      <div className="relative">
        <select
          id={fieldId}
          aria-invalid={error ? true : undefined}
          className={cn(FIELD_BASE, 'appearance-none pe-9', className)}
          {...rest}
        >
          {placeholder ? <option value="">{placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={15}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 end-3 my-auto text-muted"
        />
      </div>
    </FieldShell>
  );
}

export type ComboboxOption = {
  value: string;
  label: string;
  /** Secondary line — a code, a phone, a balance. */
  hint?: string;
  disabled?: boolean;
};

export type ComboboxProps = {
  label?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  wrapperClassName?: string;
  /** Rendered above the list while it is open. */
  emptyLabel?: string;
  id?: string;
};

/**
 * Combobox — the Arabic-search picker (Design v3 §5).
 *
 * Matches on the Arabic *and* the Latin label, and on the hint, so typing
 * «عم» finds «عميل نقدي» and typing a code finds the same row. Arabic
 * normalisation (alef/hamza, ta marbuta, diacritics) is applied to both sides
 * so «احمد» matches «أحمد».
 */
export function normalizeArabic(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/^\s+|\s+$/g, '');
}

export function Combobox({
  label,
  hint,
  error,
  placeholder = 'اختر…',
  options,
  value,
  onChange,
  disabled = false,
  className = '',
  wrapperClassName = '',
  emptyLabel = 'لا نتائج',
  id,
}: ComboboxProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const needle = normalizeArabic(query);
    if (!needle) return options.slice(0, 60);
    return options
      .filter((option) =>
        [option.label, option.hint ?? '', option.value].some((field) =>
          normalizeArabic(field).includes(needle),
        ),
      )
      .slice(0, 60);
  }, [options, query]);

  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      htmlFor={fieldId}
      className={wrapperClassName}
    >
      <div className="relative" ref={rootRef}>
        <input
          id={fieldId}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${fieldId}-listbox`}
          aria-autocomplete="list"
          disabled={disabled}
          value={open ? query : (selected?.label ?? '')}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
          className={cn(FIELD_BASE, 'pe-9', className)}
        />
        <ChevronDown
          size={15}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 end-3 my-auto text-muted"
        />
        {open ? (
          <ul
            id={`${fieldId}-listbox`}
            role="listbox"
            className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-raised py-1 shadow-4"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-[12.5px] text-muted">{emptyLabel}</li>
            ) : (
              filtered.map((option) => (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onChange(option.value);
                      setQuery('');
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-[13px] transition-colors duration-150',
                      option.value === value
                        ? 'bg-brand-soft font-bold text-brand'
                        : 'text-ink hover:bg-surface-3',
                      option.disabled && 'cursor-not-allowed opacity-55',
                    )}
                  >
                    <span className="truncate">{option.label}</span>
                    {option.hint ? (
                      <span className="num flex-none text-[11.5px] text-muted">{option.hint}</span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
    </FieldShell>
  );
}

export type MoneyFieldProps = {
  label?: string;
  hint?: string;
  error?: string;
  /** Decimal string, e.g. `'1250.50'`. Never a `number` (§3 money rule). */
  value: string;
  onChange: (value: string) => void;
  currency?: string;
  disabled?: boolean;
  className?: string;
  wrapperClassName?: string;
  /** «حدّك: …» beside the label — the desktop's notice, not the enforcement. */
  note?: string;
  id?: string;
  placeholder?: string;
};

const MONEY_PATTERN = /^-?\d*\.?\d*$/;

/**
 * MoneyField — an amount box that stays LTR inside an RTL page.
 *
 * The *page* stays RTL; only the field's text runs left-to-right, because
 * «1250.50 ر.س» read the other way round is a different number. Every
 * keystroke is filtered to digits and one dot and re-normalised to Western
 * digits, so an Arabic keyboard can never put `٥` into the ledger.
 */
export function MoneyField({
  label,
  hint,
  error,
  value,
  onChange,
  currency = 'ر.س',
  disabled = false,
  className = '',
  wrapperClassName = '',
  note,
  id,
  placeholder = '0.00',
}: MoneyFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      htmlFor={fieldId}
      className={wrapperClassName}
      note={note}
    >
      <div className="relative" dir="ltr">
        <input
          id={fieldId}
          inputMode="decimal"
          dir="ltr"
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            const next = toWesternDigits(event.target.value).replace(/,/g, '');
            if (next === '' || MONEY_PATTERN.test(next)) onChange(next);
          }}
          onBlur={(event) => {
            const raw = event.target.value.trim();
            if (!raw || raw === '.' || raw === '-') return;
            const [integer = '', fraction] = raw.split('.');
            const normalized = fraction === undefined ? integer : `${integer}.${fraction.slice(0, 4)}`;
            if (normalized !== raw) onChange(normalized);
          }}
          className={cn(FIELD_BASE, 'num pe-14 text-end', className)}
        />
        <span className="pointer-events-none absolute inset-y-0 end-3 grid place-items-center text-[11.5px] font-bold text-muted">
          {currency}
        </span>
      </div>
    </FieldShell>
  );
}

export type DateRange = { from: string; to: string };

export type DateRangePickerProps = {
  label?: string;
  from: string;
  to: string;
  onChange: (range: DateRange) => void;
  disabled?: boolean;
  className?: string;
  wrapperClassName?: string;
  hint?: string;
  fromLabel?: string;
  toLabel?: string;
};

/**
 * DateRangePicker — two native date inputs.
 *
 * Native inputs are deliberate: they give the platform's own calendar (which
 * is already RTL-aware and keyboard-operable) for free, and they keep the
 * bundle small — Design v3 §4 prefers the platform's answer over a re-invented
 * one.
 */
export function DateRangePicker({
  label,
  from,
  to,
  onChange,
  disabled = false,
  className = '',
  wrapperClassName = '',
  hint,
  fromLabel = 'من',
  toLabel = 'إلى',
}: DateRangePickerProps) {
  return (
    <div className={cn('grid gap-1.5', wrapperClassName)}>
      {label ? <span className="text-[12.5px] font-bold text-ink-2">{label}</span> : null}
      <div className={cn('flex items-center gap-2', className)}>
        <input
          type="date"
          aria-label={fromLabel}
          disabled={disabled}
          value={from}
          max={to || undefined}
          onChange={(event) => onChange({ from: event.target.value, to })}
          className={cn(FIELD_BASE, 'num flex-1')}
        />
        <span className="flex-none text-[12px] text-muted">{toLabel}</span>
        <input
          type="date"
          aria-label={toLabel}
          disabled={disabled}
          value={to}
          min={from || undefined}
          onChange={(event) => onChange({ from, to: event.target.value })}
          className={cn(FIELD_BASE, 'num flex-1')}
        />
      </div>
      {hint ? <p className="m-0 text-[11.5px] text-muted">{hint}</p> : null}
    </div>
  );
}
