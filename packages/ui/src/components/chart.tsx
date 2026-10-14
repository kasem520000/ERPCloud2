'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Chart wrappers — recharts, with every colour read from the tokens.
 *
 * Design v3 §2.2.4 is the rule that shaped this file: a recharts default
 * palette is a set of hardcoded hex values in generated SVG, which is exactly
 * what turns a dark dashboard into a grey smear. So:
 *   • the axis, grid and tooltip colours are `var(--…)` — they flip;
 *   • a *series* colour is a fixed `--color-chart-n`, because a category is a
 *     category in both themes;
 *   • the tooltip surface is `--raised` + `--line`, not recharts' white box.
 *
 * All of it is wrapped in `<ResponsiveContainer>`, so a chart inside a grid
 * cell resizes without a manual width and without a layout shift (marketing's
 * CLS budget, §4).
 */

export type ChartDatum = { name: string; value: number; color?: string };

const AXIS_STYLE = {
  stroke: 'var(--muted)',
  fontSize: 11,
  fontFamily: 'var(--font-num)',
} as const;

/** recharts renders SVG text with `fill`, not `color`. */
const TICK = { fill: 'var(--muted)', fontSize: 11, fontFamily: 'var(--font-num)' } as const;

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ name?: string | number; value?: unknown; color?: string; payload?: unknown }>;
  label?: string | number;
  formatter?: (value: number, name: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-[11.5px] shadow-3">
      {label !== undefined ? <p className="m-0 font-bold text-ink">{label}</p> : null}
      {payload.map((entry, index) => {
        const numeric = typeof entry.value === 'number' ? entry.value : Number(entry.value ?? 0);
        const name = String(entry.name ?? '');
        return (
          <p key={index} className="num m-0 flex items-center gap-1.5 text-ink-2">
            <span
              className="inline-block size-2 flex-none rounded-full"
              style={{ background: entry.color ?? 'var(--brand)' }}
              aria-hidden
            />
            {formatter ? formatter(numeric, name) : `${name}: ${numeric}`}
          </p>
        );
      })}
    </div>
  );
}

export type SeriesChartProps = {
  data: Array<Record<string, string | number>>;
  /** One entry per series: the key in `data` and its label. */
  series: Array<{ key: string; label: string; color?: string }>;
  xKey: string;
  height?: number;
  className?: string;
  /** Format the tooltip value — money, counts. */
  format?: (value: number) => string;
  /** Show the horizontal grid lines. */
  grid?: boolean;
};

const SERIES_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
];

/** Bar chart — a week of sales, a month of invoices. */
export function BarSeries({
  data,
  series,
  xKey,
  height = 220,
  className = '',
  format,
  grid = true,
}: SeriesChartProps) {
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
          {grid ? <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} /> : null}
          <XAxis dataKey={xKey} tickLine={false} axisLine={{ stroke: 'var(--line)' }} tick={TICK} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={TICK}
            width={44}
            tickFormatter={(value: number) => (format ? format(value) : String(value))}
          />
          <RechartsTooltip
            cursor={{ fill: 'var(--surface-3)' }}
            content={<ChartTooltip formatter={format ? (value) => format(value) : undefined} />}
          />
          {series.map((entry, index) => (
            <Bar
              key={entry.key}
              dataKey={entry.key}
              name={entry.label}
              fill={entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length]}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Line chart — a trend over time. */
export function LineSeries({
  data,
  series,
  xKey,
  height = 220,
  className = '',
  format,
  grid = true,
}: SeriesChartProps) {
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
          {grid ? <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} /> : null}
          <XAxis dataKey={xKey} tickLine={false} axisLine={{ stroke: 'var(--line)' }} tick={TICK} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={TICK}
            width={44}
            tickFormatter={(value: number) => (format ? format(value) : String(value))}
          />
          <RechartsTooltip content={<ChartTooltip formatter={format ? (value) => format(value) : undefined} />} />
          {series.map((entry, index) => (
            <Line
              key={entry.key}
              type="monotone"
              dataKey={entry.key}
              name={entry.label}
              stroke={entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export type DonutProps = {
  data: ChartDatum[];
  height?: number;
  className?: string;
  /** Centre label — «قنوات البيع». */
  centerLabel?: string;
  centerValue?: string;
  format?: (value: number) => string;
};

/** Donut — a share split: فاتورة vs POS, tenants by plan. */
export function Donut({
  data,
  height = 220,
  className = '',
  centerLabel,
  centerValue,
  format,
}: DonutProps) {
  const sum = data.reduce((accumulator, entry) => accumulator + entry.value, 0);
  return (
    <div className={cn('relative w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <RechartsTooltip content={<ChartTooltip formatter={format ? (value) => format(value) : undefined} />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={2}
            stroke="var(--surface)"
            strokeWidth={2}
          >
            {data.map((entry, index) => (
              <Cell key={entry.name} fill={entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      {centerLabel || centerValue ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            {centerValue ? (
              <p className="num m-0 text-[20px] leading-none font-bold text-ink">{centerValue}</p>
            ) : null}
            {centerLabel ? <p className="m-0 mt-1 text-[11.5px] text-muted">{centerLabel}</p> : null}
          </div>
        </div>
      ) : null}
      {sum === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="rounded-md bg-surface-2 px-2 py-1 text-[11.5px] text-muted">لا بيانات</span>
        </div>
      ) : null}
    </div>
  );
}

export type ChartLegendItem = { name: string; value?: string; color?: string };

/** A token-coloured legend — no recharts default swatch anywhere. */
export function ChartLegend({ items }: { items: ChartLegendItem[] }): ReactNode {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0">
      {items.map((item, index) => (
        <li key={item.name} className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <span
            className="inline-block size-2.5 flex-none rounded-full"
            style={{ background: item.color ?? SERIES_COLORS[index % SERIES_COLORS.length] }}
            aria-hidden
          />
          <span>{item.name}</span>
          {item.value ? <span className="num font-bold text-ink">{item.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export { AXIS_STYLE };
