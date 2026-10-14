'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReactNode } from 'react';

/**
 * مغلّفات recharts الموحّدة — تدرّج لوني، tooltip أبيض أنيق، و رسم ذاتي على 800ms.
 * كل مكوّن يقبل `data` و `dataKey` و `xKey`، مع ألوان قابلة للتخصيص.
 */
const GRID = 'var(--line)';
const AXIS_TICK = { fill: 'var(--muted)', fontSize: 11 } as const;
const DRAW_MS = 0.8;

export type Series = { color: string; name?: string };

function WhiteTooltip({ active, payload, label, formatter }: TooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-surface backdrop-blur px-3 py-2 shadow-4 min-w-32">
      {label !== undefined && label !== '' ? (
        <p className="m-0 text-[11px] font-bold text-muted mb-1">{label}</p>
      ) : null}
      {payload.map((entry, i) => (
        <p key={i} className="m-0 flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          <span className="size-2.5 rounded-full" style={{ background: entry.color }} />
          <span className="text-muted font-medium">{entry.name}:</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatter ? formatter(Number(entry.value)) : Number(entry.value).toLocaleString('en-US')}
          </span>
        </p>
      ))}
    </div>
  );
}
type TooltipProps = {
  active?: boolean;
  payload?: Array<{ value?: number | string; name?: string; color?: string }>;
  label?: ReactNode;
  formatter?: (value: number) => string;
};

/** Y-axis that formats big numbers compactly (1.2K, 3.4M). */
function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

type BaseChartProps = {
  data: Array<Record<string, unknown>>;
  xKey: string;
  dataKey: string;
  color?: string;
  height?: number;
  formatter?: (value: number) => string;
  name?: string;
};

export function AreaCardChart({
  data,
  xKey,
  dataKey,
  color = 'var(--color-chart-2)',
  height = 260,
  formatter,
  name,
}: BaseChartProps) {
  const id = `grad-${dataKey.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="4 4" vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => compact(Number(v))} />
        <Tooltip
          content={<WhiteTooltip formatter={formatter} />}
          cursor={{ stroke: color, strokeOpacity: 0.2, strokeWidth: 1.5, strokeDasharray: '4 4' }}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          name={name ?? dataKey}
          stroke={color}
          strokeWidth={2.5}
          fill={`url(#${id})`}
          animationDuration={DRAW_MS * 1000}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function BarCardChart({
  data,
  xKey,
  dataKey,
  color = 'var(--color-chart-2)',
  height = 260,
  formatter,
  name,
}: BaseChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="4 4" vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => compact(Number(v))} />
        <Tooltip content={<WhiteTooltip formatter={formatter} />} cursor={{ fill: 'rgb(124 58 237 / 0.06)' }} />
        <Bar dataKey={dataKey} name={name ?? dataKey} fill={color} radius={[6, 6, 0, 0]} maxBarSize={38} animationDuration={DRAW_MS * 1000} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LineCardChart({
  data,
  xKey,
  dataKey,
  color = 'var(--color-chart-2)',
  height = 260,
  formatter,
  name,
}: BaseChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="4 4" vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => compact(Number(v))} />
        <Tooltip content={<WhiteTooltip formatter={formatter} />} cursor={{ stroke: color, strokeOpacity: 0.25, strokeDasharray: '4 4' }} />
        <Line
          type="monotone"
          dataKey={dataKey}
          name={name ?? dataKey}
          stroke={color}
          strokeWidth={2.5}
          dot={{ r: 3, fill: color, strokeWidth: 0 }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }}
          animationDuration={DRAW_MS * 1000}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export type DonutSlice = { name: string; value: number; color?: string };

const DONUT_PALETTE = [
  'var(--color-chart-2)',
  'var(--color-violet-400)',
  'var(--color-chart-6)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--muted)',
];

export function DonutCardChart({
  data,
  height = 240,
  formatter,
  centerLabel,
  centerValue,
}: {
  data: DonutSlice[];
  height?: number;
  formatter?: (value: number) => string;
  centerLabel?: string;
  centerValue?: string;
}) {
  const slices = data.map((slice, i) => ({ ...slice, color: slice.color ?? DONUT_PALETTE[i % DONUT_PALETTE.length] }));
  const grandTotal = slices.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Tooltip content={<WhiteTooltip formatter={formatter} />} />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={2}
            stroke="none"
            animationDuration={DRAW_MS * 1000}
          >
            {slices.map((slice, i) => (
              <Cell key={i} fill={slice.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      {(centerLabel || centerValue) && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="text-center">
            {centerValue ? <p className="m-0 text-[26px] font-bold text-ink leading-tight" style={{ fontVariantNumeric: 'tabular-nums' }}>{centerValue}</p> : null}
            {centerLabel ? <p className="m-0 text-[11px] font-semibold text-muted mt-0.5">{centerLabel}</p> : null}
          </div>
        </div>
      )}
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-2 px-2 list-none m-0">
        {slices.map((slice, i) => (
          <li key={i} className="flex items-center gap-2 text-[12px] text-ink-2 min-w-0">
            <span className="size-2.5 rounded-full flex-none" style={{ background: slice.color }} />
            <span className="truncate">{slice.name}</span>
            <span className="ms-auto font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {grandTotal > 0 ? Math.round((slice.value / grandTotal) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
