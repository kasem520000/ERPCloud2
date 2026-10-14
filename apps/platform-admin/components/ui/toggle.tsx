'use client';

import { motion } from 'framer-motion';

/**
 * مفتاح تبديل — switch بمظهر احترافي (Stripe/Linear) مع حركة انزلاق 150ms.
 * يدعم الحالة المعلّقة (disabled) والقيمة المربوطة (checked/onChange).
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  const switchEl = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${
        checked ? 'bg-brand-600' : 'bg-line-raised'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className="inline-block size-5 rounded-full bg-surface shadow-2"
        style={{ marginInlineStart: checked ? 'auto' : 2, marginInlineEnd: checked ? 2 : 'auto' }}
      />
    </button>
  );

  if (!label) return switchEl;

  return (
    <label className={`flex items-center justify-between gap-4 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-bold text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-[12px] text-muted leading-snug">{hint}</span> : null}
      </span>
      {switchEl}
    </label>
  );
}
