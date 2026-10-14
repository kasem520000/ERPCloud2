'use client';

/**
 * Shared console widgets.
 *
 * `Tabs` is carried over **verbatim** from the staff surface
 * (`apps/staff/components/ui.tsx` L97–119, styling at `apps/staff/app/globals.css` L820–841):
 * the two products are one design language and one RTL layout, so a second implementation
 * would only be a second set of differences. The console had no tabbed screen before P-C2;
 * the customer card is the first, and it needs exactly this control.
 */

export function Tabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: Array<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="tabs">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`tab${item.id === value ? ' active' : ''}`}
          onClick={() => onChange(item.id)}
          aria-current={item.id === value}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A metered value as a bar. `ratio` is capped at 1 for the drawing and rounded for the
 * label, so «١ من ١» reads as full even when the counter is 1.4 of a fractional limit.
 */
export function MeterBar({ ratio, tone = 'ok' }: { ratio: number; tone?: 'ok' | 'warn' | 'danger' }) {
  const width = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="meter" role="presentation">
      <span className={`meter-fill ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * «من أين جاءت هذه القيمة؟» — one tag for both endpoints, because they share one
 * vocabulary (`default | platform | tenant`): the usage limits and the settings tab must not
 * answer that question in two languages.
 */
export function SourceTag({ source }: { source: 'default' | 'platform' | 'tenant' }) {
  const label =
    source === 'tenant' ? 'تجاوزٌ خاص بالعميل' : source === 'platform' ? 'من إعدادات المنصّة' : 'القيمة الافتراضية';
  return <span className={`tag ${source}`}>{label}</span>;
}
