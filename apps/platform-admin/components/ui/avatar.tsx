import type { ReactNode } from 'react';

/**
 * أفاتار — صورة اختيارية، وإلا أحرف الاسم الأولى على خلفية ملونة مشتقة من النص.
 * `status` يرسم نقطة حالة أسفل الأفاتار.
 */
export type AvatarSize = 'sm' | 'md' | 'lg';

const SIZES: Record<AvatarSize, { box: string; text: string; img: number }> = {
  sm: { box: 'size-8', text: 'text-[11px]', img: 32 },
  md: { box: 'size-10', text: 'text-[13px]', img: 40 },
  lg: { box: 'size-14', text: 'text-[17px]', img: 56 },
};

const PALETTE = [
  'bg-info-soft text-info-ink',
  'bg-brand-soft text-brand',
  'bg-ok-soft text-ok-ink',
  'bg-warn-soft text-warn-ink',
  'bg-danger-soft text-danger-ink',
  'bg-info-soft text-info-ink',
];

function hashPalette(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? PALETTE[0]!;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return '؟';
  const second = parts[1];
  if (!second) return first.slice(0, 2);
  return `${first[0] ?? ''}${second[0] ?? ''}`;
}

export type AvatarProps = {
  name: string;
  src?: string;
  size?: AvatarSize;
  status?: 'online' | 'away' | 'offline' | null;
  /** ReactNode shown instead of initials (e.g. a company logo). */
  children?: ReactNode;
  className?: string;
};

const STATUS_COLORS = { online: 'bg-ok', away: 'bg-warn', offline: 'bg-line-raised' } as const;

export function Avatar({ name, src, size = 'md', status = null, children, className = '' }: AvatarProps) {
  const s = SIZES[size];
  return (
    <span className={`relative inline-flex flex-none ${s.box} ${className}`} title={name}>
      {src ? (
        <img src={src} alt={name} className={`${s.box} rounded-full object-cover`} />
      ) : (
        <span className={`grid place-items-center ${s.box} rounded-full font-bold ${s.text} ${hashPalette(name)} select-none`}>
          {children ?? initialsOf(name)}
        </span>
      )}
      {status ? (
        <span
          className={`absolute bottom-0 end-0 size-3 rounded-full border-2 border-on-accent ${STATUS_COLORS[status]}`}
          aria-label={status}
        />
      ) : null}
    </span>
  );
}
