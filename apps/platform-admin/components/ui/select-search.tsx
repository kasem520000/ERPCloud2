'use client';

import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Avatar } from './avatar';

/**
 * اختيار قابل للبحث (combobox) — حقل نصي يتحول لقائمة منسدلة، مع تضييق النتائج
 * بالبحث وأفاتار اختياري بجانب كل عنصر. Esc/Tab يغلقان، والنقر خارجاً يغلق.
 */
export type Option = {
  value: string;
  label: string;
  sublabel?: string;
  avatarName?: string;
  avatarSrc?: string;
};

export function SelectSearch({
  options,
  value,
  onChange,
  placeholder = 'ابحث…',
  emptyText = 'لا نتائج',
  clearable = false,
  onClear,
  className = '',
}: {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  clearable?: boolean;
  onClear?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((option) => option.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) => option.label.toLowerCase().includes(q) || (option.sublabel ?? '').toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function commit(index: number) {
    const option = filtered[index];
    if (option) onChange(option.value);
    setOpen(false);
  }

  function onKey(event: React.KeyboardEvent) {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') setOpen(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(active);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full h-10 ps-3 pe-2.5 rounded-[10px] border border-line-strong bg-surface text-[13.5px] text-ink-2 hover:border-line-strong transition-colors duration-150"
        aria-expanded={open}
      >
        {selected?.avatarName ? <Avatar name={selected.avatarName} src={selected.avatarSrc} size="sm" /> : null}
        <span className={`flex-1 text-start truncate ${selected ? 'font-semibold' : 'text-muted'}`}>
          {selected ? selected.label : placeholder}
        </span>
        {clearable && selected ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              onClear?.();
            }}
            className="text-muted hover:text-muted"
            aria-label="مسح"
          >
            ✕
          </span>
        ) : null}
        <ChevronDown size={15} className={`text-muted transition-transform duration-150 flex-none ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="absolute z-40 top-full inset-x-0 mt-1.5 rounded-xl border border-line bg-surface shadow-4 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <Search size={14} className="text-muted flex-none" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              placeholder="اكتب للبحث…"
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1 m-0 list-none">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-[12.5px] text-muted">{emptyText}</li>
            ) : (
              filtered.map((option, index) => (
                <li key={option.value}>
                  <button
                    type="button"
                    onClick={() => commit(index)}
                    onMouseEnter={() => setActive(index)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-start transition-colors duration-100 ${
                      index === active ? 'bg-info-soft' : ''
                    }`}
                  >
                    {option.avatarName ? (
                      <Avatar name={option.avatarName} src={option.avatarSrc} size="sm" />
                    ) : null}
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-semibold text-ink truncate">{option.label}</span>
                      {option.sublabel ? (
                        <span className="block text-[11px] text-muted truncate">{option.sublabel}</span>
                      ) : null}
                    </span>
                    {option.value === value ? <Check size={15} className="text-brand-600 flex-none" /> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
